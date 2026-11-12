/*
 * Stalia space: one place for a company's calculations, with their history and the people who may see them.
 *
 * What the server knows: who (an id) wrote what (a blob of so many bytes) and when. What it does not know:
 * any name, term, time or amount. Everything a person types is encrypted in their browser with a key that
 * travels only in the "#…" part of invite and share links, which browsers never send to a server.
 *
 * Who may do what:
 *   member  owner   everything, including people, invites, the licence and deleting the space
 *           editor  calculations, contracts, share links
 *           viewer  read and comment
 *   guest   a share link to ONE calculation: view | comment | edit (an edit is a new version under their name)
 *
 * A space works in full while its trial runs or a licence is attached; after that it can be read and
 * exported, and nothing more, until a licence is attached.
 *
 *   POST   /v1/spaces                     { name, me }                 -> { space, me, token }
 *   POST   /v1/join                       { invite, me }               -> { space, me, token }
 *   GET    /v1/space                                                   -> { space, me, members, invites }
 *   PATCH  /v1/space                      { name }
 *   DELETE /v1/space
 *   POST   /v1/space/licence              { key }
 *   POST   /v1/invites                    { role, days, uses }         -> { invite: { id, token, … } }
 *   DELETE /v1/invites/:id
 *   PATCH  /v1/members/:id                { role } | { revoked } | { me }
 *   GET    /v1/contracts                  POST { data }                PUT /:id { data, rev }      DELETE /:id
 *   GET    /v1/calcs                      POST { contractId, key, meta, data, info }
 *   GET    /v1/calcs/:id[?brief=1]        PUT { base, data, info, meta }   DELETE
 *          (data is the calculation; info is a few lines about the version for the history: who, why, the result)
 *   PUT    /v1/calcs/:id/meta             { meta, head, contractId }
 *   GET    /v1/calcs/:id/versions/:n
 *   GET    /v1/calcs/:id/shares           POST { role, label }         DELETE /v1/shares/:id
 *   GET    /v1/calcs/:id/comments         POST { body }
 */
import L from '../shared/license.cjs';
import { planOf, sha256Hex } from './licence.js';
import { ensureSchema } from './space-db.js';

const DAY = 86400000;
const MAX_BODY = 900000;
export const LIMITS = { small: 8000, data: 700000, members: 300, calcs: 50000, versions: 500, comments: 3000, shares: 50, invites: 50, contracts: 2000, spacesPerDay: 6 };
const MEMBER_ROLES = ['owner', 'editor', 'viewer'];
const SHARE_ROLES = ['view', 'comment', 'edit'];

const whole = (v, dflt) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? n : dflt; };
const b64u = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function random(n) { const a = new Uint8Array(n); crypto.getRandomValues(a); return b64u(a); }
const newId = (prefix) => prefix + random(9);
const newSecret = () => random(24);
/** Something encrypted in the browser: base64url text of a sane length. */
const isBlob = (v, max) => typeof v === 'string' && v.length >= 20 && v.length <= max && /^[A-Za-z0-9_-]+$/.test(v);
const TOKEN = /^([mis])\.([A-Za-z0-9_-]{6,40})\.([A-Za-z0-9_-]{20,60})$/;

/**
 * @param {{db: object, store?: object, now?: Function, fetch?: Function}} deps
 * @returns {(request: Request, env: object, ctx: {ip?: string}, io: {reply: Function, fail: Function}) => Promise<Response>}
 */
