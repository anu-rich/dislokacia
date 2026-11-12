'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const L = require('../app/license.js');
const K = require('../tools/keygen.js');

const kp = K.generateKeyPair();
const other = K.generateKeyPair();
const T0 = Date.parse('2026-11-12T10:00:00Z');
const DAYMS = 86400000;

test('offline key: issue -> verify, payload round trip (unicode licensee)', async () => {
  const key = K.issueKey(kp.privatePem, { name: 'ТОО «Каспий Шиппинг»', exp: '2027-11-12' });
  assert.match(key, /^STL1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{86}$/);
  const r = await L.verifyOfflineKey(key, [kp.publicJwk], T0);
  assert.equal(r.ok, true);
  assert.equal(r.payload.n, 'ТОО «Каспий Шиппинг»');
  assert.equal(r.payload.p, 'pro');
  assert.equal(r.payload.exp, '2027-11-12');
});

test('offline key: tampering, wrong key, bad format', async () => {
  const key = K.issueKey(kp.privatePem, { name: 'ACME', exp: '2027-01-01' });
  const [h, p, s] = key.split('.');
  const forged = Buffer.from(JSON.stringify({ id: 'x', n: 'ACME', p: 'pro', iat: '2026-11-12', exp: '2099-01-01' })).toString('base64url');
  assert.equal((await L.verifyOfflineKey([h, forged, s].join('.'), [kp.publicJwk], T0)).error, 'signature');
  assert.equal((await L.verifyOfflineKey(key, [other.publicJwk], T0)).error, 'signature');
  assert.equal((await L.verifyOfflineKey(key, [], T0)).error, 'no_keys');
  assert.equal((await L.verifyOfflineKey('hello', [kp.publicJwk], T0)).error, 'format');
  assert.equal((await L.verifyOfflineKey('STL1.' + p + '.AAAA', [kp.publicJwk], T0)).error, 'format');
  assert.equal((await L.verifyOfflineKey('STL1.@@@.' + s, [kp.publicJwk], T0)).error, 'format');
  // key rotation: old and new public keys side by side
  assert.equal((await L.verifyOfflineKey(key, [other.publicJwk, kp.publicJwk], T0)).ok, true);
});

test('offline key: expiry is inclusive of the last day; perpetual keys', async () => {
  const key = K.issueKey(kp.privatePem, { name: 'ACME', exp: '2026-11-12' });
  assert.equal((await L.verifyOfflineKey(key, [kp.publicJwk], Date.parse('2026-11-12T23:00:00Z'))).ok, true);
  const late = await L.verifyOfflineKey(key, [kp.publicJwk], Date.parse('2026-11-14T00:00:00Z'));
  assert.equal(late.ok, false); assert.equal(late.error, 'expired'); assert.equal(late.payload.n, 'ACME');
  const forever = K.issueKey(kp.privatePem, { name: 'ACME', exp: null });
  assert.equal((await L.verifyOfflineKey(forever, [kp.publicJwk], Date.parse('2099-01-01T00:00:00Z'))).ok, true);
  assert.throws(() => K.issueKey(kp.privatePem, { name: '' }), /name is required/);
  assert.throws(() => K.issueKey(kp.privatePem, { name: 'A', exp: '31.12.2027' }), /Expiry/);
});

test('manager: activate offline key, persist, reload, expire, remove', async () => {
  const storage = L.memoryStorage();
  let clock = T0;
  const mk = () => L.create({ config: { licensePublicKeys: [kp.publicJwk] }, storage, now: () => clock });
  const m = mk();
  assert.equal((await m.init()).pro, false);
  const seen = [];
  m.onChange((s) => seen.push(s.pro));
  assert.deepEqual(await m.activate('  nonsense '), { ok: false, error: 'format' });
  assert.deepEqual(await m.activate(''), { ok: false, error: 'empty' });
  const key = K.issueKey(kp.privatePem, { name: 'ACME Shipping', exp: '2027-03-01' });
  assert.deepEqual(await m.activate(key.slice(0, 40) + '\n' + key.slice(40)), { ok: true }); // pasted with a line break
  assert.equal(m.get().pro, true); assert.equal(m.get().licensee, 'ACME Shipping'); assert.equal(m.get().expires, '2027-03-01');
  assert.deepEqual(seen, [true]);
  const again = mk();
  assert.equal((await again.init()).pro, true);
  clock = Date.parse('2027-03-05T00:00:00Z');
  const later = mk();
  const st = await later.init();
  assert.equal(st.pro, false); assert.equal(st.status, 'expired'); assert.equal(st.licensee, 'ACME Shipping');
  await later.remove();
  assert.equal(later.get().status, 'none');
  assert.equal(storage.getItem(L.STORE_KEY), null);
});

