'use strict';
/*
 * The shared space: who may read and write what, the history of a calculation, links for counterparties,
 * and what happens when the trial runs out. The database is SQLite in memory, as on the real server.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const K = require('../tools/keygen.js');

const ROOT = path.resolve(__dirname, '..');
const kp = K.generateKeyPair();
const T0 = Date.parse('2026-11-12T10:00:00Z');
const DAY = 86400000;
/** Stands in for something encrypted in a browser. */
const blob = (text) => Buffer.from(String(text).padEnd(24, '.')).toString('base64url');

async function setup(env) {
  const { DatabaseSync } = require('node:sqlite');
  const [{ createSpaceApi, LIMITS }, { sqliteDb }, { MemoryStore }] = await Promise.all([
    import(path.join(ROOT, 'server/src/space.js')), import(path.join(ROOT, 'server/src/space-db.js')), import(path.join(ROOT, 'server/src/limits.js')),
  ]);
  const t = { clock: T0, ip: '10.0.0.1', LIMITS };
  const db = sqliteDb(DatabaseSync, ':memory:');
  const api = createSpaceApi({ db, now: () => t.clock, store: new MemoryStore(() => t.clock) });
  const reply = (status, body) => new Response(JSON.stringify(body), { status });
  const io = { reply, fail: (status, error, extra) => reply(status, Object.assign({ ok: false, error }, extra || {})) };
  t.env = Object.assign({ STALIA_PUBLIC_KEYS: JSON.stringify([kp.publicJwk]) }, env || {});
  t.call = async (method, route, body, token) => {
    const res = await api(new Request('http://server/api/v1/' + route, {
      method, headers: token ? { authorization: 'Bearer ' + token } : {}, body: body === undefined ? undefined : JSON.stringify(body),
    }), t.env, { ip: t.ip }, io);
    return Object.assign({ status: res.status }, await res.json());
  };
  /** A company with an owner; returns the owner's token. */
  t.company = async (name) => {
    const r = await t.call('POST', 'spaces', { name: blob(name || 'ACME Shipping'), me: blob('Owner') });
    assert.equal(r.status, 200, JSON.stringify(r));
    return r.token;
  };
  /** Somebody joins through an invite; returns their token. */
  t.joins = async (ownerToken, role, name) => {
    const inv = await t.call('POST', 'invites', { role }, ownerToken);
    assert.equal(inv.status, 200, JSON.stringify(inv));
    const j = await t.call('POST', 'join', { invite: inv.invite.token, me: blob(name || role) });
    assert.equal(j.status, 200, JSON.stringify(j));
    return j.token;
  };
  t.newCalc = async (token, title) => {
    const r = await t.call('POST', 'calcs', { key: blob('wrapped key'), meta: blob('meta ' + (title || 'calc')), data: blob('version one of ' + (title || 'calc')) }, token);
    assert.equal(r.status, 200, JSON.stringify(r));
    return r.calc.id;
  };
  t.db = db;
  return t;
}

