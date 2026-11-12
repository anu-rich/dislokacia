/*
 * Reading straight from the user's own device with the user's own Claude API key: no reading server in between.
 * tools/build-reader.js bundles this file, with the SDK, into app/vendor/reader/stalia-reader.js for the browser.
 *
 * The key never leaves the device except to api.anthropic.com. Using the SDK in a browser needs the explicit
 * `dangerouslyAllowBrowser` switch because a key inside a web page is visible to whoever uses that browser:
 * here that is the owner of the key, who typed it in.
 */
import Anthropic from '@anthropic-ai/sdk';
import { readDocuments, DEFAULT_FREE_MODEL, DEFAULT_MODEL, DEFAULT_EFFORT } from './reader.js';

/** The models offered for readings with one's own key: the cheap one first. */
export const MODELS = [DEFAULT_FREE_MODEL, DEFAULT_MODEL];

/** What a failure means for the person, in the words the site already uses for the reading server. */
const MEANS = { too_big: 'too_big', refused: 'refused', unreadable: 'refused', aborted: 'aborted', network: 'network' };

/**
 * @param {{apiKey: string, model?: string, effort?: string, pages: Array<{doc:string,type:string,data:string}>, lang: string, terms?: string, signal?: AbortSignal, baseURL?: string}} o
 * @returns {Promise<{ok: true, extraction: object, model: string, usage: object} | {ok: false, error: string, said?: string}>}  never throws
 */
export async function readDirect({ apiKey, model, effort, pages, lang, terms, signal, baseURL }) {
  try {
    const client = new Anthropic({ apiKey, baseURL: baseURL || 'https://api.anthropic.com', dangerouslyAllowBrowser: true, maxRetries: 1 });
    const out = await readDocuments({ client, model: MODELS.includes(model) ? model : MODELS[0], effort: effort || DEFAULT_EFFORT, pages, lang, terms, signal });
    return { ok: true, extraction: out.extraction, model: out.model, usage: out.usage };
  } catch (e) {
    const code = e && e.code;
    // the key, the account or the request itself was turned down: Anthropic's own words say why
    if (code === 'config' || code === 'bad_request' || code === 'busy') return { ok: false, error: 'key', said: (e && e.said) || '' };
    return { ok: false, error: MEANS[code] || 'server' };
  }
}