// ---------------------------------------------------------------- Lemon Squeezy (mocked HTTP)
function mockLS(script) {
  const calls = [];
  const fetchFn = async (url, init) => {
    const endpoint = url.split('/').pop();
    const params = Object.fromEntries(new URLSearchParams(init.body));
    calls.push({ endpoint, params, headers: init.headers });
    const r = script(endpoint, params);
    if (r instanceof Error) throw r;
    return { status: r.status || 200, json: async () => r.body };
  };
  return { fetchFn, calls };
}
const lsConfig = { lemonSqueezy: { enabled: true, storeId: 111, productIds: [222] }, licensePublicKeys: [] };
const okBody = (over) => Object.assign({
  activated: true, valid: true, error: null,
  license_key: { id: 1, status: 'active', key: 'k', activation_limit: 3, activation_usage: 1, expires_at: '2027-11-12T10:00:00.000000Z' },
  instance: { id: 'inst-1', name: 'x' },
  meta: { store_id: 111, product_id: 222, product_name: 'Stalia Pro', variant_name: 'Yearly', customer_name: 'Jane Broker', customer_email: 'jane@example.com' },
}, over || {});

test('LS: activation stores the instance and unlocks Pro', async () => {
  const storage = L.memoryStorage();
  const { fetchFn, calls } = mockLS(() => ({ body: okBody() }));
  const m = L.create({ config: lsConfig, storage, fetch: fetchFn, now: () => T0 });
  await m.init();
  assert.deepEqual(await m.activate('38b1460a-5104-4067-a91d-77b872934d51'), { ok: true });
  assert.equal(calls[0].endpoint, 'activate');
  assert.equal(calls[0].params.license_key, '38b1460a-5104-4067-a91d-77b872934d51');
  assert.match(calls[0].params.instance_name, /^Stalia web 2026-11-12$/);
  assert.equal(calls[0].headers['Content-Type'], 'application/x-www-form-urlencoded');
  const s = m.get();
  assert.equal(s.pro, true); assert.equal(s.type, 'ls'); assert.equal(s.licensee, 'Jane Broker');
  assert.equal(s.expires, '2027-11-12'); assert.equal(s.plan, 'Stalia Pro — Yearly');
  assert.equal(JSON.parse(storage.getItem(L.STORE_KEY)).instanceId, 'inst-1');
});

test('LS: key from another store/product is refused and its seat released', async () => {
  const { fetchFn, calls } = mockLS((ep) => ({ body: ep === 'activate' ? okBody({ meta: { store_id: 999, product_id: 222 } }) : { deactivated: true } }));
  const m = L.create({ config: lsConfig, storage: L.memoryStorage(), fetch: fetchFn, now: () => T0 });
  assert.deepEqual(await m.activate('aaaaaaaa-0000-0000-0000-000000000000'), { ok: false, error: 'wrong_product' });
  assert.deepEqual(calls.map((c) => c.endpoint), ['activate', 'deactivate']);
  assert.equal(calls[1].params.instance_id, 'inst-1');
  assert.equal(m.get().pro, false);
  const wrongProduct = mockLS(() => ({ body: okBody({ meta: { store_id: 111, product_id: 5 } }) }));
  const m2 = L.create({ config: lsConfig, storage: L.memoryStorage(), fetch: wrongProduct.fetchFn, now: () => T0 });
  assert.equal((await m2.activate('aaaaaaaa-0000-0000-0000-000000000000')).error, 'wrong_product');
});