test('space: a company is created, a colleague joins by invite, roles decide what each may do', async () => {
  const t = await setup();
  const made = await t.call('POST', 'spaces', { name: blob('ACME Shipping'), me: blob('Aigerim') });
  assert.equal(made.status, 200);
  assert.match(made.token, /^m\.mb_[\w-]+\.[\w-]{20,}$/);
  assert.deepEqual([made.me.role, made.space.active, made.space.trialUntil], ['owner', true, T0 + 14 * DAY]);
  const owner = made.token;

  const over = await t.call('GET', 'space', undefined, owner);
  assert.equal(over.space.name, blob('ACME Shipping'), 'the name comes back exactly as it was sent: the server cannot read it');
  assert.deepEqual(over.members.map((m) => [m.role, m.name]), [['owner', blob('Aigerim')]]);

  assert.equal((await t.call('GET', 'space')).status, 401, 'nothing without a token');
  assert.equal((await t.call('GET', 'space', undefined, 'm.mb_nobody00000.' + 'x'.repeat(32))).status, 401);
  assert.equal((await t.call('GET', 'space', undefined, owner.slice(0, -1) + (owner.endsWith('A') ? 'B' : 'A'))).status, 401, 'a token that differs in one letter is not a token');

  const editor = await t.joins(owner, 'editor', 'Daniyar');
  const viewer = await t.joins(owner, 'viewer', 'Auditor');
  assert.equal((await t.call('GET', 'space', undefined, viewer)).members.length, 3);
  assert.equal((await t.call('GET', 'space', undefined, editor)).invites.length, 0, 'invites are the owner’s business');
  assert.equal((await t.call('GET', 'space', undefined, owner)).invites.length, 2);

  // calculations: the editor writes, the viewer reads
  const id = await t.newCalc(editor, 'Voyage 37');
  assert.equal((await t.call('POST', 'calcs', { key: blob('k'), meta: blob('m'), data: blob('d') }, viewer)).status, 403);
  assert.deepEqual((await t.call('GET', 'calcs', undefined, viewer)).calcs.map((c) => [c.id, c.head, c.meta]), [[id, 1, blob('meta Voyage 37')]]);
  assert.equal((await t.call('PUT', 'calcs/' + id, { base: 1, data: blob('v2 by the viewer') }, viewer)).status, 403);
  assert.equal((await t.call('POST', 'calcs/' + id + '/comments', { body: blob('Looks right to me') }, viewer)).status, 200, 'a viewer may still say something');
  assert.equal((await t.call('POST', 'invites', { role: 'editor' }, editor)).status, 403);
  assert.equal((await t.call('POST', 'calcs/' + id + '/shares', { role: 'view', label: blob('Charterers') }, viewer)).status, 403);

  // people: the owner changes a role and shows somebody the door
  const ids = Object.fromEntries((await t.call('GET', 'space', undefined, owner)).members.map((m) => [m.name, m.id]));
  assert.equal((await t.call('PATCH', 'members/' + ids[blob('Auditor')], { role: 'editor' }, editor)).status, 403);
  assert.equal((await t.call('PATCH', 'members/' + ids[blob('Auditor')], { role: 'editor' }, owner)).status, 200);
  assert.equal((await t.call('PUT', 'calcs/' + id, { base: 1, data: blob('v2 by the former viewer') }, viewer)).status, 200);
  assert.equal((await t.call('PATCH', 'members/' + ids[blob('Daniyar')], { revoked: true }, owner)).status, 200);
  assert.equal((await t.call('GET', 'calcs', undefined, editor)).status, 401, 'a removed member’s token stops working at once');
  assert.equal((await t.call('PATCH', 'members/' + ids[blob('Aigerim')], { revoked: true }, owner)).error, 'last_owner', 'a space is never left without an owner');
  assert.equal((await t.call('PATCH', 'members/' + ids[blob('Aigerim')], { role: 'viewer' }, owner)).error, 'last_owner');
  assert.equal((await t.call('PATCH', 'members/' + ids[blob('Auditor')], { me: blob('Somebody else') }, owner)).status, 403, 'only you rename yourself');
  assert.equal((await t.call('PATCH', 'members/' + ids[blob('Aigerim')], { me: blob('Aigerim S.') }, owner)).status, 200);
  assert.equal((await t.call('PATCH', 'members/' + ids[blob('Auditor')], { revoked: true }, viewer)).status, 200, 'anybody may leave');
});

test('space: invites run out, expire and can be withdrawn', async () => {
  const t = await setup();
  const owner = await t.company();
  const once = (await t.call('POST', 'invites', { role: 'viewer', uses: 1, days: 2 }, owner)).invite;
  assert.equal((await t.call('POST', 'join', { invite: once.token, me: blob('first') })).status, 200);
  assert.equal((await t.call('POST', 'join', { invite: once.token, me: blob('second') })).error, 'invite_used');
  const short = (await t.call('POST', 'invites', { role: 'viewer', days: 1 }, owner)).invite;
  t.clock += 2 * DAY;
  assert.equal((await t.call('POST', 'join', { invite: short.token, me: blob('late') })).error, 'invite_used');
  const pulled = (await t.call('POST', 'invites', { role: 'editor' }, owner)).invite;
  assert.equal((await t.call('DELETE', 'invites/' + pulled.id, undefined, owner)).status, 200);
  assert.equal((await t.call('POST', 'join', { invite: pulled.token, me: blob('nobody') })).error, 'invite');
  assert.equal((await t.call('POST', 'join', { invite: 'i.in_missing000.' + 'y'.repeat(32), me: blob('x') })).error, 'invite');
  assert.equal((await t.call('POST', 'join', { invite: pulled.token.replace(/^i/, 'm'), me: blob('x') })).status, 400);
  assert.equal((await t.call('POST', 'invites', { role: 'admin' }, owner)).status, 400);
});

