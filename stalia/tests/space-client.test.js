'use strict';
/*
 * The browser's side of the shared space against the real server code: three browsers (two colleagues and a
 * counterparty) work on one calculation. Also here: the server never holds anything readable.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const E = require('../app/engine.js');
const M = require('../app/model.js');
const C = require('../app/space-core.js');

const ROOT = path.resolve(__dirname, '..');
const T0 = Date.parse('2026-11-12T10:00:00Z');
const example = (id) => JSON.parse(JSON.stringify(M.examples('en').find((x) => x.id === id).calc));

async function server() {
  const { DatabaseSync } = require('node:sqlite');
  const [{ createSpaceApi }, { sqliteDb }, { MemoryStore }] = await Promise.all([
    import(path.join(ROOT, 'server/src/space.js')), import(path.join(ROOT, 'server/src/space-db.js')), import(path.join(ROOT, 'server/src/limits.js')),
  ]);
  const s = { clock: T0, requests: [] };
  const db = sqliteDb(DatabaseSync, ':memory:');
  const api = createSpaceApi({ db, now: () => s.clock, store: new MemoryStore(() => s.clock) });
  const reply = (status, body) => new Response(JSON.stringify(body), { status });
  const io = { reply, fail: (status, error, extra) => reply(status, Object.assign({ ok: false, error }, extra || {})) };
  s.fetch = (url, init) => { s.requests.push(init.method + ' ' + url.replace(/^.*\/v1\//, '') + ' ' + (init.body || '')); return api(new Request(url, init), {}, { ip: '10.0.0.9' }, io); };
  /** A browser: its own storage, the same server. */
  s.browser = () => C.create({ endpoint: 'https://stalia.example/api', engine: E, fetch: s.fetch, storage: C.memoryStorage() });
  s.dump = async () => JSON.stringify(await Promise.all(['spaces', 'members', 'invites', 'contracts', 'calcs', 'versions', 'shares', 'comments'].map((t) => db.all('SELECT * FROM ' + t, []))));
  return s;
}

