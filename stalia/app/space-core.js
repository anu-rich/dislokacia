/*!
 * Stalia — the shared space, without the screen: keys and encryption, the calls to the server, what a
 * list entry and a history line are made of, and the difference between two versions.
 *
 * Nothing leaves the browser unencrypted. A space has one key; every calculation has its own, kept on
 * the server wrapped with the space's key. An invite link carries the space's key, a link for a
 * counterparty carries the key of one calculation — both after the "#", which browsers do not send.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.StaliaSpaceCore = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const SESSION = 'stalia.space.v1';
  const GUESTS = 'stalia.space.guests.v1';
  const STATUSES = ['draft', 'sent', 'disputed', 'agreed'];

  // ---------------------------------------------------------------- bytes and keys
  function b64u(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function unb64u(s) {
    s = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s), out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  const subtle = () => root.crypto && root.crypto.subtle;
  const fault = (code, status, body) => Object.assign(new Error(code), { code, status: status || 0, body: body || null });
  const isKey = (k) => typeof k === 'string' && /^[A-Za-z0-9_-]{43}$/.test(k);

  /** A new 256-bit key, as text. */
  function newKey() {
    const a = new Uint8Array(32);
    root.crypto.getRandomValues(a);
    return b64u(a);
  }
  const imported = new Map();
  async function cryptoKey(key) {
    if (!isKey(key)) throw fault('key');
    if (!subtle()) throw fault('no_crypto');
    let k = imported.get(key);
    if (!k) { k = await subtle().importKey('raw', unb64u(key), 'AES-GCM', false, ['encrypt', 'decrypt']); imported.set(key, k); }
    return k;
  }
  /** Encrypt any JSON value: AES-256-GCM, a fresh nonce in front, base64url. */
  async function seal(key, value) {
    const iv = new Uint8Array(12);
    root.crypto.getRandomValues(iv);
    const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, await cryptoKey(key), new TextEncoder().encode(JSON.stringify(value))));
    const out = new Uint8Array(12 + ct.length);
    out.set(iv); out.set(ct, 12);
    return b64u(out);
  }
  /** Decrypt what seal() made. A wrong key or a changed byte throws { code: 'decrypt' }. */
  async function open(key, blob) {
    try {
      const all = unb64u(blob);
      const pt = await subtle().decrypt({ name: 'AES-GCM', iv: all.slice(0, 12) }, await cryptoKey(key), all.slice(12));
      return JSON.parse(new TextDecoder().decode(pt));
    } catch (e) { throw fault(e && e.code === 'no_crypto' ? 'no_crypto' : 'decrypt'); }
  }

  // ---------------------------------------------------------------- links
  /** `base` is the address of the calculator; what follows "#" never reaches a server. */
  const inviteLink = (base, token, key) => String(base).replace(/#.*$/, '') + '#join=' + token + '~' + key;
  const shareLink = (base, calcId, token, key) => String(base).replace(/#.*$/, '') + '#open=' + calcId + '~' + token + '~' + key;
  function parseLink(text) {
    const m = /(?:^|#)(join|open)=([A-Za-z0-9._~-]+)/.exec(String(text || '').trim());
    if (!m) return null;
    const p = m[2].split('~');
    if (m[1] === 'join' && p.length === 2 && /^i\.[\w-]+\.[\w-]+$/.test(p[0]) && isKey(p[1])) return { kind: 'join', token: p[0], key: p[1] };
    if (m[1] === 'open' && p.length === 3 && /^ca_[\w-]+$/.test(p[0]) && /^s\.[\w-]+\.[\w-]+$/.test(p[1]) && isKey(p[2])) return { kind: 'open', calcId: p[0], token: p[1], key: p[2] };
    return null;
  }

  // ---------------------------------------------------------------- what is said about a calculation without opening it
  const round2 = (v) => Math.round(v * 100) / 100;
  /** The result in a few numbers: for the list, the history and the monthly table. */
  function summaryOf(calc, result) {
    const t = result && result.ok ? result.totals : null;
    return {
      currency: (calc && calc.currency) || 'USD',
      outcome: t ? t.outcome : '',
      net: t ? round2(t.net) : null,
      demurrage: t ? round2(t.demurrage) : null,
      despatch: t ? round2(t.despatch) : null,
      demMin: t ? t.demMin : null,
      desMin: t ? t.desMin : null,
      rate: t ? t.demRate : null,
    };
  }
  /** The month a voyage belongs to: that of its first time, "YYYY-MM". */
  function periodOf(calc) {
    for (const p of (calc && calc.ports) || []) {
      for (const v of [p.nor && p.nor.tendered, p.nor && p.nor.manualStart, p.commenced, p.completed]) if (/^\d{4}-\d{2}/.test(v || '')) return String(v).slice(0, 7);
    }
    return '';
  }
  /** When a voyage began: its first recorded time, "YYYY-MM-DDTHH:MM". The list is kept in this order. */
  function startOf(calc) {
    for (const p of (calc && calc.ports) || []) {
      for (const v of [p.nor && p.nor.tendered, p.nor && p.nor.manualStart, p.commenced, p.completed]) if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v || '')) return String(v).slice(0, 16);
    }
    return '';
  }
  /**
   * The entry of a calculation in the space's list (encrypted with the space's key).
   * `extra` carries what is not in the calculation's own numbers: status, who saved it, `flags` (how many things
   * a reading left for a person to check) and `claimed` (the counterparty's figure for the voyage, a number or null).
   */
  function metaOf(calc, result, extra) {
    const m = (calc && calc.meta) || {};
    return Object.assign({
      title: (calc && calc.name) || '', vessel: m.vessel || '', voyage: m.voyage || '', charterers: m.charterers || '', owners: m.owners || '',
      ports: ((calc && calc.ports) || []).map((p) => p.name).filter(Boolean).join(' — '),
      period: periodOf(calc), start: startOf(calc), status: 'draft', sum: summaryOf(calc, result), flags: 0, claimed: null,
    }, extra || {});
  }

  // ---------------------------------------------------------------- a month's scan cut into voyages
  /** Where voyages begin when every voyage takes `per` pages: [0, per, 2·per, …]. */
  function evenStarts(pages, per) {
    const out = [];
    per = Math.max(1, Math.floor(per) || 1);
    for (let i = 0; i < pages; i += per) out.push(i);
    return out;
  }
  /** Page numbers (from 0) of each voyage, given the pages on which a voyage begins. Page 0 always begins one. */
  function groupPages(pages, starts) {
    const cut = new Set([0].concat(starts || []).filter((i) => Number.isInteger(i) && i >= 0 && i < pages)), out = [];
    for (let i = 0; i < pages; i++) { if (cut.has(i)) out.push([]); out[out.length - 1].push(i); }
    return out;
  }

  // ---------------------------------------------------------------- what changed between two versions
  const LEAVES = ['name', 'operation', 'commenced', 'completed'];
  function flat(obj, prefix, out) {
    for (const k of Object.keys(obj || {})) {
      const v = obj[k], path = prefix ? prefix + '.' + k : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) flat(v, path, out);
      else out[path] = Array.isArray(v) ? JSON.stringify(v) : (v == null ? '' : String(v));
    }
    return out;
  }
  const eventText = (e) => [e.from, e.to, e.kind === 'note' ? '' : (e.countPct === '' || e.countPct == null ? '' : e.countPct + '%'), e.alsoOnDemurrage ? 'dem' : ''].join('|');
  /**
   * @returns {Array<{scope:'calc'|'port'|'event', port:(number|null), field:string, from:string, to:string, what?:string}>}
   *   scope 'event': field is 'added' | 'removed' | 'changed', `what` is the event's wording
   */
  function diff(a, b) {
    const out = [];
    const top = (c) => { const o = Object.assign({}, c); delete o.ports; delete o.v; return flat(o, '', {}); };
    const ta = top(a), tb = top(b);
    for (const k of Array.from(new Set(Object.keys(ta).concat(Object.keys(tb)))).sort()) if ((ta[k] || '') !== (tb[k] || '')) out.push({ scope: 'calc', port: null, field: k, from: ta[k] || '', to: tb[k] || '' });
    const pa = (a && a.ports) || [], pb = (b && b.ports) || [];
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = pa[i], y = pb[i];
      if (!x || !y) { out.push({ scope: 'port', port: i, field: x ? 'removed' : 'added', from: x ? x.name || '' : '', to: y ? y.name || '' : '' }); continue; }
      const side = (p) => { const o = {}; for (const k of LEAVES) o[k] = p[k]; return Object.assign(flat(o, '', {}), flat(p.allowed, 'allowed', {}), flat(p.calendar, 'calendar', {}), flat(p.nor, 'nor', {})); };
      const fa = side(x), fb = side(y);
      for (const k of Array.from(new Set(Object.keys(fa).concat(Object.keys(fb)))).sort()) if ((fa[k] || '') !== (fb[k] || '')) out.push({ scope: 'port', port: i, field: k, from: fa[k] || '', to: fb[k] || '' });
      const ea = x.events || [], eb = y.events || [];
      const byId = (list) => { const m = new Map(); list.forEach((e, n) => m.set(e.id || 'n' + n, e)); return m; };
      const ma = byId(ea), mb = byId(eb);
      for (const [id, e] of ma) {
        const f = mb.get(id);
        if (!f) out.push({ scope: 'event', port: i, field: 'removed', what: e.desc || e.type, from: eventText(e), to: '' });
        else if (eventText(e) !== eventText(f) || (e.desc || '') !== (f.desc || '') || e.type !== f.type) out.push({ scope: 'event', port: i, field: 'changed', what: f.desc || f.type, from: eventText(e), to: eventText(f) });
      }
      for (const [id, f] of mb) if (!ma.has(id)) out.push({ scope: 'event', port: i, field: 'added', what: f.desc || f.type, from: '', to: eventText(f) });
    }
    return out;
  }

  // ---------------------------------------------------------------- storage on this device
  function memoryStorage() {
    const m = {};
    return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: (k) => { delete m[k]; } };
  }
  function safeStorage() {
    try { const ls = root.localStorage; ls.setItem('stalia.probe', '1'); ls.removeItem('stalia.probe'); return ls; } catch (e) { return memoryStorage(); }
  }

  // ---------------------------------------------------------------- the server
  function client(endpoint, fetchFn) {
    const base = String(endpoint || '').replace(/\/+$/, '') + '/v1/';
    return async function call(method, route, body, token) {
      let res, json = null;
      try {
        res = await fetchFn(base + route, {
          method,
          headers: Object.assign({}, body !== undefined ? { 'Content-Type': 'application/json' } : {}, token ? { Authorization: 'Bearer ' + token } : {}),
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
      } catch (e) { throw fault('network'); }
      try { json = await res.json(); } catch (e) { /* not JSON: a proxy's error page */ }
      if (!res.ok || !json || json.ok === false) throw fault((json && json.error) || (res.status >= 500 ? 'server' : 'bad_request'), res.status, json);
      return json;
    };
  }

  /**
   * One browser's connection to a space.
   * @param {{endpoint:string, engine:object, fetch?:Function, storage?:object}} opts
   */
  function create(opts) {
    const E = opts.engine;
    const storage = opts.storage || safeStorage();
    const call = client(opts.endpoint, opts.fetch || ((...a) => root.fetch(...a)));
    const read = (k) => { try { return JSON.parse(storage.getItem(k) || 'null'); } catch (e) { return null; } };
    const write = (k, v) => { try { v == null ? storage.removeItem(k) : storage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } };
    let ses = read(SESSION);
    if (ses && !(ses.token && isKey(ses.key))) ses = null;
    const calcKeys = new Map(); // calculation id -> its key, once unwrapped

    const need = () => { if (!ses) throw fault('auth'); return ses; };
    const remember = (r, key, name) => { ses = { spaceId: r.space.id, memberId: r.me.id, role: r.me.role, token: r.token, key, name }; write(SESSION, ses); return ses; };
    const nameOf = async (key, blob) => { try { return String((await open(key, blob)).name || ''); } catch (e) { return ''; } };

    // ---- guests: links to single calculations that were opened on this device
    const guests = () => read(GUESTS) || {};
    function guest(calcId) { const g = guests()[calcId]; return g && g.token && isKey(g.key) ? g : null; }
    function rememberGuest(calcId, token, key, name) {
      const all = guests();
      all[calcId] = Object.assign({}, all[calcId], { token, key }, name != null ? { name } : {});
      write(GUESTS, all);
      return all[calcId];
    }
    const guestName = () => { const all = guests(); for (const k of Object.keys(all)) if (all[k].name) return all[k].name; return ''; };

    /** How a calculation is reached: as a member of its space, or through a link to it. */
    async function access(calcId, asGuest) {
      if (asGuest) { const g = guest(calcId); if (!g) throw fault('auth'); return { token: g.token, key: g.key, name: g.name || guestName(), guest: true }; }
      const s = need();
      let key = calcKeys.get(calcId);
      if (!key) {
        const r = await call('GET', 'calcs/' + calcId, undefined, s.token);
        key = (await open(s.key, r.calc.key)).k;
        calcKeys.set(calcId, key);
      }
      return { token: s.token, key, name: s.name, guest: false };
    }
    const infoOf = (calc, result, name, note) => ({ by: name || '', note: String(note || '').slice(0, 300), sum: summaryOf(calc, result) });
    /** The counterparty's figure kept with a calculation, as a number; null when there is none. */
    const claimedOf = (calc) => { const n = E.num(calc && calc.meta && calc.meta.claimAmount); return isNaN(n) ? null : Math.round(n * 100) / 100; };
    /** What a reading left for a person to check travels with the version, so whoever opens it sees it. */
    const notesOf = (list) => (Array.isArray(list) ? list.slice(0, 60) : []);

    return {
      session: () => ses,
      guest, rememberGuest, guestName,
      setGuestName(name) { const all = guests(); for (const k of Object.keys(all)) all[k].name = name; write(GUESTS, all); },
      /** Forget the space on this device (the space itself stays). */
      forget() { ses = null; write(SESSION, null); calcKeys.clear(); },
      /** Everything needed to get back in, for a file kept in a safe place. */
      recovery() { const s = need(); return { stalia: 'space-recovery', v: 1, endpoint: opts.endpoint, spaceId: s.spaceId, memberId: s.memberId, token: s.token, key: s.key, name: s.name }; },
      restore(rec) {
        if (!rec || rec.stalia !== 'space-recovery' || !rec.token || !isKey(rec.key)) throw fault('bad_request');
        ses = { spaceId: rec.spaceId, memberId: rec.memberId, role: 'owner', token: rec.token, key: rec.key, name: rec.name || '' };
        write(SESSION, ses);
        return ses;
      },

      // ------------------------------------------------------------ the space and its people
      async createSpace(company, me) {
        const key = newKey();
        return remember(await call('POST', 'spaces', { name: await seal(key, { name: company }), me: await seal(key, { name: me }) }), key, me);
      },
      async join(token, key, me) {
        return remember(await call('POST', 'join', { invite: token, me: await seal(key, { name: me }) }), key, me);
      },
      async overview() {
        const s = need(), r = await call('GET', 'space', undefined, s.token);
        if (r.me.role !== s.role) { s.role = r.me.role; write(SESSION, s); }
        return {
          space: Object.assign({}, r.space, { name: await nameOf(s.key, r.space.name) }), me: r.me,
          members: await Promise.all(r.members.map(async (m) => Object.assign({}, m, { name: await nameOf(s.key, m.name) }))),
          invites: r.invites,
        };
      },
      async renameSpace(name) { const s = need(); await call('PATCH', 'space', { name: await seal(s.key, { name }) }, s.token); },
      async rename(me) { const s = need(); await call('PATCH', 'members/' + s.memberId, { me: await seal(s.key, { name: me }) }, s.token); s.name = me; write(SESSION, s); },
      async setRole(memberId, role) { await call('PATCH', 'members/' + memberId, { role }, need().token); },
      async removeMember(memberId) { await call('PATCH', 'members/' + memberId, { revoked: true }, need().token); },
      async leave() { const s = need(); await call('PATCH', 'members/' + s.memberId, { revoked: true }, s.token); this.forget(); },
      async deleteSpace() { await call('DELETE', 'space', undefined, need().token); this.forget(); },
      async invite(role, days, uses) { const s = need(), r = await call('POST', 'invites', { role, days, uses }, s.token); return Object.assign({}, r.invite, { key: s.key }); },
      async revokeInvite(id) { await call('DELETE', 'invites/' + id, undefined, need().token); },
      async licence(key) { return (await call('POST', 'space/licence', { key }, need().token)).space; },

      // ------------------------------------------------------------ contracts
      async contracts() {
        const s = need(), r = await call('GET', 'contracts', undefined, s.token), out = [];
        for (const c of r.contracts) { try { out.push(Object.assign({}, c, { data: await open(s.key, c.data) })); } catch (e) { /* written with another key: not ours to read */ } }
        return out;
      },
      async saveContract(data, id, rev) {
        const s = need(), blob = await seal(s.key, data);
        return (id ? await call('PUT', 'contracts/' + id, { data: blob, rev }, s.token) : await call('POST', 'contracts', { data: blob }, s.token)).contract;
      },
      async removeContract(id) { await call('DELETE', 'contracts/' + id, undefined, need().token); },

      // ------------------------------------------------------------ calculations
      /** Every calculation of the space, newest change first. `stale` marks an entry older than the calculation itself. */
      async list() {
        const s = need(), r = await call('GET', 'calcs', undefined, s.token), out = [];
        for (const c of r.calcs) {
          let meta = null;
          try { meta = await open(s.key, c.meta); } catch (e) { continue; }
          out.push({ id: c.id, contractId: c.contractId, head: c.head, metaHead: c.metaHead, createdAt: c.createdAt, updatedAt: c.updatedAt, stale: c.head > c.metaHead, meta });
        }
        return out;
      },
      /**
       * Bring a list entry up to date after somebody without the space's key (a counterparty) saved a version.
       * @returns the fresh meta, or null if there was nothing to do or no right to do it
       */
      async refreshMeta(entry) {
        const s = need();
        if (!entry.stale || s.role === 'viewer') return null;
        const a = await access(entry.id), v = (await call('GET', 'calcs/' + entry.id + '/versions/' + entry.head, undefined, a.token)).version;
        const data = await open(a.key, v.data);
        const meta = metaOf(data.calc, E.compute(data.calc), {
          status: entry.meta.status === 'agreed' ? 'sent' : (entry.meta.status || 'draft'), by: data.by || '', guest: /^s:/.test(v.by),
          flags: notesOf(data.notes).length, claimed: claimedOf(data.calc),
        });
        await call('PUT', 'calcs/' + entry.id + '/meta', { meta: await seal(s.key, meta), head: entry.head }, s.token);
        return meta;
      },
      /** A new calculation in the space. `o.notes`: what a reading left to check. */
      async add(calc, result, o) {
        o = o || {};
        const s = need(), key = newKey(), status = STATUSES.includes(o.status) ? o.status : 'draft', notes = notesOf(o.notes);
        const r = await call('POST', 'calcs', {
          contractId: o.contractId || '', key: await seal(s.key, { k: key }),
          meta: await seal(s.key, metaOf(calc, result, { status, by: s.name, flags: notes.length, claimed: claimedOf(calc) })),
          data: await seal(key, { calc, by: s.name, notes }), info: await seal(key, infoOf(calc, result, s.name, o.note)),
        }, s.token);
        calcKeys.set(r.calc.id, key);
        return r.calc;
      },
      /**
       * A new version on top of `base`. Throws { code: 'conflict', body: { head } } when somebody saved first.
       * A member also rewrites the list entry; a guest cannot (it is encrypted with the space's key).
       */
      async save(calcId, base, calc, result, o) {
        o = o || {};
        const a = await access(calcId, o.guest), notes = notesOf(o.notes);
        const body = { base, data: await seal(a.key, { calc, by: a.name || '', notes }), info: await seal(a.key, infoOf(calc, result, a.name, o.note)) };
        if (!a.guest) body.meta = await seal(need().key, metaOf(calc, result, { status: STATUSES.includes(o.status) ? o.status : 'draft', by: a.name, flags: notes.length, claimed: claimedOf(calc) }));
        return (await call('PUT', 'calcs/' + calcId, body, a.token)).calc;
      },
      /** A calculation with its history; `n` picks a version, otherwise the latest. */
      async load(calcId, o) {
        o = o || {};
        const a = await access(calcId, o.guest), r = (await call('GET', 'calcs/' + calcId, undefined, a.token)).calc;
        const n = o.n || r.head;
        const v = (await call('GET', 'calcs/' + calcId + '/versions/' + n, undefined, a.token)).version;
        const data = await open(a.key, v.data);
        const versions = [];
        for (const x of r.versions) {
          let info = {};
          try { if (x.info) info = await open(a.key, x.info); } catch (e) { /* an unreadable line stays empty */ }
          versions.push({ n: x.n, at: x.at, by: info.by || '', guest: /^s:/.test(x.by), ref: x.by, note: info.note || '', sum: info.sum || null });
        }
        let meta = null;
        if (!a.guest && r.meta) { try { meta = await open(need().key, r.meta); } catch (e) { /* stays null */ } }
        return { id: calcId, head: r.head, n, role: r.role, active: r.active !== false, guest: a.guest, contractId: r.contractId || '', comments: r.comments, versions, calc: data.calc, by: data.by || '', notes: notesOf(data.notes), meta };
      },
      /** Where a calculation stands now, without fetching it: for noticing that somebody else saved. */
      async peek(calcId, o) {
        const a = await access(calcId, o && o.guest), r = (await call('GET', 'calcs/' + calcId + '?brief=1', undefined, a.token)).calc;
        let info = {};
        try { if (r.versions[0] && r.versions[0].info) info = await open(a.key, r.versions[0].info); } catch (e) { /* stays empty */ }
        return { head: r.head, comments: r.comments, by: info.by || '', active: r.active !== false, role: r.role };
      },
      /** One earlier version's calculation, for comparing. */
      async version(calcId, n, o) {
        const a = await access(calcId, o && o.guest);
        return (await open(a.key, (await call('GET', 'calcs/' + calcId + '/versions/' + n, undefined, a.token)).version.data)).calc;
      },
      /** Change the list entry alone: the status, or the contract a calculation is filed under. */
      async setMeta(entry, patch) {
        const s = need(), meta = Object.assign({}, entry.meta, patch.meta || {});
        const body = { meta: await seal(s.key, meta), head: entry.head };
        if (patch.contractId !== undefined) body.contractId = patch.contractId;
        await call('PUT', 'calcs/' + entry.id + '/meta', body, s.token);
        return meta;
      },
      async remove(calcId) { await call('DELETE', 'calcs/' + calcId, undefined, need().token); calcKeys.delete(calcId); },

      // ------------------------------------------------------------ links for people outside the space
      async shares(calcId) {
        const s = need(), r = await call('GET', 'calcs/' + calcId + '/shares', undefined, s.token);
        return Promise.all(r.shares.map(async (x) => Object.assign({}, x, { label: await nameOf(s.key, x.label) })));
      },
      async share(calcId, role, label) {
        const s = need(), a = await access(calcId);
        const r = await call('POST', 'calcs/' + calcId + '/shares', { role, label: await seal(s.key, { name: label }) }, s.token);
        return Object.assign({}, r.share, { calcId, key: a.key });
      },
      async unshare(shareId) { await call('DELETE', 'shares/' + shareId, undefined, need().token); },

      // ------------------------------------------------------------ the conversation under a calculation
      async comments(calcId, o) {
        const a = await access(calcId, o && o.guest), r = await call('GET', 'calcs/' + calcId + '/comments', undefined, a.token), out = [];
        for (const c of r.comments) {
          try { const b = await open(a.key, c.body); out.push({ id: c.id, at: c.at, guest: /^s:/.test(c.by), ref: c.by, by: b.by || '', text: b.text || '', type: b.type === 'agree' ? 'agree' : 'text', n: b.n || null }); } catch (e) { /* skip */ }
        }
        return out;
      },
      /** `type` 'agree' records that the writer accepts version `n` as it stands. */
      async comment(calcId, text, o) {
        o = o || {};
        const a = await access(calcId, o.guest);
        const body = { by: a.name || '', text: String(text || '').slice(0, 2000), type: o.type === 'agree' ? 'agree' : 'text', n: o.n || null };
        return (await call('POST', 'calcs/' + calcId + '/comments', { body: await seal(a.key, body) }, a.token)).comment;
      },
    };
  }

  return { SESSION, GUESTS, STATUSES, create, client, newKey, seal, open, isKey, inviteLink, shareLink, parseLink, summaryOf, periodOf, startOf, metaOf, evenStarts, groupPages, diff, memoryStorage };
});