test('space: every save is a version; two people saving on top of the same version do not overwrite each other', async () => {
  const t = await setup();
  const owner = await t.company();
  const colleague = await t.joins(owner, 'editor');
  const id = await t.newCalc(owner, 'Voyage 38');

  t.clock += 60000;
  const second = await t.call('PUT', 'calcs/' + id, { base: 1, data: blob('version two'), meta: blob('meta two'), info: blob('NOR corrected, by the owner') }, owner);
  assert.deepEqual([second.status, second.calc.head], [200, 2]);
  assert.equal((await t.call('PUT', 'calcs/' + id, { base: 2, data: blob('x'), info: 'no' }, owner)).status, 400);
  // the colleague still has version 1 open and saves: refused, and told where the calculation stands now
  const stale = await t.call('PUT', 'calcs/' + id, { base: 1, data: blob('the colleague’s version') }, colleague);
  assert.deepEqual([stale.status, stale.error, stale.head], [409, 'conflict', 2]);
  // they look at version 2 and save on top of it
  t.clock += 60000;
  assert.equal((await t.call('PUT', 'calcs/' + id, { base: 2, data: blob('version three') }, colleague)).calc.head, 3);

  const got = (await t.call('GET', 'calcs/' + id, undefined, owner)).calc;
  assert.deepEqual(got.versions.map((v) => v.n), [3, 2, 1], 'newest first, nothing lost');
  assert.deepEqual(got.versions.map((v) => v.info), ['', blob('NOR corrected, by the owner'), ''], 'with the few lines each version says about itself');
  assert.equal(new Set(got.versions.map((v) => v.by)).size, 2, 'each version remembers who saved it');
  assert.deepEqual([got.head, got.metaHead, got.meta], [3, 2, blob('meta two')], 'the list entry is the one written with version 2');
  for (const [n, text] of [[1, 'version one of Voyage 38'], [2, 'version two'], [3, 'version three']]) {
    assert.equal((await t.call('GET', 'calcs/' + id + '/versions/' + n, undefined, colleague)).version.data, blob(text));
  }
  assert.equal((await t.call('GET', 'calcs/' + id + '/versions/4', undefined, owner)).status, 404);
  const brief = (await t.call('GET', 'calcs/' + id + '?brief=1', undefined, colleague)).calc;
  assert.deepEqual([brief.head, brief.versions.length, brief.versions[0].n], [3, 1, 3], 'the short answer: where it stands and the latest line only');

  // both press Save in the same instant on top of version 3: exactly one of them gets version 4
  const [a, b] = await Promise.all([
    t.call('PUT', 'calcs/' + id, { base: 3, data: blob('four, by the owner') }, owner),
    t.call('PUT', 'calcs/' + id, { base: 3, data: blob('four, by the colleague') }, colleague),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal((await t.call('GET', 'calcs/' + id, undefined, owner)).calc.head, 4);

  // the list entry can be refreshed on its own (a status change, or after a guest's edit)
  assert.equal((await t.call('PUT', 'calcs/' + id + '/meta', { meta: blob('meta four'), head: 4 }, colleague)).status, 200);
  assert.equal((await t.call('PUT', 'calcs/' + id + '/meta', { meta: blob('meta five'), head: 5 }, colleague)).status, 400, 'not for a version that does not exist');
  assert.deepEqual((await t.call('GET', 'calcs', undefined, owner)).calcs.map((c) => [c.head, c.metaHead, c.meta]), [[4, 4, blob('meta four')]]);

  assert.equal((await t.call('DELETE', 'calcs/' + id, undefined, colleague)).status, 200);
  assert.equal((await t.call('GET', 'calcs/' + id, undefined, owner)).status, 404);
  assert.deepEqual((await t.call('GET', 'calcs', undefined, owner)).calcs, []);
});

test('space: a counterparty’s link opens one calculation and nothing else; its role decides the rest', async () => {
  const t = await setup();
  const owner = await t.company();
  const id = await t.newCalc(owner, 'Voyage 39'), other = await t.newCalc(owner, 'Voyage 40');
  const link = async (role) => (await t.call('POST', 'calcs/' + id + '/shares', { role, label: blob('Charterers, ' + role) }, owner)).share;
  const view = await link('view'), comment = await link('comment'), edit = await link('edit');
  assert.match(view.token, /^s\.sh_[\w-]+\.[\w-]{20,}$/);

  // what any guest sees: this calculation and its history, without the space's own key and list entry
  const seen = (await t.call('GET', 'calcs/' + id, undefined, view.token)).calc;
  assert.deepEqual([seen.id, seen.head, seen.role, seen.key, seen.meta], [id, 1, 'view', undefined, undefined]);
  assert.equal((await t.call('GET', 'calcs/' + id + '/versions/1', undefined, view.token)).version.data, blob('version one of Voyage 39'));
  // and what none of them sees
  for (const token of [view.token, comment.token, edit.token]) {
    assert.equal((await t.call('GET', 'calcs/' + other, undefined, token)).status, 404, 'another calculation of the same company');
    assert.equal((await t.call('GET', 'calcs', undefined, token)).status, 403);
    assert.equal((await t.call('GET', 'space', undefined, token)).status, 403);
    assert.equal((await t.call('GET', 'contracts', undefined, token)).status, 403);
    assert.equal((await t.call('GET', 'calcs/' + id + '/shares', undefined, token)).status, 403, 'who else has a link');
    assert.equal((await t.call('POST', 'calcs/' + id + '/shares', { role: 'edit', label: blob('x') }, token)).status, 403);
    assert.equal((await t.call('DELETE', 'calcs/' + id, undefined, token)).status, 403);
  }

  assert.equal((await t.call('POST', 'calcs/' + id + '/comments', { body: blob('We do not agree') }, view.token)).status, 403);
  assert.equal((await t.call('PUT', 'calcs/' + id, { base: 1, data: blob('theirs') }, view.token)).status, 403);
  assert.equal((await t.call('POST', 'calcs/' + id + '/comments', { body: blob('We do not agree with the weather on the 14th') }, comment.token)).status, 200);
  assert.equal((await t.call('PUT', 'calcs/' + id, { base: 1, data: blob('theirs') }, comment.token)).status, 403);
  assert.equal((await t.call('PUT', 'calcs/' + id, { base: 1, data: blob('theirs'), meta: blob('m') }, edit.token)).status, 400, 'the list entry belongs to the space');
  const theirs = await t.call('PUT', 'calcs/' + id, { base: 1, data: blob('the counterparty’s version') }, edit.token);
  assert.deepEqual([theirs.status, theirs.calc.head], [200, 2]);

  // the company sees their version, under the link it came through, and that its own list entry is one behind
  const mine = (await t.call('GET', 'calcs/' + id, undefined, owner)).calc;
  assert.deepEqual([mine.head, mine.metaHead, mine.versions[0].by], [2, 1, 's:' + edit.id]);
  const talk = (await t.call('GET', 'calcs/' + id + '/comments', undefined, owner)).comments;
  assert.deepEqual(talk.map((c) => [c.body, c.by]), [[blob('We do not agree with the weather on the 14th'), 's:' + comment.id]]);
  const links = (await t.call('GET', 'calcs/' + id + '/shares', undefined, owner)).shares;
  assert.deepEqual(links.map((s) => [s.role, s.label]), [['view', blob('Charterers, view')], ['comment', blob('Charterers, comment')], ['edit', blob('Charterers, edit')]]);
  assert.equal(links[0].token, undefined, 'a link is shown once, when it is made');

  // a link is withdrawn; deleting the calculation withdraws the rest
  assert.equal((await t.call('DELETE', 'shares/' + edit.id, undefined, owner)).status, 200);
  assert.equal((await t.call('GET', 'calcs/' + id, undefined, edit.token)).status, 401);
  assert.equal((await t.call('GET', 'calcs/' + id, undefined, comment.token)).status, 200);
  await t.call('DELETE', 'calcs/' + id, undefined, owner);
  assert.equal((await t.call('GET', 'calcs/' + id, undefined, comment.token)).status, 401);
});

test('space: one company cannot reach into another', async () => {
  const t = await setup();
  const acme = await t.company('ACME Shipping');
  t.ip = '10.0.0.2';
  const rival = await t.company('Rival Trading');
  const id = await t.newCalc(acme, 'Voyage 41');
  const share = (await t.call('POST', 'calcs/' + id + '/shares', { role: 'edit', label: blob('Charterers') }, acme)).share;
  const acmeMember = (await t.call('GET', 'space', undefined, acme)).members[0].id;
  const ct = (await t.call('POST', 'contracts', { data: blob('ACME contract') }, acme)).contract.id;

  assert.deepEqual((await t.call('GET', 'calcs', undefined, rival)).calcs, []);
  for (const [method, route, body] of [
    ['GET', 'calcs/' + id], ['GET', 'calcs/' + id + '/versions/1'], ['PUT', 'calcs/' + id, { base: 1, data: blob('x') }], ['DELETE', 'calcs/' + id],
    ['GET', 'calcs/' + id + '/comments'], ['POST', 'calcs/' + id + '/comments', { body: blob('x') }], ['GET', 'calcs/' + id + '/shares'],
    ['PATCH', 'members/' + acmeMember, { revoked: true }], ['PUT', 'contracts/' + ct, { data: blob('x'), rev: 1 }],
  ]) assert.equal((await t.call(method, route, body, rival)).status, 404, method + ' ' + route);
  await t.call('DELETE', 'shares/' + share.id, undefined, rival);
  await t.call('DELETE', 'contracts/' + ct, undefined, rival);
  assert.equal((await t.call('GET', 'calcs/' + id, undefined, share.token)).status, 200, 'the link ACME made still works');
  assert.equal((await t.call('GET', 'contracts', undefined, acme)).contracts.length, 1);
  assert.equal((await t.call('POST', 'calcs', { contractId: ct, key: blob('k'), meta: blob('m'), data: blob('d') }, rival)).status, 400, 'nor file a calculation under somebody else’s contract');
});

test('space: contracts are kept once and changed by one person at a time', async () => {
  const t = await setup();
  const owner = await t.company();
  const viewer = await t.joins(owner, 'viewer');
  const made = await t.call('POST', 'contracts', { data: blob('Tanker contract, 72 h reversible') }, owner);
  const id = made.contract.id;
  assert.equal((await t.call('POST', 'contracts', { data: blob('x') }, viewer)).status, 403);
  assert.deepEqual((await t.call('GET', 'contracts', undefined, viewer)).contracts.map((c) => [c.id, c.rev, c.data]), [[id, 1, blob('Tanker contract, 72 h reversible')]]);
  assert.equal((await t.call('PUT', 'contracts/' + id, { data: blob('rate changed'), rev: 1 }, owner)).contract.rev, 2);
  const late = await t.call('PUT', 'contracts/' + id, { data: blob('somebody else’s change'), rev: 1 }, owner);
  assert.deepEqual([late.status, late.error, late.rev], [409, 'conflict', 2]);
  const calc = (await t.call('POST', 'calcs', { contractId: id, key: blob('k'), meta: blob('m'), data: blob('d') }, owner)).calc.id;
  assert.equal((await t.call('GET', 'calcs/' + calc, undefined, owner)).calc.contractId, id);
  assert.equal((await t.call('PUT', 'calcs/' + calc + '/meta', { meta: blob('m2'), head: 1, contractId: '' }, owner)).status, 200);
  assert.equal((await t.call('GET', 'calcs/' + calc, undefined, owner)).calc.contractId, '');
  assert.equal((await t.call('DELETE', 'contracts/' + id, undefined, owner)).status, 200);
  assert.deepEqual((await t.call('GET', 'contracts', undefined, owner)).contracts, []);
});

test('space: after the trial everything can still be read, nothing can be changed, and a licence opens it again', async () => {
  const t = await setup();
  const owner = await t.company();
  const editor = await t.joins(owner, 'editor');
  const id = await t.newCalc(editor, 'Voyage 42');
  const share = (await t.call('POST', 'calcs/' + id + '/shares', { role: 'edit', label: blob('Charterers') }, owner)).share;

  t.clock = T0 + 14 * DAY + 1000;
  assert.equal((await t.call('GET', 'space', undefined, owner)).space.active, false);
  // reading goes on, for the company and for the counterparty
  assert.equal((await t.call('GET', 'calcs', undefined, editor)).calcs.length, 1);
  assert.equal((await t.call('GET', 'calcs/' + id + '/versions/1', undefined, share.token)).status, 200);
  // writing does not
  for (const [method, route, body, token] of [
    ['POST', 'calcs', { key: blob('k'), meta: blob('m'), data: blob('d') }, editor], ['PUT', 'calcs/' + id, { base: 1, data: blob('d2') }, editor],
    ['PUT', 'calcs/' + id, { base: 1, data: blob('d2') }, share.token], ['POST', 'calcs/' + id + '/comments', { body: blob('hello there') }, share.token],
    ['POST', 'invites', { role: 'viewer' }, owner], ['POST', 'contracts', { data: blob('c') }, owner], ['POST', 'calcs/' + id + '/shares', { role: 'view', label: blob('x') }, owner],
  ]) {
    const r = await t.call(method, route, body, token);
    assert.deepEqual([r.status, r.error], [402, 'plan'], method + ' ' + route);
  }

  // a licence: only the owner attaches it, only a real one counts, and one licence serves one company
  const key = K.issueKey(kp.privatePem, { name: 'ACME Shipping', exp: '2027-03-01' });
  assert.equal((await t.call('POST', 'space/licence', { key }, editor)).status, 403);
  assert.equal((await t.call('POST', 'space/licence', { key: key.slice(0, -4) + 'AAAA' }, owner)).error, 'licence');
  assert.equal((await t.call('POST', 'space/licence', { key: K.issueKey(kp.privatePem, { name: 'ACME', exp: '2020-01-01' }) }, owner)).error, 'licence');
  const paid = await t.call('POST', 'space/licence', { key }, owner);
  assert.deepEqual([paid.status, paid.space.active, new Date(paid.space.paidUntil).toISOString().slice(0, 10)], [200, true, '2027-03-02']);
  assert.equal((await t.call('PUT', 'calcs/' + id, { base: 1, data: blob('d2') }, share.token)).status, 200);
  t.ip = '10.0.0.3';
  const other = await t.company('Other Co');
  assert.equal((await t.call('POST', 'space/licence', { key }, other)).error, 'licence_used');
  assert.equal((await t.call('POST', 'space/licence', { key }, owner)).status, 200, 'attaching it again to the same company is fine');
  t.clock = Date.parse('2027-03-03T00:00:00Z');
  assert.equal((await t.call('PUT', 'calcs/' + id, { base: 2, data: blob('d3') }, editor)).error, 'plan', 'and it ends with the licence');
  assert.equal((await t.call('POST', 'space/licence', { key: K.issueKey(kp.privatePem, { name: 'ACME Shipping' }) }, owner)).space.active, true, 'a key without an end date');
});

test('space: sizes and numbers are limited, and a space can be deleted for good', async () => {
  const t = await setup({ SPACES_PER_DAY: '3' });
  const owner = await t.company();
  assert.equal((await t.call('POST', 'calcs', { key: blob('k'), meta: blob('m'), data: 'not base64 url!' + '.'.repeat(30) }, owner)).status, 400);
  assert.equal((await t.call('POST', 'calcs', { key: blob('k'), meta: blob('m'), data: 'A'.repeat(t.LIMITS.data + 1) }, owner)).status, 400);
  assert.equal((await t.call('POST', 'calcs', { key: blob('k'), meta: 'A'.repeat(t.LIMITS.small + 1), data: blob('d') }, owner)).status, 400);
  assert.equal((await t.call('POST', 'calcs', { key: blob('k'), meta: blob('m'), data: 'A'.repeat(1000000) }, owner)).status, 413);
  assert.equal((await t.call('POST', 'calcs', [1, 2], owner)).status, 400);
  await t.company('second'); await t.company('third');
  assert.deepEqual([(await t.call('POST', 'spaces', { name: blob('fourth'), me: blob('x') })).status], [429], 'a few new spaces a day from one address');
  t.clock += 2 * DAY;
  assert.equal((await t.call('POST', 'spaces', { name: blob('fourth'), me: blob('x') })).status, 200);
  assert.equal((await t.call('GET', 'nonsense', undefined, owner)).status, 404);

  const id = await t.newCalc(owner, 'Voyage 43');
  const share = (await t.call('POST', 'calcs/' + id + '/shares', { role: 'view', label: blob('Charterers') }, owner)).share;
  const editor = await t.joins(owner, 'editor');
  assert.equal((await t.call('DELETE', 'space', undefined, editor)).status, 403);
  assert.equal((await t.call('DELETE', 'space', undefined, owner)).status, 200);
  for (const token of [owner, editor, share.token]) assert.equal((await t.call('GET', 'calcs/' + id, undefined, token)).status, 401);
  for (const table of ['spaces', 'members', 'invites', 'calcs', 'versions', 'shares', 'comments', 'contracts']) {
    const left = await t.db.get('SELECT COUNT(*) AS n FROM ' + table + (table === 'spaces' ? '' : ''), []);
    assert.ok(Number(left.n) <= (table === 'spaces' || table === 'members' ? 3 : 0), table + ': ' + left.n + ' rows left');
  }
});
