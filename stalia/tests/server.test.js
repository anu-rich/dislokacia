'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const M = require('../app/model.js');
const X = require('../app/extract.js');
const K = require('../tools/keygen.js');
const sync = require('../tools/sync-server.js');
const { extractionOf } = require('./helpers/extraction.js');
const { startMockAnthropic, fakeJpeg } = require('./helpers/mock-anthropic.js');

const ROOT = path.resolve(__dirname, '..');
const kp = K.generateKeyPair();
const proKey = K.issueKey(kp.privatePem, { name: 'ACME Shipping', exp: '2099-01-01' });
const expiredKey = K.issueKey(kp.privatePem, { name: 'ACME Shipping', exp: '2020-01-01' });
const answer = () => extractionOf(M.examples('en')[0].calc);

// The reading server needs its own packages (the Anthropic SDK). Without them these checks are skipped, loudly.
const HAVE_SDK = fs.existsSync(path.join(ROOT, 'server', 'node_modules', '@anthropic-ai', 'sdk'));
if (!HAVE_SDK) console.warn('\n  The reading server is NOT being checked: run "npm install" in server/ first.\n');
const serverTest = (name, fn) => test(name, { skip: HAVE_SDK ? false : 'run "npm install" in server/ first' }, fn);

let mods = null;
async function load() {
  if (!mods) {
    const [handler, limits, reader, prompt, sdk] = await Promise.all([
      import('../server/src/handler.js'), import('../server/src/limits.js'), import('../server/src/reader.js'), import('../server/src/prompt.js'),
      import(path.join(ROOT, 'server', 'node_modules', '@anthropic-ai', 'sdk', 'index.mjs')),
    ]);
    mods = { handler, limits, reader, prompt, Anthropic: sdk.default };
  }
  return mods;
}

/** A reading service wired to a scripted model. */
async function service(script, envExtra, depsExtra) {
  const { handler, limits, Anthropic } = await load();
  const mock = await startMockAnthropic(script || (() => ({ text: JSON.stringify(answer()) })));
  const logs = [];
  const clock = { t: Date.parse('2026-11-12T10:00:00Z') };
  const env = Object.assign({ ANTHROPIC_API_KEY: 'sk-test', STALIA_API_BASE_URL: mock.url, STALIA_PUBLIC_KEYS: JSON.stringify([kp.publicJwk]) }, envExtra || {});
  const handle = handler.createHandler(Object.assign({
    store: new limits.MemoryStore(() => clock.t),
    now: () => clock.t,
    log: (o) => logs.push(o),
    createClient: (cfg) => new Anthropic({ apiKey: cfg.apiKey, baseURL: cfg.baseURL, maxRetries: 0 }),
  }, depsExtra || {}));
  const post = async (body, opts) => {
    opts = opts || {};
    const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    const res = await handle(new Request('https://reader.test/', { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) }), opts.env || env, { ip: opts.ip || '203.0.113.7' });
    return { status: res.status, headers: res.headers, json: await res.json() };
  };
  return { mock, logs, clock, env, handle, post };
}
const twoPages = (extra) => Object.assign({ v: 1, lang: 'ru', license: '', pages: [{ doc: 'sof', type: 'image/jpeg', data: fakeJpeg('SOF1') }, { doc: 'cp', type: 'image/jpeg', data: fakeJpeg('CP01') }] }, extra || {});

test('the copies inside server/ match the site: schema, licence check, public keys', () => {
  for (const [rel, content] of Object.entries(sync.expected())) {
    assert.equal(fs.readFileSync(path.join(ROOT, rel), 'utf8'), content, rel + ' is out of date: run "node tools/sync-server.js"');
  }
});

test('the reader bundled for the browser was built from the current sources', () => {
  const B = require('../tools/build-reader.js');
  assert.equal(B.builtFrom(), B.sourceHash(), 'app/vendor/reader/stalia-reader.js is out of date: run "node tools/build-reader.js"');
  const bundle = fs.readFileSync(path.join(ROOT, 'app', 'vendor', 'reader', 'stalia-reader.js'), 'utf8');
  assert.match(bundle, /Solid black rectangles are deliberate/, 'the instruction is inside');
  assert.ok(bundle.length < 700 * 1024, 'the bundle stays reasonably small');
  assert.ok(fs.existsSync(path.join(ROOT, 'app', 'vendor', 'reader', 'LICENSE-anthropic-sdk.txt')));
});