test('LS: error mapping (unknown key, activation limit, network) and disabled integration', async () => {
  const run = async (script, cfg) => {
    const { fetchFn } = mockLS(script);
    return L.create({ config: cfg || lsConfig, storage: L.memoryStorage(), fetch: fetchFn, now: () => T0 }).activate('aaaaaaaa-0000-0000-0000-000000000000');
  };
  assert.equal((await run(() => ({ status: 404, body: { activated: false, error: 'license_key not found.' } }))).error, 'not_found');
  assert.equal((await run(() => ({ status: 400, body: { activated: false, error: 'This license key has reached the activation limit.' } }))).error, 'limit');
  assert.equal((await run(() => ({ status: 400, body: { activated: false, error: 'This license key is expired.' } }))).error, 'expired');
  assert.equal((await run(() => new Error('offline'))).error, 'network');
  // integration off, or enabled without a store id: foreign keys never unlock anything
  assert.equal((await run(() => ({ body: okBody() }), { lemonSqueezy: { enabled: false } })).error, 'format');
  assert.equal((await run(() => ({ body: okBody() }), { lemonSqueezy: { enabled: true, storeId: '' } })).error, 'format');
});

test('LS: daily re-validation, expiry, grace period when the server is unreachable', async () => {
  const storage = L.memoryStorage();
  let clock = T0, mode = 'ok';
  const { fetchFn, calls } = mockLS((ep) => {
    if (mode === 'down') return new Error('network down');
    if (mode === 'expired') return { status: 400, body: { valid: false, error: 'expired', license_key: { status: 'expired' }, meta: okBody().meta } };
    return { body: okBody() };
  });
  const mk = () => L.create({ config: lsConfig, storage, fetch: fetchFn, now: () => clock });
  const m = mk();
  await m.activate('aaaaaaaa-0000-0000-0000-000000000000');
  calls.length = 0;
  await m.revalidate();                         // fresh: no network call
  assert.equal(calls.length, 0);
  clock = T0 + 2 * DAYMS;
  await m.revalidate();                         // stale: validates with the stored instance id
  assert.equal(calls[0].endpoint, 'validate'); assert.equal(calls[0].params.instance_id, 'inst-1');
  assert.equal(m.get().pro, true);

  mode = 'down'; clock = T0 + 10 * DAYMS;       // server unreachable, within 14 days of the last check
  assert.equal((await m.revalidate()).status, 'grace');
  assert.equal(m.get().pro, true);
  clock = T0 + 2 * DAYMS + 15 * DAYMS;          // beyond the grace period
  const lost = await m.revalidate();
  assert.equal(lost.pro, false); assert.equal(lost.error, 'offline_too_long');

  mode = 'ok';                                  // back online: Pro returns
  assert.equal((await m.revalidate()).pro, true);
  mode = 'expired'; clock += 2 * DAYMS;         // subscription ended
  const ex = await m.revalidate();
  assert.equal(ex.pro, false); assert.equal(ex.status, 'expired');
  const reload = mk();                          // a new page load remembers it is expired
  assert.equal((await reload.init()).pro, false);
  assert.equal(reload.get().status, 'expired');
});

test('LS: remove() frees the activation seat', async () => {
  const { fetchFn, calls } = mockLS((ep) => ({ body: ep === 'deactivate' ? { deactivated: true } : okBody() }));
  const storage = L.memoryStorage();
  const m = L.create({ config: lsConfig, storage, fetch: fetchFn, now: () => T0 });
  await m.activate('aaaaaaaa-0000-0000-0000-000000000000');
  await m.remove();
  assert.equal(calls[calls.length - 1].endpoint, 'deactivate');
  assert.equal(m.get().pro, false); assert.equal(storage.getItem(L.STORE_KEY), null);
});

test('keygen: config.js markers are read and rewritten as valid JSON', () => {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stalia-')), 'config.js');
  fs.copyFileSync(path.join(__dirname, '..', 'app', 'config.js'), tmp);
  K.writeConfigKeys([kp.publicJwk, other.publicJwk], tmp);
  assert.deepEqual(K.readConfigKeys(tmp).keys, [kp.publicJwk, other.publicJwk]);
  delete require.cache[require.resolve(tmp)];
  assert.deepEqual(require(tmp).licensePublicKeys, [kp.publicJwk, other.publicJwk]); // file is still valid JS
  K.writeConfigKeys([], tmp);
  assert.deepEqual(K.readConfigKeys(tmp).keys, []);
  assert.deepEqual(K.publicJwkOf(kp.privatePem), kp.publicJwk);
});
