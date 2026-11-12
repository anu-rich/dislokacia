/*
 * One call to Claude: page images in, the answer in the shape of SCHEMA out.
 */
import Anthropic from '@anthropic-ai/sdk';
import X from '../shared/schema.cjs';
import { systemPrompt, userContent } from './prompt.js';

export const DEFAULT_MODEL = 'claude-sonnet-5-5';      // readings with a Pro licence
export const DEFAULT_FREE_MODEL = 'claude-haiku-5-5';  // free readings: about twenty times cheaper
export const DEFAULT_EFFORT = 'high';
/** Claude Haiku has no server-side fallback, and its documentation says to leave the parameter out. */
const hasFallback = (model) => !/^claude-haiku/.test(model);
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** A failed reading. `code` says what kind; `billed` whether the model did work that is paid for; `said` is the API's own explanation, if it gave one. */
export class ReadError extends Error {
  constructor(code, detail, billed, said) {
    super(code + (detail ? ': ' + detail : ''));
    this.code = code;
    this.billed = !!billed;
    this.said = said || '';
  }
}
/** What the API itself wrote about a failure ("invalid x-api-key", "Your credit balance is too low …"). */
const saidBy = (e) => String((e && e.error && e.error.error && e.error.error.message) || '').slice(0, 300);

/**
 * @param {{client: Anthropic, model?: string, effort?: string, pages: Array<{doc:string,type:string,data:string}>, lang: string, terms?: string, signal?: AbortSignal}} o
 *        `terms`: the charter party in words, when only a time sheet is being read for a calculation that already has its terms
 * @returns {Promise<{extraction: object, model: string, usage: {input: number, output: number}}>}
 */
export async function readDocuments({ client, model, effort, pages, lang, terms, signal }) {
  let message;
  try {
    const params = {
      model: model || DEFAULT_MODEL,
      max_tokens: 64000,
      output_config: { effort: EFFORTS.includes(effort) ? effort : DEFAULT_EFFORT },
      system: systemPrompt(),
      messages: [{ role: 'user', content: userContent(pages, lang, terms) }],
    };
    if (hasFallback(params.model)) {
      // If a safety classifier declines the request by mistake, the API retries it on the model Anthropic recommends.
      params.betas = ['server-side-fallback-2026-07-01'];
      params.fallbacks = 'default';
    }
    // Streaming keeps the connection alive while the model reads many pages; only the finished message is used.
    message = await client.beta.messages.stream(params, { signal }).finalMessage();
  } catch (e) {
    if (e instanceof Anthropic.APIUserAbortError) throw new ReadError('aborted');
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) throw new ReadError('config', 'the API key was not accepted', false, saidBy(e));
    if (e instanceof Anthropic.NotFoundError) throw new ReadError('config', 'the model is not available to this API key', false, saidBy(e));
    if (e instanceof Anthropic.ContentTooLargeError) throw new ReadError('too_big');
    if (e instanceof Anthropic.BadRequestError) throw new ReadError('bad_request', e.message, false, saidBy(e));
    if (e instanceof Anthropic.RateLimitError) throw new ReadError('busy', '', false, saidBy(e));
    if (e instanceof Anthropic.APIConnectionError) throw new ReadError('network');
    if (e instanceof Anthropic.APIError) throw new ReadError('upstream', String(e.status || e.name));
    throw new ReadError('upstream', e && e.name);
  }

  const usage = { input: (message.usage && message.usage.input_tokens) || 0, output: (message.usage && message.usage.output_tokens) || 0 };
  if (message.stop_reason === 'refusal') throw new ReadError('refused', message.stop_details && message.stop_details.category, true);
  if (message.stop_reason === 'max_tokens') throw new ReadError('too_long', '', true);

  const answer = parseAnswer(message.content.filter((b) => b.type === 'text').map((b) => b.text).join(''));
  if (!answer) throw new ReadError('unreadable', 'the answer is not a JSON object', true);
  // The schema is not enforced by the API (see prompt.js), so the reply is brought into its exact shape here:
  // a missing field becomes "not stated", an unknown field is dropped, a number becomes text.
  return { extraction: X.conform(answer, X.SCHEMA), model: message.model, usage };
}

/** The JSON object in a reply: the whole reply, the body of a Markdown fence, or the text between the outer braces. */
export function parseAnswer(text) {
  const t = String(text || '').trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(t);
  const tries = [t, fence ? fence[1] : '', t.indexOf('{') >= 0 && t.lastIndexOf('}') > t.indexOf('{') ? t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1) : ''];
  for (const candidate of tries) {
    if (!candidate) continue;
    try {
      const v = JSON.parse(candidate);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    } catch (e) { /* try the next reading */ }
  }
  return null;
}