serverTest('GET tells whether the service is up and configured', async () => {
  const s = await service();
  try {
    const up = await (await s.handle(new Request('https://reader.test/'), s.env)).json();
    assert.deepEqual(up, { ok: true, service: 'stalia-reader', ready: true, limits: { pages: 20, freePerDay: 2, proPerMonth: 200 } });
    const off = await (await s.handle(new Request('https://reader.test/'), {})).json();
    assert.equal(off.ready, false);
    const r = await s.post(twoPages(), { env: {} });
    assert.deepEqual([r.status, r.json.error], [503, 'unavailable']);
    assert.equal(s.mock.requests.length, 0);
  } finally { await s.mock.close(); }
});

serverTest('a reading: pages go to the model as the documentation prescribes, the answer comes back', async () => {
  const s = await service();
  try {
    const r = await s.post(twoPages());
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.deepEqual(r.json.extraction, answer());
    assert.deepEqual(r.json.quota, { plan: 'free', left: 1, perDay: 2 });
    assert.equal(X.toCalc(r.json.extraction).calc.ports.length, 2);

    assert.equal(s.mock.requests.length, 1);
    const q = s.mock.requests[0], b = q.body;
    assert.equal(q.method, 'POST');
    assert.match(q.url, /^\/v1\/messages/);
    assert.ok(q.headers['x-api-key'] === 'sk-test' || q.headers.authorization === 'Bearer sk-test', 'the API key is sent');
    // a free reading runs on Haiku, which has no server-side fallback: the parameter and its beta flag are left out
    assert.equal(b.model, 'claude-haiku-5-5');
    assert.equal('fallbacks' in b, false);
    assert.doesNotMatch(String(q.headers['anthropic-beta'] || ''), /server-side-fallback/);
    assert.equal(b.stream, true);
    assert.equal(b.max_tokens, 64000);
    // The schema travels inside the instruction; the API is not asked to enforce it (it refuses this schema as too large).
    assert.deepEqual(b.output_config, { effort: 'high' });
    assert.ok(b.system.endsWith(JSON.stringify(X.SCHEMA)), 'the instruction ends with the schema');
    assert.match(b.system, /Reply with one JSON object and nothing else/);
    assert.equal('thinking' in b, false, 'thinking is left to the model’s default');
    assert.equal('temperature' in b, false);
    assert.equal('tool_choice' in b, false);
    assert.equal('betas' in b, false, 'beta flags travel in the header, not in the body');
    assert.match(b.system, /Solid black rectangles are deliberate/);
    assert.match(b.system, /filled in by hand/);
    // charter party first, each image introduced by its slot and page number
    const c = b.messages[0].content;
    assert.equal(b.messages.length, 1);
    assert.deepEqual(c.map((x) => x.type), ['text', 'image', 'text', 'image', 'text']);
    assert.equal(c[0].text, 'Charter party / recap — page 1 of 1:');
    assert.deepEqual(c[1].source, { type: 'base64', media_type: 'image/jpeg', data: fakeJpeg('CP01') });
    assert.equal(c[2].text, 'Statement of facts / time sheet — page 1 of 1:');
    assert.equal(c[3].source.data, fakeJpeg('SOF1'));
    assert.match(c[4].text, /Read the 2 pages above/);
    assert.match(c[4].text, /in Russian\.$/);
    // the log has sizes and timings, never the content
    assert.equal(s.logs.length, 1);
    assert.deepEqual(Object.keys(s.logs[0]).sort(), ['in', 'kb', 'model', 'ms', 'ok', 'out', 'pages', 'plan', 't']);
    assert.deepEqual([s.logs[0].ok, s.logs[0].pages, s.logs[0].in, s.logs[0].out], [true, 2, 4321, 987]);
    assert.doesNotMatch(JSON.stringify(s.logs), /9j|203\.0\.113/);
  } finally { await s.mock.close(); }
});