export function createSpaceApi(deps) {
  const d = Object.assign({}, deps);
  if (!d.now) d.now = Date.now;
  if (!d.fetch) d.fetch = (...a) => fetch(...a);
  if (!d.db) throw new Error('createSpaceApi needs a database');
  const db = d.db;
  let ready = null;

  return async function handle(request, env, ctx, io) {
    env = env || {}; ctx = ctx || {};
    const { reply, fail } = io;
    if (!ready) ready = ensureSchema(db).catch((e) => { ready = null; throw e; });
    await ready;

    const now = d.now();
    const method = request.method;
    const url = new URL(request.url);
    const seg = url.pathname.replace(/^.*?\/v1\//, '').split('/').filter(Boolean);
    const at = (...names) => seg.length === names.length && names.every((n, i) => n === '*' || n === seg[i]);

    let body = {};
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      let raw;
      try { raw = await request.text(); } catch (e) { return fail(400, 'bad_request'); }
      if (raw.length > MAX_BODY) return fail(413, 'too_big');
      try { body = raw ? JSON.parse(raw) : {}; } catch (e) { return fail(400, 'bad_request'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'bad_request');
    }

    const spaceOf = (id) => db.get('SELECT * FROM spaces WHERE id = ?', [id]);
    const isActive = (sp) => now < sp.trial_until || now < sp.paid_until;
    const spaceView = (sp) => ({ id: sp.id, name: sp.name_enc, createdAt: sp.created_at, trialUntil: sp.trial_until, paidUntil: sp.paid_until, active: isActive(sp) });
    const count = async (sql, params) => Number((await db.get(sql, params)).n);

    // ------------------------------------------------------------ no token needed: a new space, joining one
    if (method === 'POST' && at('spaces')) {
      if (!isBlob(body.name, LIMITS.small) || !isBlob(body.me, LIMITS.small)) return fail(400, 'bad_request');
      if (d.store) {
        // a handful a day from one address is plenty for people and too few for a script
        const who = (await sha256Hex(String(env.IP_SALT || 'stalia') + '|' + (ctx.ip || 'unknown'))).slice(0, 32);
        const made = await d.store.add('space:' + new Date(now).toISOString().slice(0, 10) + ':' + who, 1, 2 * 86400);
        if (made > whole(env.SPACES_PER_DAY, LIMITS.spacesPerDay)) return fail(429, 'limit');
      }
      const id = newId('sp_'), memberId = newId('mb_'), secret = newSecret();
      await db.run('INSERT INTO spaces (id, name_enc, created_at, trial_until) VALUES (?, ?, ?, ?)', [id, body.name, now, now + whole(env.SPACE_TRIAL_DAYS, 14) * DAY]);
      await db.run('INSERT INTO members (id, space_id, role, name_enc, token_hash, created_at, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [memberId, id, 'owner', body.me, await sha256Hex(secret), now, now]);
      return reply(200, { ok: true, space: spaceView(await spaceOf(id)), me: { id: memberId, role: 'owner' }, token: 'm.' + memberId + '.' + secret });
    }

    if (method === 'POST' && at('join')) {
      const m = TOKEN.exec(String(body.invite || ''));
      if (!m || m[1] !== 'i' || !isBlob(body.me, LIMITS.small)) return fail(400, 'bad_request');
      const inv = await db.get('SELECT * FROM invites WHERE id = ?', [m[2]]);
      if (!inv || inv.revoked_at || inv.secret_hash !== (await sha256Hex(m[3]))) return fail(404, 'invite');
      if (inv.expires_at <= now || inv.uses_left <= 0) return fail(410, 'invite_used');
      const sp = await spaceOf(inv.space_id);
      if (!sp) return fail(404, 'invite');
      if ((await count('SELECT COUNT(*) AS n FROM members WHERE space_id = ? AND revoked_at = 0', [sp.id])) >= LIMITS.members) return fail(400, 'full');
      // the use is taken first, so two people opening the last one at the same moment cannot both get in
      if (!(await db.run('UPDATE invites SET uses_left = uses_left - 1 WHERE id = ? AND uses_left > 0', [inv.id])).changes) return fail(410, 'invite_used');
      const memberId = newId('mb_'), secret = newSecret();
      await db.run('INSERT INTO members (id, space_id, role, name_enc, token_hash, created_at, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [memberId, sp.id, inv.role, body.me, await sha256Hex(secret), now, now]);
      return reply(200, { ok: true, space: spaceView(sp), me: { id: memberId, role: inv.role }, token: 'm.' + memberId + '.' + secret });
    }

    // ------------------------------------------------------------ who is asking
    const tok = TOKEN.exec((request.headers.get('authorization') || '').replace(/^Bearer\s+/i, ''));
    let me = null;
    if (tok && tok[1] === 'm') {
      const r = await db.get('SELECT id, space_id, role, token_hash, revoked_at, seen_at FROM members WHERE id = ?', [tok[2]]);
      if (r && !r.revoked_at && r.token_hash === (await sha256Hex(tok[3]))) me = { kind: 'member', id: r.id, spaceId: r.space_id, role: r.role, seenAt: r.seen_at };
    } else if (tok && tok[1] === 's') {
      const r = await db.get('SELECT id, space_id, calc_id, role, secret_hash, revoked_at, seen_at FROM shares WHERE id = ?', [tok[2]]);
      if (r && !r.revoked_at && r.secret_hash === (await sha256Hex(tok[3]))) me = { kind: 'guest', id: r.id, spaceId: r.space_id, calcId: r.calc_id, role: r.role, seenAt: r.seen_at };
    }
    if (!me) return fail(401, 'auth');
    const sp = await spaceOf(me.spaceId);
    if (!sp) return fail(401, 'auth');
    const member = me.kind === 'member', owner = member && me.role === 'owner', editor = member && (me.role === 'owner' || me.role === 'editor');
    const active = isActive(sp);
    if (now - me.seenAt > 3600000) await db.run('UPDATE ' + (member ? 'members' : 'shares') + ' SET seen_at = ? WHERE id = ?', [now, me.id]);
    const author = [member ? 'm' : 's', me.id];
    const locked = () => fail(402, 'plan', { space: spaceView(sp) });

    /** The calculation, if the caller may see it. */
    async function calcFor(id) {
      const c = await db.get('SELECT * FROM calcs WHERE id = ?', [id]);
      if (!c || c.space_id !== me.spaceId || c.deleted_at) return null;
      if (!member && c.id !== me.calcId) return null;
      return c;
    }
    const calcRow = (c) => ({ id: c.id, contractId: c.contract_id, key: c.key_wrapped, meta: c.meta_enc, metaHead: c.meta_head, head: c.head, createdAt: c.created_at, updatedAt: c.updated_at });

    // ------------------------------------------------------------ the space and its people
    if (seg[0] === 'space') {
      if (!member) return fail(403, 'forbidden');
      if (method === 'GET' && at('space')) {
        const members = await db.all('SELECT id, role, name_enc, created_at, seen_at, revoked_at FROM members WHERE space_id = ? ORDER BY created_at', [sp.id]);
        const invites = owner ? await db.all('SELECT id, role, created_at, expires_at, uses_left FROM invites WHERE space_id = ? AND revoked_at = 0 AND expires_at > ? AND uses_left > 0 ORDER BY created_at', [sp.id, now]) : [];
        return reply(200, {
          ok: true, space: spaceView(sp), me: { id: me.id, role: me.role },
          members: members.filter((m) => !m.revoked_at).map((m) => ({ id: m.id, role: m.role, name: m.name_enc, createdAt: m.created_at, seenAt: m.seen_at })),
          invites: invites.map((i) => ({ id: i.id, role: i.role, createdAt: i.created_at, expiresAt: i.expires_at, usesLeft: i.uses_left })),
        });
      }
      if (method === 'PATCH' && at('space')) {
        if (!owner) return fail(403, 'forbidden');
        if (!isBlob(body.name, LIMITS.small)) return fail(400, 'bad_request');
        await db.run('UPDATE spaces SET name_enc = ? WHERE id = ?', [body.name, sp.id]);
        return reply(200, { ok: true, space: spaceView(await spaceOf(sp.id)) });
      }
      if (method === 'DELETE' && at('space')) {
        if (!owner) return fail(403, 'forbidden');
        for (const t of ['comments', 'versions']) await db.run('DELETE FROM ' + t + ' WHERE calc_id IN (SELECT id FROM calcs WHERE space_id = ?)', [sp.id]);
        for (const t of ['shares', 'calcs', 'contracts', 'invites', 'members']) await db.run('DELETE FROM ' + t + ' WHERE space_id = ?', [sp.id]);
        await db.run('DELETE FROM spaces WHERE id = ?', [sp.id]);
        return reply(200, { ok: true });
      }
      if (method === 'POST' && at('space', 'licence')) {
        if (!owner) return fail(403, 'forbidden');
        const key = String(body.key || '').trim();
        const lic = await planOf(key, env, d);
        if (lic.plan !== 'pro') return fail(400, 'licence');
        // one licence, one company
        if (await count('SELECT COUNT(*) AS n FROM spaces WHERE licence_id = ? AND id <> ?', [lic.id, sp.id])) return fail(409, 'licence_used');
        let until = now + 32 * DAY; // a key from the shop is asked about again every month, by whoever holds it
        if (L.isOfflineKey(key)) {
          try {
            const p = JSON.parse(new TextDecoder().decode(L.b64uToBytes(key.split('.')[1])));
            until = p.exp ? L.expiryMs(p.exp) : now + 3650 * DAY;
          } catch (e) { return fail(400, 'licence'); }
        }
        await db.run('UPDATE spaces SET paid_until = ?, licence_id = ? WHERE id = ?', [until, lic.id, sp.id]);
        return reply(200, { ok: true, space: spaceView(await spaceOf(sp.id)) });
      }
      return fail(404, 'not_found');
    }

    if (seg[0] === 'invites') {
      if (!owner) return fail(403, 'forbidden');
      if (method === 'POST' && at('invites')) {
        if (!active) return locked();
        if (!MEMBER_ROLES.includes(body.role)) return fail(400, 'bad_request');
        if ((await count('SELECT COUNT(*) AS n FROM invites WHERE space_id = ? AND revoked_at = 0 AND expires_at > ? AND uses_left > 0', [sp.id, now])) >= LIMITS.invites) return fail(400, 'full');
        const id = newId('in_'), secret = newSecret();
        const days = Math.min(90, Math.max(1, whole(body.days, 14))), uses = Math.min(200, Math.max(1, whole(body.uses, 20)));
        await db.run('INSERT INTO invites (id, space_id, role, secret_hash, created_by, created_at, expires_at, uses_left) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [id, sp.id, body.role, await sha256Hex(secret), me.id, now, now + days * DAY, uses]);
        return reply(200, { ok: true, invite: { id, role: body.role, token: 'i.' + id + '.' + secret, createdAt: now, expiresAt: now + days * DAY, usesLeft: uses } });
      }
      if (method === 'DELETE' && at('invites', '*')) {
        await db.run('UPDATE invites SET revoked_at = ? WHERE id = ? AND space_id = ?', [now, seg[1], sp.id]);
        return reply(200, { ok: true });
      }
      return fail(404, 'not_found');
    }

    if (seg[0] === 'members' && method === 'PATCH' && at('members', '*')) {
      if (!member) return fail(403, 'forbidden');
      const target = await db.get('SELECT id, role, revoked_at FROM members WHERE id = ? AND space_id = ?', [seg[1], sp.id]);
      if (!target || target.revoked_at) return fail(404, 'not_found');
      const self = target.id === me.id;
      const owners = () => count("SELECT COUNT(*) AS n FROM members WHERE space_id = ? AND role = 'owner' AND revoked_at = 0", [sp.id]);
      if (body.me !== undefined) {
        if (!self || !isBlob(body.me, LIMITS.small)) return fail(self ? 400 : 403, self ? 'bad_request' : 'forbidden');
        await db.run('UPDATE members SET name_enc = ? WHERE id = ?', [body.me, me.id]);
      }
      if (body.role !== undefined) {
        if (!owner) return fail(403, 'forbidden');
        if (!MEMBER_ROLES.includes(body.role)) return fail(400, 'bad_request');
        if (target.role === 'owner' && body.role !== 'owner' && (await owners()) <= 1) return fail(409, 'last_owner');
        await db.run('UPDATE members SET role = ? WHERE id = ?', [body.role, target.id]);
      }
      if (body.revoked === true) {
        if (!owner && !self) return fail(403, 'forbidden');
        if (target.role === 'owner' && (await owners()) <= 1) return fail(409, 'last_owner');
        await db.run('UPDATE members SET revoked_at = ? WHERE id = ?', [now, target.id]);
      }
      return reply(200, { ok: true });
    }

    // ------------------------------------------------------------ contracts: the terms, entered and checked once
    if (seg[0] === 'contracts') {
      if (!member) return fail(403, 'forbidden');
      if (method === 'GET' && at('contracts')) {
        const rows = await db.all('SELECT id, data_enc, rev, created_at, updated_at, updated_by FROM contracts WHERE space_id = ? AND deleted_at = 0 ORDER BY created_at', [sp.id]);
        return reply(200, { ok: true, contracts: rows.map((c) => ({ id: c.id, data: c.data_enc, rev: c.rev, createdAt: c.created_at, updatedAt: c.updated_at, updatedBy: c.updated_by })) });
      }
      if (!editor) return fail(403, 'forbidden');
      if (method === 'DELETE' && at('contracts', '*')) {
        await db.run('UPDATE contracts SET deleted_at = ? WHERE id = ? AND space_id = ?', [now, seg[1], sp.id]);
        return reply(200, { ok: true });
      }
      if (!active) return locked();
      if (method === 'POST' && at('contracts')) {
        if (!isBlob(body.data, LIMITS.data)) return fail(400, 'bad_request');
        if ((await count('SELECT COUNT(*) AS n FROM contracts WHERE space_id = ? AND deleted_at = 0', [sp.id])) >= LIMITS.contracts) return fail(400, 'full');
        const id = newId('ct_');
        await db.run('INSERT INTO contracts (id, space_id, data_enc, rev, created_at, updated_at, updated_by) VALUES (?, ?, ?, 1, ?, ?, ?)', [id, sp.id, body.data, now, now, me.id]);
        return reply(200, { ok: true, contract: { id, rev: 1, createdAt: now, updatedAt: now } });
      }
      if (method === 'PUT' && at('contracts', '*')) {
        if (!isBlob(body.data, LIMITS.data) || !Number.isInteger(body.rev)) return fail(400, 'bad_request');
        const done = await db.run('UPDATE contracts SET data_enc = ?, rev = rev + 1, updated_at = ?, updated_by = ? WHERE id = ? AND space_id = ? AND rev = ? AND deleted_at = 0',
          [body.data, now, me.id, seg[1], sp.id, body.rev]);
        if (!done.changes) {
          const cur = await db.get('SELECT rev FROM contracts WHERE id = ? AND space_id = ? AND deleted_at = 0', [seg[1], sp.id]);
          return cur ? fail(409, 'conflict', { rev: cur.rev }) : fail(404, 'not_found');
        }
        return reply(200, { ok: true, contract: { id: seg[1], rev: body.rev + 1, updatedAt: now } });
      }
      return fail(404, 'not_found');
    }

    // ------------------------------------------------------------ share links are revoked by their own id
    if (seg[0] === 'shares' && method === 'DELETE' && at('shares', '*')) {
      if (!editor) return fail(403, 'forbidden');
      await db.run('UPDATE shares SET revoked_at = ? WHERE id = ? AND space_id = ?', [now, seg[1], sp.id]);
      return reply(200, { ok: true });
    }

    // ------------------------------------------------------------ calculations
    if (seg[0] !== 'calcs') return fail(404, 'not_found');

    if (at('calcs')) {
      if (!member) return fail(403, 'forbidden');
      if (method === 'GET') {
        const rows = await db.all('SELECT * FROM calcs WHERE space_id = ? AND deleted_at = 0 ORDER BY updated_at DESC LIMIT 5000', [sp.id]);
        return reply(200, { ok: true, calcs: rows.map(calcRow) });
      }
      if (method === 'POST') {
        if (!editor) return fail(403, 'forbidden');
        if (!active) return locked();
        if (!isBlob(body.key, LIMITS.small) || !isBlob(body.meta, LIMITS.small) || !isBlob(body.data, LIMITS.data)) return fail(400, 'bad_request');
        if (body.info !== undefined && !isBlob(body.info, LIMITS.small)) return fail(400, 'bad_request');
        const contractId = String(body.contractId || '');
        if (contractId && !(await db.get('SELECT id FROM contracts WHERE id = ? AND space_id = ? AND deleted_at = 0', [contractId, sp.id]))) return fail(400, 'bad_request');
        if ((await count('SELECT COUNT(*) AS n FROM calcs WHERE space_id = ? AND deleted_at = 0', [sp.id])) >= LIMITS.calcs) return fail(400, 'full');
        const id = newId('ca_');
        await db.run('INSERT INTO calcs (id, space_id, contract_id, key_wrapped, meta_enc, meta_head, head, created_at, created_by, updated_at) VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?, ?)',
          [id, sp.id, contractId, body.key, body.meta, now, me.id, now]);
        await db.run('INSERT INTO versions (calc_id, n, data_enc, info_enc, author_kind, author_ref, created_at) VALUES (?, 1, ?, ?, ?, ?, ?)', [id, body.data, body.info || '', author[0], author[1], now]);
        return reply(200, { ok: true, calc: { id, head: 1, createdAt: now, updatedAt: now } });
      }
      return fail(405, 'bad_request');
    }

    const calc = await calcFor(seg[1]);
    if (!calc) return fail(404, 'not_found');
    const mayComment = member || me.role === 'comment' || me.role === 'edit';
    const mayWrite = editor || (!member && me.role === 'edit');

    if (at('calcs', '*')) {
      if (method === 'GET') {
        // "?brief=1": where the calculation stands, for a page that only wants to know whether somebody saved
        const brief = url.searchParams.get('brief') === '1';
        const versions = await db.all('SELECT n, info_enc, created_at, author_kind, author_ref, LENGTH(data_enc) AS size FROM versions WHERE calc_id = ? ORDER BY n DESC' + (brief ? ' LIMIT 1' : ''), [calc.id]);
        const out = {
          id: calc.id, head: calc.head, createdAt: calc.created_at, updatedAt: calc.updated_at, role: me.role, active,
          versions: versions.map((v) => ({ n: v.n, at: v.created_at, by: v.author_kind + ':' + v.author_ref, size: v.size, info: v.info_enc })),
          comments: await count('SELECT COUNT(*) AS n FROM comments WHERE calc_id = ?', [calc.id]),
        };
        // the wrapped key and the list entry are for the space: a guest's link carries the key of this one calculation
        if (member) Object.assign(out, { contractId: calc.contract_id, key: calc.key_wrapped, meta: calc.meta_enc, metaHead: calc.meta_head });
        return reply(200, { ok: true, calc: out });
      }
      if (method === 'PUT') {
        if (!mayWrite) return fail(403, 'forbidden');
        if (!active) return locked();
        if (!Number.isInteger(body.base) || !isBlob(body.data, LIMITS.data)) return fail(400, 'bad_request');
        if (body.meta !== undefined && (!member || !isBlob(body.meta, LIMITS.small))) return fail(400, 'bad_request');
        if (body.info !== undefined && !isBlob(body.info, LIMITS.small)) return fail(400, 'bad_request');
        if (body.base !== calc.head) return fail(409, 'conflict', { head: calc.head });
        if (calc.head >= LIMITS.versions) return fail(400, 'full');
        const n = calc.head + 1;
        // the row's key is (calculation, number): of two people saving on top of the same version, one gets it
        const put = await db.run('INSERT OR IGNORE INTO versions (calc_id, n, data_enc, info_enc, author_kind, author_ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [calc.id, n, body.data, body.info || '', author[0], author[1], now]);
        if (!put.changes) return fail(409, 'conflict', { head: (await db.get('SELECT head FROM calcs WHERE id = ?', [calc.id])).head });
        if (body.meta !== undefined) await db.run('UPDATE calcs SET head = ?, updated_at = ?, meta_enc = ?, meta_head = ? WHERE id = ? AND head < ?', [n, now, body.meta, n, calc.id, n]);
        else await db.run('UPDATE calcs SET head = ?, updated_at = ? WHERE id = ? AND head < ?', [n, now, calc.id, n]);
        return reply(200, { ok: true, calc: { id: calc.id, head: n, updatedAt: now } });
      }
      if (method === 'DELETE') {
        if (!editor) return fail(403, 'forbidden');
        await db.run('UPDATE calcs SET deleted_at = ?, updated_at = ? WHERE id = ?', [now, now, calc.id]);
        await db.run('UPDATE shares SET revoked_at = ? WHERE calc_id = ? AND revoked_at = 0', [now, calc.id]);
        return reply(200, { ok: true });
      }
      return fail(405, 'bad_request');
    }

    if (method === 'PUT' && at('calcs', '*', 'meta')) {
      // the line in the list: a member's browser rewrites it after a guest's edit, or when the status changes
      if (!editor) return fail(403, 'forbidden');
      if (!active) return locked();
      if (!isBlob(body.meta, LIMITS.small) || !Number.isInteger(body.head) || body.head < 1 || body.head > calc.head) return fail(400, 'bad_request');
      let contractId = calc.contract_id;
      if (body.contractId !== undefined) {
        contractId = String(body.contractId || '');
        if (contractId && !(await db.get('SELECT id FROM contracts WHERE id = ? AND space_id = ? AND deleted_at = 0', [contractId, sp.id]))) return fail(400, 'bad_request');
      }
      await db.run('UPDATE calcs SET meta_enc = ?, meta_head = ?, contract_id = ? WHERE id = ?', [body.meta, body.head, contractId, calc.id]);
      return reply(200, { ok: true });
    }

    if (method === 'GET' && at('calcs', '*', 'versions', '*')) {
      const v = await db.get('SELECT n, data_enc, info_enc, author_kind, author_ref, created_at FROM versions WHERE calc_id = ? AND n = ?', [calc.id, whole(seg[3], -1)]);
      if (!v) return fail(404, 'not_found');
      return reply(200, { ok: true, version: { n: v.n, data: v.data_enc, info: v.info_enc, at: v.created_at, by: v.author_kind + ':' + v.author_ref } });
    }

    if (at('calcs', '*', 'shares')) {
      if (!member) return fail(403, 'forbidden');
      if (method === 'GET') {
        const rows = await db.all('SELECT id, role, label_enc, created_at, seen_at FROM shares WHERE calc_id = ? AND revoked_at = 0 ORDER BY created_at', [calc.id]);
        return reply(200, { ok: true, shares: rows.map((s) => ({ id: s.id, role: s.role, label: s.label_enc, createdAt: s.created_at, seenAt: s.seen_at })) });
      }
      if (method === 'POST') {
        if (!editor) return fail(403, 'forbidden');
        if (!active) return locked();
        if (!SHARE_ROLES.includes(body.role) || !isBlob(body.label, LIMITS.small)) return fail(400, 'bad_request');
        if ((await count('SELECT COUNT(*) AS n FROM shares WHERE calc_id = ? AND revoked_at = 0', [calc.id])) >= LIMITS.shares) return fail(400, 'full');
        const id = newId('sh_'), secret = newSecret();
        await db.run('INSERT INTO shares (id, calc_id, space_id, role, label_enc, secret_hash, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [id, calc.id, sp.id, body.role, body.label, await sha256Hex(secret), me.id, now]);
        return reply(200, { ok: true, share: { id, role: body.role, token: 's.' + id + '.' + secret, createdAt: now } });
      }
      return fail(405, 'bad_request');
    }

    if (at('calcs', '*', 'comments')) {
      if (method === 'GET') {
        const rows = await db.all('SELECT id, body_enc, author_kind, author_ref, created_at FROM comments WHERE calc_id = ? ORDER BY created_at LIMIT ?', [calc.id, LIMITS.comments]);
        return reply(200, { ok: true, comments: rows.map((c) => ({ id: c.id, body: c.body_enc, at: c.created_at, by: c.author_kind + ':' + c.author_ref })) });
      }
      if (method === 'POST') {
        if (!mayComment) return fail(403, 'forbidden');
        if (!active) return locked();
        if (!isBlob(body.body, LIMITS.small)) return fail(400, 'bad_request');
        if ((await count('SELECT COUNT(*) AS n FROM comments WHERE calc_id = ?', [calc.id])) >= LIMITS.comments) return fail(400, 'full');
        const id = newId('cm_');
        await db.run('INSERT INTO comments (id, calc_id, body_enc, author_kind, author_ref, created_at) VALUES (?, ?, ?, ?, ?, ?)', [id, calc.id, body.body, author[0], author[1], now]);
        return reply(200, { ok: true, comment: { id, at: now, by: author[0] + ':' + author[1] } });
      }
      return fail(405, 'bad_request');
    }

    return fail(404, 'not_found');
  };
}
