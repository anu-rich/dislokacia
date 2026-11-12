/*
 * One call to Claude: page images in, the answer in the shape of SCHEMA out.
 */
import Anthropic from '@anthropic-ai/sdk';
import X from '../shared/schema.cjs';
import { SYSTEM_PROMPT, userContent } from './prompt.js';

export const DEFAULT_MODEL = 'claude-sonnet-5-5';      // readings with a Pro licence
export const DEFAULT_FREE_MODEL = 'claude-haiku-5-5';  // free readings: about twenty times cheaper
export const DEFAULT_EFFORT = 'high';
/** Claude Haiku has no server-side fallback, and its documentation says to leave the parameter out. */
const hasFallback = (model) => !/^claude-haiku/.test(model);
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** A failed reading. `code` says what kind; `billed` whether the model did work that is paid for. */
export class ReadError extends Error {
  constructor(code, detail, billed) {
    super(code + (detail ? ': ' + detail : ''));
    this.code = code;
    this.billed = !!billed;
  }
}

/**
 * @param {{client: Anthropic, model?: string, effort?: string, pages: Array<{doc:string,type:string,data:string}>, lang: string, signal?: AbortSignal}} o
 * @returns {Promise<{extraction: object, model: string, usage: {input: number, output: number}}>}
 */
export async function readDocuments({ client, model, effort, pages, lang, signal }) {
  let message;
  try {
    const params = {
      model: model || DEFAULT_MODEL,
      max_tokens: 64000,
      output_config: {
        effort: EFFORTS.includes(effort) ? effort : DEFAULT_EFFORT,
        format: { type: 'json_schema', schema: X.SCHEMA },
      },
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent(pages, lang) }],
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
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) throw new ReadError('config', 'the API key was not accepted');
    if (e instanceof Anthropic.NotFoundError) throw new ReadError('config', 'the model is not available to this API key');
    if (e instanceof Anthropic.ContentTooLargeError) throw new ReadError('too_big');
    if (e instanceof Anthropic.BadRequestError) throw new ReadError('bad_request', e.message);
    if (e instanceof Anthropic.RateLimitError) throw new ReadError('busy');
    if (e instanceof Anthropic.APIError) throw new ReadError('upstream', String(e.status || e.name));
    throw new ReadError('upstream', e && e.name);
  }

  const usage = { input: (message.usage && message.usage.input_tokens) || 0, output: (message.usage && message.usage.output_tokens) || 0 };
  if (message.stop_reason === 'refusal') throw new ReadError('refused', message.stop_details && message.stop_details.category, true);
  if (message.stop_reason === 'max_tokens') throw new ReadError('too_long', '', true);

  const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  let answer;
  try { answer = JSON.parse(text); } catch (e) { throw new ReadError('unreadable', 'the answer is not JSON', true); }
  const problem = X.shapeError(answer, X.SCHEMA);
  if (problem) throw new ReadError('unreadable', problem, true);
  return { extraction: answer, model: message.model, usage };
}