serverTest('a reading with a Pro licence runs on Sonnet, with the fallback for mistaken refusals', async () => {
  const s = await service();
  try {
    const r = await s.post(twoPages({ license: proKey }));
    assert.equal(r.status, 200);
    const q = s.mock.requests[0], b = q.body;
    assert.equal(b.model, 'claude-sonnet-5-5');
    assert.equal(b.fallbacks, 'default');
    assert.match(String(q.headers['anthropic-beta']), /server-side-fallback-2026-07-01/);
    assert.equal(b.output_config.effort, 'high');
    assert.equal(s.logs[0].plan, 'pro');
  } finally { await s.mock.close(); }
});

serverTest('one document only is said so; models and effort can be changed in the settings', async () => {
  const s = await service(null, { STALIA_MODEL: 'claude-opus-5-5', STALIA_MODEL_FREE: 'claude-sonnet-5-5', STALIA_EFFORT: 'medium' });
  try {
    const r = await s.post({ lang: 'xx', pages: [{ doc: 'sof', type: 'image/png', data: 'iVBOR' + 'A'.repeat(395) }] });
    assert.equal(r.status, 200);
    const b = s.mock.requests[0].body, c = b.messages[0].content;
    assert.equal(b.model, 'claude-sonnet-5-5', 'the free model');
    assert.equal(b.fallbacks, 'default');
    assert.equal(b.output_config.effort, 'medium');
    await s.post(twoPages({ license: proKey }));
    assert.equal(s.mock.requests[1].body.model, 'claude-opus-5-5', 'the Pro model');
    assert.equal(c[1].source.media_type, 'image/png');
    assert.match(c[2].text, /Read the 1 page above and fill in the answer\. No charter party pages were supplied\. Write the note comments in English\.$/);
  } finally { await s.mock.close(); }
});

serverTest('malformed requests are turned away before anything is spent', async () => {
  const s = await service(null, { MAX_PAGES: '3' });
  try {
    const page = { doc: 'cp', type: 'image/jpeg', data: fakeJpeg() };
    const cases = [
      ['not json', 400, 'bad_request'],
      [{}, 400, 'bad_request'],
      [{ pages: [] }, 400, 'bad_request'],
      [{ pages: [page, page, page, page] }, 400, 'too_many'],
      [{ pages: [Object.assign({}, page, { doc: 'other' })] }, 400, 'bad_request'],
      [{ pages: [Object.assign({}, page, { type: 'application/pdf' })] }, 400, 'bad_request'],
      [{ pages: [Object.assign({}, page, { type: 'image/png' })] }, 400, 'bad_request'], // says PNG, is not
      [{ pages: [Object.assign({}, page, { data: '/9j/short' })] }, 400, 'bad_request'],
      [{ pages: [Object.assign({}, page, { data: fakeJpeg() + 'A' })] }, 400, 'bad_request'],
      [{ pages: [Object.assign({}, page, { data: '/9j/' + 'A'.repeat(6 * 1024 * 1024) })] }, 413, 'too_big'],
    ];
    for (const [body, status, error] of cases) {
      const r = await s.post(body);
      assert.deepEqual([r.status, r.json.error], [status, error], JSON.stringify(body).slice(0, 80));
    }
    assert.equal((await s.post({ pages: [page, page, page, page] })).json.limit, 3);
    const put = await s.handle(new Request('https://reader.test/', { method: 'PUT', body: '{}' }), s.env);
    assert.equal(put.status, 405);
    const big = await s.post(twoPages(), { env: Object.assign({}, s.env, { MAX_BODY_MB: '1' }), headers: { 'Content-Length': String(5 * 1024 * 1024) } });
    assert.deepEqual([big.status, big.json.error], [413, 'too_big']);
    assert.equal(s.mock.requests.length, 0);
    assert.equal(s.logs.length, 0);
  } finally { await s.mock.close(); }
});

