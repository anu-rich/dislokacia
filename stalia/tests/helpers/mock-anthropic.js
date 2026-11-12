/*
 * Test helper: a stand-in for the Anthropic Messages API (streaming). It records what it was sent and
 * plays back whatever the test scripted, so the reading server can be exercised without an API key.
 */
'use strict';
const http = require('node:http');

/**
 * @param {(req: {headers: object, body: object, n: number}) => ({text?: string, stop?: string, status?: number, error?: string, model?: string})} script
 */
async function startMockAnthropic(script) {
  const requests = [];
  const server = http.createServer((req, res) => {
    // a browser asks first whether it may call from another origin; the real API says yes to everybody
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Expose-Headers': '*' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { /* left as null */ }
      const rec = { method: req.method, url: req.url, headers: req.headers, body, n: requests.length + 1 };
      requests.push(rec);
      const plan = script(rec) || {};
      if (plan.status && plan.status !== 200) {
        res.writeHead(plan.status, Object.assign({ 'Content-Type': 'application/json' }, cors));
        res.end(JSON.stringify({ type: 'error', error: { type: plan.error || 'api_error', message: 'scripted failure' } }));
        return;
      }
      const model = plan.model || (body && body.model) || 'claude-opus-5-5';
      const send = (event, data) => res.write('event: ' + event + '\ndata: ' + JSON.stringify(Object.assign({ type: event }, data)) + '\n\n');
      res.writeHead(200, Object.assign({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }, cors));
      send('message_start', {
        message: { id: 'msg_test', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 4321, output_tokens: 1 } },
      });
      const text = plan.text == null ? '' : String(plan.text);
      if (text) {
        send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
        for (let i = 0; i < text.length; i += 700) send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: text.slice(i, i + 700) } });
        send('content_block_stop', { index: 0 });
      }
      send('message_delta', { delta: { stop_reason: plan.stop || 'end_turn', stop_sequence: null }, usage: { output_tokens: 987 } });
      send('message_stop', {});
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: 'http://127.0.0.1:' + server.address().port,
    requests,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
}

/** A string the server accepts as a JPEG page: the right first bytes, a plausible length. */
const fakeJpeg = (seed) => '/9j/' + String(seed == null ? 'A' : seed).padEnd(4, 'A').slice(0, 4).repeat(100);

module.exports = { startMockAnthropic, fakeJpeg };