test('encryption: what is sealed opens only with its key, and a changed byte is noticed', async () => {
  const k1 = C.newKey(), k2 = C.newKey();
  assert.ok(C.isKey(k1) && k1 !== k2);
  const value = { name: 'ТОО «Пример» — 例子', n: 42, list: [1, 2, 3] };
  const a = await C.seal(k1, value), b = await C.seal(k1, value);
  assert.match(a, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(a, b, 'the same text sealed twice looks different');
  assert.deepEqual(await C.open(k1, a), value);
  await assert.rejects(C.open(k2, a), { code: 'decrypt' });
  const flipped = a.slice(0, 30) + (a[30] === 'A' ? 'B' : 'A') + a.slice(31);
  await assert.rejects(C.open(k1, flipped), { code: 'decrypt' });
  await assert.rejects(C.seal('too short', value), { code: 'key' });
});

test('links: an invite carries the space’s key, a share link the key of one calculation, both after the #', () => {
  const key = C.newKey();
  const inv = C.inviteLink('https://stalia.example/app/#c=old', 'i.in_AbCdEf123456.' + 'x'.repeat(32), key);
  assert.equal(inv.split('#')[0], 'https://stalia.example/app/', 'nothing of it is in the part a server sees');
  assert.deepEqual(C.parseLink(inv), { kind: 'join', token: 'i.in_AbCdEf123456.' + 'x'.repeat(32), key });
  const sh = C.shareLink('https://stalia.example/app/', 'ca_AbCdEf123456', 's.sh_AbCdEf123456.' + 'y'.repeat(32), key);
  assert.deepEqual(C.parseLink('  ' + sh + '  '), { kind: 'open', calcId: 'ca_AbCdEf123456', token: 's.sh_AbCdEf123456.' + 'y'.repeat(32), key });
  assert.deepEqual(C.parseLink(sh.split('#')[1]), C.parseLink(sh), 'the part after # alone is enough (pasted into the app)');
  for (const bad of ['', 'https://stalia.example/app/', inv.slice(0, -1), sh.replace('~s.', '~m.'), inv.replace('#join', '#open')]) assert.equal(C.parseLink(bad), null, bad);
});

test('two colleagues and a counterparty work on one calculation', async () => {
  const s = await server();
  const aigerim = s.browser(), daniyar = s.browser(), charterer = s.browser();

  // a company space, and a colleague who joins through a link
  await aigerim.createSpace('ACME Shipping LLP', 'Aigerim');
  const invite = await aigerim.invite('editor');
  const link = C.parseLink(C.inviteLink('https://stalia.example/app/', invite.token, invite.key));
  await daniyar.join(link.token, link.key, 'Daniyar');
  const over = await daniyar.overview();
  assert.equal(over.space.name, 'ACME Shipping LLP');
  assert.deepEqual(over.members.map((m) => [m.name, m.role]), [['Aigerim', 'owner'], ['Daniyar', 'editor']]);
  assert.equal(over.me.role, 'editor');

  // Aigerim files a calculation; Daniyar sees it in the list with its result, without opening it
  const calc = example('tanker');
  const made = await aigerim.add(calc, E.compute(calc), { note: 'first count' });
  const listed = await daniyar.list();
  assert.equal(listed.length, 1);
  const total = E.compute(calc).totals;
  assert.deepEqual([listed[0].id, listed[0].head, listed[0].stale], [made.id, 1, false]);
  assert.deepEqual([listed[0].meta.vessel, listed[0].meta.status, listed[0].meta.by, listed[0].meta.sum.net, listed[0].meta.sum.outcome, listed[0].meta.period],
    [calc.meta.vessel, 'draft', 'Aigerim', total.net, total.outcome, C.periodOf(calc)]);

  // Daniyar corrects the rate and saves; Aigerim, still on version 1, is told instead of overwriting him
  const d1 = await daniyar.load(made.id);
  assert.deepEqual([d1.head, d1.n, d1.role, d1.by, d1.versions[0].note], [1, 1, 'editor', 'Aigerim', 'first count']);
  assert.deepEqual(d1.calc, calc);
  d1.calc.demurrageRate = '21000';
  assert.equal((await daniyar.save(made.id, 1, d1.calc, E.compute(d1.calc), { note: 'rate as per addendum', status: 'sent' })).head, 2);
  const hers = example('tanker');
  hers.ports[0].nor.tendered = '2026-04-02T07:00';
  await assert.rejects(aigerim.save(made.id, 1, hers, E.compute(hers), {}), (e) => e.code === 'conflict' && e.body.head === 2);
  const fresh = await aigerim.load(made.id);
  assert.equal(fresh.calc.demurrageRate, '21000');
  assert.deepEqual(fresh.versions.map((v) => [v.n, v.by, v.note]), [[2, 'Daniyar', 'rate as per addendum'], [1, 'Aigerim', 'first count']]);
  assert.ok(Math.abs(fresh.versions[0].sum.demurrage - E.compute(d1.calc).totals.demurrage) < 0.005);
  assert.equal(fresh.meta.status, 'sent');
  // what changed between the two versions
  assert.deepEqual(C.diff(await aigerim.version(made.id, 1), fresh.calc), [{ scope: 'calc', port: null, field: 'demurrageRate', from: calc.demurrageRate, to: '21000' }]);

  // a link for the charterers: they see this calculation and nothing else of the company
  const share = await aigerim.share(made.id, 'edit', 'Charterers — Mr Smith');
  const open = C.parseLink(C.shareLink('https://stalia.example/app/', share.calcId, share.token, share.key));
  charterer.rememberGuest(open.calcId, open.token, open.key, 'J. Smith, Example Trading');
  assert.equal(charterer.session(), null, 'a guest is not a member of anything');
  const theirs = await charterer.load(made.id, { guest: true });
  assert.deepEqual([theirs.guest, theirs.role, theirs.head, theirs.meta, theirs.calc.demurrageRate], [true, 'edit', 2, null, '21000']);
  await assert.rejects(charterer.list(), { code: 'auth' });
  await charterer.comment(made.id, 'We do not accept the rain on the 3rd as counting', { guest: true });
  // they add an event of their own and save: version 3, under their name
  const ev = M.blankEvent('weather', theirs.calc.ports[1].nor.tendered, theirs.calc.ports[1].completed);
  ev.desc = 'Port closed — their reading';
  theirs.calc.ports[1].events.push(ev);
  assert.equal((await charterer.save(made.id, 2, theirs.calc, E.compute(theirs.calc), { guest: true, note: 'our count' })).head, 3);

  // back in the company: the list shows there is a version newer than its entry, and a member's browser brings it up to date
  let row = (await aigerim.list())[0];
  assert.deepEqual([row.head, row.metaHead, row.stale], [3, 2, true]);
  const meta = await aigerim.refreshMeta(row);
  assert.deepEqual([meta.by, meta.guest, meta.status], ['J. Smith, Example Trading', true, 'sent']);
  row = (await daniyar.list())[0];
  assert.deepEqual([row.stale, row.meta.guest, row.meta.sum.net], [false, true, C.summaryOf(theirs.calc, E.compute(theirs.calc)).net]);
  const now = await daniyar.load(made.id);
  assert.deepEqual(now.versions.map((v) => [v.n, v.by, v.guest]), [[3, 'J. Smith, Example Trading', true], [2, 'Daniyar', false], [1, 'Aigerim', false]]);
  const changes = C.diff(await daniyar.version(made.id, 2), now.calc);
  assert.deepEqual(changes.map((c) => [c.scope, c.port, c.field, c.what]), [['event', 1, 'added', 'Port closed — their reading']]);

  // the talk under the calculation, and the counterparty agreeing to a version
  await daniyar.comment(made.id, 'Port log attached to our mail of today');
  await charterer.comment(made.id, '', { guest: true, type: 'agree', n: 3 });
  const talk = await aigerim.comments(made.id);
  assert.deepEqual(talk.map((c) => [c.by, c.guest, c.type, c.n, c.text]), [
    ['J. Smith, Example Trading', true, 'text', null, 'We do not accept the rain on the 3rd as counting'],
    ['Daniyar', false, 'text', null, 'Port log attached to our mail of today'],
    ['J. Smith, Example Trading', true, 'agree', 3, ''],
  ]);
  assert.deepEqual((await aigerim.shares(made.id)).map((x) => [x.label, x.role]), [['Charterers — Mr Smith', 'edit']]);

  // the status is changed from the list, without a new version
  row = (await aigerim.list())[0];
  await aigerim.setMeta(row, { meta: { status: 'agreed' } });
  assert.deepEqual((await daniyar.list()).map((r) => [r.head, r.meta.status]), [[3, 'agreed']]);

  // the link is withdrawn
  await aigerim.unshare(share.id);
  await assert.rejects(charterer.load(made.id, { guest: true }), { code: 'auth' });

  // ---- and through all of this the server held nothing it could read
  const stored = await s.dump(), sent = s.requests.join('\n');
  for (const secret of ['ACME', 'Aigerim', 'Daniyar', 'Smith', 'EXAMPLE SPIRIT', 'Asbatankvoy', '21000', 'rate as per addendum', 'rain on the 3rd', 'their reading', 'agree', 'sent', share.key, invite.key]) {
    assert.ok(!stored.includes(secret), 'the database holds “' + secret + '” in the clear');
    assert.ok(!sent.includes(secret), 'a request carried “' + secret + '” in the clear');
  }
});

test('contracts are kept once in the space; a recovery file brings the owner back on a new device', async () => {
  const s = await server();
  const owner = s.browser();
  await owner.createSpace('ACME Shipping LLP', 'Aigerim');
  const terms = example('tanker');
  const made = await owner.saveContract({ name: 'Novorossiysk grain 2026', counterparty: 'Example Trading', terms, clauses: 'Weather delays count as half laytime, in full on demurrage.' });
  const again = await owner.saveContract({ name: 'Novorossiysk grain 2026/27', counterparty: 'Example Trading', terms, clauses: '' }, made.id, made.rev);
  assert.equal(again.rev, 2);
  await assert.rejects(owner.saveContract({ name: 'stale' }, made.id, 1), { code: 'conflict' });
  const calc = await owner.add(terms, E.compute(terms), { contractId: made.id });
  assert.deepEqual((await owner.contracts()).map((c) => [c.id, c.rev, c.data.name]), [[made.id, 2, 'Novorossiysk grain 2026/27']]);
  assert.equal((await owner.list())[0].contractId, made.id);

  // a new device: nothing in its storage, only the recovery file
  const file = JSON.parse(JSON.stringify(owner.recovery()));
  const phone = s.browser();
  assert.throws(() => phone.restore({ stalia: 'something else' }), { code: 'bad_request' });
  phone.restore(file);
  assert.equal((await phone.overview()).space.name, 'ACME Shipping LLP');
  assert.equal((await phone.load(calc.id)).calc.meta.vessel, terms.meta.vessel);
  // a member who holds a wrong key reads nothing, and says so instead of showing rubbish
  const wrong = s.browser();
  wrong.restore(Object.assign({}, file, { key: C.newKey() }));
  assert.deepEqual(await wrong.list(), []);
  assert.equal((await wrong.overview()).space.name, '');
  await assert.rejects(wrong.load(calc.id), { code: 'decrypt' });

  await owner.remove(calc.id);
  assert.deepEqual(await owner.list(), []);
  await owner.deleteSpace();
  assert.equal(owner.session(), null);
  await assert.rejects(phone.overview(), { code: 'auth' });
});

test('a month of voyages: what a reading left to check, when each voyage began and the counterparty’s figure are kept with them', async () => {
  const s = await server();
  const aigerim = s.browser(), daniyar = s.browser(), owners = s.browser();
  await aigerim.createSpace('ACME Shipping LLP', 'Aigerim');
  const invite = await aigerim.invite('editor');
  await daniyar.join(invite.token, invite.key, 'Daniyar');

  // a scan cut into voyages: so many pages each, and any cut can be moved
  assert.deepEqual(C.evenStarts(7, 2), [0, 2, 4, 6]);
  assert.deepEqual(C.evenStarts(3, 0), [0, 1, 2], 'never fewer than one page a voyage');
  assert.deepEqual(C.groupPages(7, C.evenStarts(7, 2)), [[0, 1], [2, 3], [4, 5], [6]]);
  assert.deepEqual(C.groupPages(5, [3]), [[0, 1, 2], [3, 4]], 'the first page always starts a voyage');
  assert.deepEqual(C.groupPages(4, [9, -1, 2, 2]), [[0, 1], [2, 3]], 'cuts outside the scan are ignored');
  assert.deepEqual(C.groupPages(0, [0]), []);

  // two voyages read from a scan, each with what the reading left for a person
  const march = M.normalizeCalc(example('bulk'));
  const april = M.normalizeCalc(example('tanker'));
  const notes = [{ field: 'nor_tendered', port: 0, status: 'ambiguous', comment: 'The notice time reads 09:00 or 09:30: check it.' }];
  const first = await aigerim.add(march, E.compute(march), { notes, note: 'Read from a scan, pages 1–2' });
  const second = await aigerim.add(april, E.compute(april), { notes: [] });
  let list = await daniyar.list();
  const row = (id) => list.find((r) => r.id === id);
  assert.deepEqual([row(first.id).meta.flags, row(second.id).meta.flags], [1, 0]);
  assert.deepEqual([row(first.id).meta.start, row(second.id).meta.start], ['2026-03-06T09:00', '2026-04-02T03:00'], 'when each voyage began');
  assert.deepEqual([C.startOf(march), C.startOf({ ports: [] }), C.startOf(null)], ['2026-03-06T09:00', '', '']);
  assert.deepEqual([row(first.id).meta.claimed, row(second.id).meta.claimed], [null, null]);

  // whoever opens the voyage sees the point; saving with it dealt with clears the mark in the list
  const opened = await daniyar.load(first.id);
  assert.deepEqual(opened.notes, notes);
  assert.equal((await daniyar.load(second.id)).notes.length, 0);
  await daniyar.save(first.id, 1, opened.calc, E.compute(opened.calc), { notes: [], note: 'notice time checked' });
  list = await aigerim.list();
  assert.equal(row(first.id).meta.flags, 0);
  assert.deepEqual((await aigerim.load(first.id)).notes, []);
  assert.deepEqual((await aigerim.load(first.id, { n: 1 })).notes, notes, 'the first version still says what was open then');

  // the counterparty's figure is part of the calculation: it shows in the list as a number, typed however it was
  const withClaim = (await aigerim.load(first.id)).calc;
  withClaim.meta.claimAmount = '26 458,72';
  await aigerim.save(first.id, 2, M.normalizeCalc(withClaim), E.compute(withClaim), { note: 'Counterparty’s figure' });
  list = await daniyar.list();
  assert.equal(row(first.id).meta.claimed, 26458.72);
  assert.equal(row(second.id).meta.claimed, null);
  assert.equal((await daniyar.load(first.id)).calc.meta.claimAmount, '26 458,72');

  // the owners correct the voyage through a link; the list entry they cannot write is rebuilt with the same care
  const share = await aigerim.share(first.id, 'edit', 'Owners');
  owners.rememberGuest(first.id, share.token, share.key, 'Owners’ ops');
  const theirs = await owners.load(first.id, { guest: true });
  theirs.calc.demurrageRate = '15000';
  await owners.save(first.id, theirs.head, theirs.calc, E.compute(theirs.calc), { guest: true, note: 'rate', notes: [{ field: 'demurrage_rate', port: null, status: 'assumed', comment: 'As per addendum 3.' }] });
  list = await aigerim.list();
  assert.equal(row(first.id).stale, true);
  const meta = await aigerim.refreshMeta(row(first.id));
  assert.deepEqual([meta.flags, meta.claimed, meta.start, meta.guest, meta.sum.rate], [1, 26458.72, '2026-03-06T09:00', true, 15000]);

  // none of it is readable on the server
  const dump = await s.dump();
  for (const secret of ['09:00 or 09:30', '26458', '26 458', 'addendum', 'EXAMPLE TRADER', '2026-03-06']) assert.ok(!dump.includes(secret), secret);
});

test('what changed: terms, port facts and events are told apart', () => {
  const a = example('bulk'), b = JSON.parse(JSON.stringify(a)); // the same calculation, as it comes back from the server
  assert.deepEqual(C.diff(a, b), []);
  b.commissionPct = '5';
  b.meta.voyage = 'V.015';
  b.ports[0].nor.tendered = '2026-03-06T10:30';
  b.ports[0].nor.rule = 'nextday';
  b.ports[1].allowed.rate = '4500';
  b.ports[0].events[0].to = '2026-03-07T02:00';
  b.ports[0].events.splice(1, 1);
  const added = M.blankEvent('weather', '2026-03-09T10:00', '2026-03-09T12:00');
  added.desc = 'Rain';
  b.ports[1].events.push(added);
  const d = C.diff(a, b);
  assert.deepEqual(d.filter((x) => x.scope === 'calc').map((x) => [x.field, x.from, x.to]), [['commissionPct', a.commissionPct, '5'], ['meta.voyage', a.meta.voyage, 'V.015']]);
  assert.deepEqual(d.filter((x) => x.scope === 'port').map((x) => [x.port, x.field, x.to]), [[0, 'nor.rule', 'nextday'], [0, 'nor.tendered', '2026-03-06T10:30'], [1, 'allowed.rate', '4500']]);
  assert.deepEqual(d.filter((x) => x.scope === 'event').map((x) => [x.port, x.field, x.what]), [[0, 'changed', a.ports[0].events[0].desc], [0, 'removed', a.ports[0].events[1].desc], [1, 'added', 'Rain']]);
  const more = JSON.parse(JSON.stringify(a));
  more.ports.push(M.blankPort('discharge'));
  assert.deepEqual(C.diff(a, more).map((x) => [x.scope, x.port, x.field]), [['port', 2, 'added']]);
});