serverTest('limits: free readings per address and day, Pro readings per licence and month — and no others', async () => {
  // settings that no longer exist (a daily Pro limit, a cap for everybody) are ignored
  const s = await service(null, { FREE_PER_DAY: '2', PRO_PER_MONTH: '4', PRO_PER_DAY: '1', GLOBAL_PER_DAY: '3' });
  try {
    assert.equal((await s.post(twoPages())).json.quota.left, 1);
    assert.equal((await s.post(twoPages())).json.quota.left, 0);
    const third = await s.post(twoPages());
    assert.deepEqual([third.status, third.json.error, third.json.quota], [429, 'pro', { plan: 'free', left: 0, perDay: 2 }]);
    assert.equal((await s.post(twoPages(), { ip: '198.51.100.9' })).status, 200, 'another address has its own allowance');
    // an expired licence counts as free; a valid one has the Pro allowance, whatever the address
    assert.equal((await s.post(twoPages({ license: expiredKey }))).json.error, 'pro');
    assert.equal((await s.post(twoPages({ license: 'STL1.bogus.bogus' }))).json.error, 'pro');
    const p1 = await s.post(twoPages({ license: proKey }));
    assert.deepEqual([p1.status, p1.json.quota], [200, { plan: 'pro', left: 3, perMonth: 4 }]);
    assert.equal((await s.post(twoPages({ license: proKey }), { ip: '192.0.2.1' })).json.quota.left, 2);
    // nothing caps all visitors together: twenty more addresses read, each within its own two a day
    for (let i = 1; i <= 20; i++) assert.equal((await s.post(twoPages(), { ip: '203.0.113.' + (100 + i) })).status, 200, 'address ' + i);
    assert.equal(s.mock.requests.length, 25);
    // a new day: free readings start again, the Pro month goes on
    s.clock.t += 24 * 3600 * 1000;
    assert.equal((await s.post(twoPages())).json.quota.left, 1);
    assert.equal((await s.post(twoPages({ license: proKey }))).json.quota.left, 1);
    // free readings can be switched off altogether
    const none = await s.post(twoPages(), { env: Object.assign({}, s.env, { FREE_PER_DAY: '0' }), ip: '192.0.2.77' });
    assert.deepEqual([none.status, none.json.error], [429, 'pro']);
  } finally { await s.mock.close(); }
});

serverTest('a Pro licence: no daily limit, one allowance for the calendar month', async () => {
  const s = await service(null, { PRO_PER_MONTH: '5' });
  try {
    const go = () => s.post(twoPages({ license: proKey })).then((r) => [r.status, r.json.error || 'ok', r.json.quota.left]);
    // the whole month can be used in one day
    assert.deepEqual([await go(), await go(), await go(), await go(), await go()], [[200, 'ok', 4], [200, 'ok', 3], [200, 'ok', 2], [200, 'ok', 1], [200, 'ok', 0]]);
    const over = await s.post(twoPages({ license: proKey }));
    assert.deepEqual([over.status, over.json.error, over.json.quota], [429, 'limit', { plan: 'pro', left: 0, perMonth: 5 }]);
    s.clock.t += 24 * 3600 * 1000;
    assert.deepEqual(await go(), [429, 'limit', 0], 'the next day of the same month is still over');
    assert.equal((await s.post(twoPages(), { ip: '198.51.100.20' })).status, 200, 'free readings are not affected');
    s.clock.t = Date.parse('2026-12-01T00:10:00Z');
    assert.deepEqual(await go(), [200, 'ok', 4], 'a new month starts again');
    assert.equal(s.mock.requests.length, 7);
    // the default is 200 a month
    const d = await service();
    try { assert.equal((await d.post(twoPages({ license: proKey }))).json.quota.perMonth, 200); } finally { await d.mock.close(); }
  } finally { await s.mock.close(); }
});

serverTest('parallel requests cannot overrun a limit', async () => {
  const s = await service(null, { FREE_PER_DAY: '2' });
  try {
    const all = await Promise.all([1, 2, 3, 4, 5].map(() => s.post(twoPages())));
    assert.deepEqual(all.map((r) => r.status).sort(), [200, 200, 429, 429, 429]);
    assert.equal(s.mock.requests.length, 2);
  } finally { await s.mock.close(); }
});

serverTest('when the model fails: nothing read is given back, a refusal or a broken answer is not', async () => {
  const plans = [
    { status: 401, error: 'authentication_error' }, { status: 429, error: 'rate_limit_error' }, { status: 529, error: 'overloaded_error' },
    { status: 400, error: 'invalid_request_error' }, { status: 413, error: 'request_too_large' },
    { text: '', stop: 'refusal' }, { text: '{"documents":', stop: 'max_tokens' }, { text: 'Sorry, I cannot.' }, { text: '[1, 2, 3]' },
  ];
  const s = await service((req) => plans[req.n - 1], { FREE_PER_DAY: '50' });
  try {
    const got = [];
    for (let i = 0; i < plans.length; i++) { const r = await s.post(twoPages()); got.push([r.status, r.json.error, r.json.quota.left]); }
    assert.deepEqual(got, [
      [503, 'unavailable', 50], [503, 'server', 50], [502, 'server', 50], [400, 'bad_request', 50], [413, 'too_big', 50],
      [422, 'refused', 49], [502, 'server', 48], [422, 'refused', 47], [422, 'refused', 46],
    ]);
    assert.deepEqual(s.logs.map((l) => l.error), ['config', 'busy', 'upstream', 'bad_request', 'too_big', 'refused', 'too_long', 'unreadable', 'unreadable']);
    assert.equal((await s.post(twoPages())).json.error, 'refused', 'an empty answer is a failed reading too');
  } finally { await s.mock.close(); }
});

serverTest('a reply that is nearly right is accepted: fenced, with a sentence around it, or a little out of shape', async () => {
  const good = answer();
  const rough = JSON.parse(JSON.stringify(good));
  delete rough.money.despatch_basis; rough.money.demurrage_per_day = 14500; rough.surplus = 'x'; rough.ports[0].operation = 'loading';
  const replies = ['```json\n' + JSON.stringify(good) + '\n```', 'Here is the answer:\n' + JSON.stringify(good, null, 2) + '\nLet me know if anything is unclear.', JSON.stringify(rough), '{}'];
  const s = await service((req) => ({ text: replies[req.n - 1] }), { FREE_PER_DAY: '9' });
  try {
    for (let i = 0; i < 2; i++) {
      const r = await s.post(twoPages());
      assert.equal(r.status, 200);
      assert.deepEqual(r.json.extraction, good, 'reply ' + (i + 1));
    }
    const fixed = (await s.post(twoPages())).json.extraction;
    assert.equal(X.shapeError(fixed, X.SCHEMA), '');
    assert.deepEqual([fixed.money.despatch_basis, fixed.money.demurrage_per_day, 'surplus' in fixed, fixed.ports[0].operation], ['unknown', '14500', false, 'load']);
    const empty = await s.post(twoPages());
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.json.extraction, X.blankExtraction(), 'an empty object becomes an empty answer, which the site reports as “nothing found”');
    assert.equal(X.toCalc(empty.json.extraction).empty, true);
  } finally { await s.mock.close(); }
});

serverTest('other sites cannot use the service from a browser; the site and the mobile apps can', async () => {
  const s = await service(null, { ALLOWED_ORIGINS: 'https://stalia.example/, https://www.stalia.example' });
  try {
    const from = (origin) => s.post(twoPages(), { headers: { Origin: origin }, ip: origin });
    const own = await from('https://stalia.example');
    assert.equal(own.status, 200);
    assert.equal(own.headers.get('access-control-allow-origin'), 'https://stalia.example');
    for (const app of ['https://localhost', 'capacitor://localhost']) {
      const r = await from(app);
      assert.deepEqual([r.status, r.headers.get('access-control-allow-origin')], [200, app]);
    }
    const stranger = await from('https://evil.example');
    assert.deepEqual([stranger.status, stranger.json.error, stranger.headers.get('access-control-allow-origin')], [403, 'origin', null]);
    const pre = await s.handle(new Request('https://reader.test/', { method: 'OPTIONS', headers: { Origin: 'https://www.stalia.example', 'Access-Control-Request-Method': 'POST' } }), s.env);
    assert.deepEqual([pre.status, pre.headers.get('access-control-allow-origin'), pre.headers.get('access-control-allow-headers')], [204, 'https://www.stalia.example', 'Content-Type']);
    // with no list at all, any site may call (the limits still apply)
    const open = await s.post(twoPages(), { headers: { Origin: 'https://anything.example' }, env: Object.assign({}, s.env, { ALLOWED_ORIGINS: '' }), ip: 'x' });
    assert.deepEqual([open.status, open.headers.get('access-control-allow-origin')], [200, 'https://anything.example']);
  } finally { await s.mock.close(); }
});

serverTest('a Lemon Squeezy licence is checked with its licence service and remembered for a while', async () => {
  const calls = [];
  const lsFetch = async (url, init) => {
    calls.push([url, init.body]);
    const key = new URLSearchParams(init.body).get('license_key');
    return { json: async () => ({ valid: key.startsWith('GOOD'), meta: { store_id: key === 'GOOD-OTHER-STORE' ? 999 : 4242, product_id: 7 } }) };
  };
  const s = await service(null, { LS_STORE_ID: '4242', LS_PRODUCT_IDS: '7, 8' }, { fetch: lsFetch });
  try {
    assert.equal((await s.post(twoPages({ license: 'GOOD-KEY-1' }))).json.quota.plan, 'pro');
    assert.equal((await s.post(twoPages({ license: 'GOOD-KEY-1' }))).json.quota.plan, 'pro');
    assert.equal(calls.length, 1, 'the second request did not ask again');
    assert.equal(calls[0][0], 'https://api.lemonsqueezy.com/v1/licenses/validate');
    assert.equal((await s.post(twoPages({ license: 'BAD-KEY' }), { ip: 'a' })).json.quota.plan, 'free');
    assert.equal((await s.post(twoPages({ license: 'GOOD-OTHER-STORE' }), { ip: 'b' })).json.quota.plan, 'free', 'a key of somebody else’s shop is not ours');
    s.clock.t += 11 * 60 * 1000;
    await s.post(twoPages({ license: 'GOOD-KEY-1' }));
    assert.equal(calls.filter((c) => /GOOD-KEY-1/.test(c[1])).length, 2, 'asked again after ten minutes');
    // without a shop configured such keys are simply free
    const noShop = await s.post(twoPages({ license: 'GOOD-KEY-2' }), { env: Object.assign({}, s.env, { LS_STORE_ID: '' }), ip: 'c' });
    assert.equal(noShop.json.quota.plan, 'free');
  } finally { await s.mock.close(); }
});

serverTest('the Node server answers over real HTTP and trusts X-Forwarded-For only when told to', async () => {
  const { limits, Anthropic } = await load();
  const node = await import('../server/node-server.js');
  const mock = await startMockAnthropic(() => ({ text: JSON.stringify(answer()) }));
  const deps = { store: new limits.MemoryStore(), log: () => {}, createClient: (cfg) => new Anthropic({ apiKey: cfg.apiKey, baseURL: cfg.baseURL, maxRetries: 0 }) };
  const env = { ANTHROPIC_API_KEY: 'sk-test', STALIA_API_BASE_URL: mock.url, FREE_PER_DAY: '1' };
  const direct = await node.start(env, { port: 0, host: '127.0.0.1', deps });
  const proxied = await node.start(Object.assign({ TRUST_PROXY: '1' }, env), { port: 0, host: '127.0.0.1', deps: Object.assign({}, deps, { store: new limits.MemoryStore() }) });
  const call = (server, ip) => fetch('http://127.0.0.1:' + server.address().port + '/', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip }, body: JSON.stringify(twoPages()),
  }).then(async (r) => [r.status, (await r.json()).error || 'ok']);
  try {
    const up = await (await fetch('http://127.0.0.1:' + direct.address().port + '/')).json();
    assert.equal(up.ready, true);
    assert.deepEqual(await call(direct, '1.1.1.1'), [200, 'ok']);
    assert.deepEqual(await call(direct, '2.2.2.2'), [429, 'pro'], 'a made-up header does not buy a second free reading');
    assert.deepEqual(await call(proxied, '1.1.1.1'), [200, 'ok']);
    assert.deepEqual(await call(proxied, '2.2.2.2'), [200, 'ok']);
    assert.deepEqual(await call(proxied, '2.2.2.2'), [429, 'pro']);
    const tooBig = await fetch('http://127.0.0.1:' + direct.address().port + '/', { method: 'POST', body: 'x'.repeat(25 * 1024 * 1024) }).then((r) => r.status, () => 413);
    assert.equal(tooBig, 413);
  } finally {
    for (const srv of [direct, proxied]) { srv.closeAllConnections(); await new Promise((r) => srv.close(r)); }
    await mock.close();
  }
});
