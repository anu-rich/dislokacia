/*! Stalia — checking a counterparty's figure: which change to our own calculation would give their amount. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine.js'));
  else root.StaliaAudit = factory(root.StaliaEngine);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (E) {
  'use strict';

  const clone = (x) => JSON.parse(JSON.stringify(x));
  const round2 = (v) => Math.round(v * 100) / 100;

  /** The outcome as one signed number (demurrage +, despatch −); null while the calculation is incomplete. */
  function signedNet(calc) {
    const r = E.compute(calc);
    if (!r.ok) return null;
    const t = r.totals;
    // "net_…" outcomes: demurrage at one port set against despatch at another
    return /despatch$/.test(t.outcome) ? -Math.abs(t.net) : (/demurrage$/.test(t.outcome) ? Math.abs(t.net) : 0);
  }

  /**
   * Every single change worth trying, as { kind, port, event, value, label, apply(calc) }.
   * They are the ways two parties usually come to count the same port call differently: where laytime starts
   * and stops, whether a stoppage is deducted, by how much, and whether it is deducted on demurrage as well.
   */
  function candidates(calc) {
    const out = [];
    (calc.ports || []).forEach((p, i) => {
      const times = new Map(); // a recorded moment -> what the documents call it
      const note = (tm, label) => { if (tm && !times.has(tm)) times.set(tm, label); };
      note(p.nor.tendered, { what: 'nor' });
      note(p.commenced, { what: 'commenced' });
      for (const e of p.events || []) { note(e.from, { what: 'event', desc: e.desc, type: e.type, edge: 'from' }); note(e.to, { what: 'event', desc: e.desc, type: e.type, edge: 'to' }); }
      const startNow = p.nor.rule === 'manual' ? p.nor.manualStart : '';
      if (p.nor.rule === 'turn') {
        for (const h of ['0', '6', '12', '24']) {
          if (E.num(p.nor.turnHours) !== Number(h)) out.push({ kind: 'notice_hours', port: i, value: h, key: 'start' + i, apply: (c) => { c.ports[i].nor.turnHours = h; } });
        }
      }
      for (const [tm, label] of times) {
        if (tm !== startNow && (!p.completed || tm < p.completed)) {
          out.push({ kind: 'start_at', port: i, value: tm, label, key: 'start' + i, apply: (c) => { c.ports[i].nor.rule = 'manual'; c.ports[i].nor.manualStart = tm; } });
        }
        if (tm !== p.completed && tm > (p.nor.tendered || '') && label.what !== 'nor') {
          out.push({ kind: 'end_at', port: i, value: tm, label, key: 'end' + i, apply: (c) => { c.ports[i].completed = tm; } });
        }
      }
      (p.events || []).forEach((e, j) => {
        if (e.kind !== 'exception' || !e.from || !e.to) return;
        const ev = { desc: e.desc, type: e.type, from: e.from, to: e.to, countPct: e.countPct }, pct = E.num(e.countPct);
        for (const v of [100, 0, 50]) {
          if (pct !== v) out.push({ kind: v === 100 ? 'event_full' : (v === 0 ? 'event_none' : 'event_half'), port: i, event: ev, key: 'ev' + i + '.' + j, apply: (c) => { c.ports[i].events[j].countPct = String(v); } });
        }
        if (pct !== 100) {
          out.push({ kind: e.alsoOnDemurrage ? 'event_dem_off' : 'event_dem_on', port: i, event: ev, key: 'dem' + i + '.' + j, apply: (c) => { c.ports[i].events[j].alsoOnDemurrage = !e.alsoOnDemurrage; } });
        }
      });
    });
    out.push({ kind: calc.onceOnDemurrage ? 'once_off' : 'once_on', port: null, key: 'once', apply: (c) => { c.onceOnDemurrage = !calc.onceOnDemurrage; } });
    if (E.num(calc.commissionPct) > 0) out.push({ kind: 'no_commission', port: null, key: 'comm', apply: (c) => { c.commissionPct = ''; } });
    return out;
  }

  /**
   * Find the moment between `lo` and `hi` (minutes) at which `amountAt` reaches `target`, for an amount that
   * only falls (or only rises) as the moment moves later. @returns {number|null}
   */
  function solve(amountAt, lo, hi, target, tol) {
    let a = amountAt(lo), b = amountAt(hi);
    if (a == null || b == null) return null;
    if (Math.abs(a - target) <= tol) return lo;
    if (Math.abs(b - target) <= tol) return hi;
    if ((a - target) * (b - target) > 0) return null;
    const falling = a > b;
    for (let n = 0; n < 40 && hi - lo > 1; n++) {
      const mid = Math.floor((lo + hi) / 2), m = amountAt(mid);
      if (m == null) return null;
      if (Math.abs(m - target) <= tol) return mid;
      if ((m > target) === falling) lo = mid; else hi = mid;
    }
    return null;
  }

  /**
   * @param {object} calc     a normalised calculation that computes
   * @param {number} claimed  the counterparty's figure, signed like ours (demurrage +, despatch −)
   * @returns {null | {
   *   ours:number, claimed:number, gap:number, gapMin:(number|null), tolerance:number,
   *   matches: Array<{kinds:Array, amount:number}>,   single changes that give exactly their figure. Pairs of changes are
   *                                                   not tried: with two free choices, amounts coincide by chance too often
   *   shifts: Array<{kind:'start_shift'|'end_shift', port:number, at:string, byMin:number}>,
   *   rate: (number|null)   the daily rate at which our own time gives their figure, when it is a round one
   * }}  null when our own calculation is incomplete
   */
  function explain(calc, claimed) {
    const ours = signedNet(calc);
    if (ours == null || typeof claimed !== 'number' || !isFinite(claimed)) return null;
    const base = E.compute(calc), rate = base.totals.demRate || 0;
    // what one minute is worth in the amount that is compared: the rate, less commission
    const comm = E.num(calc.commissionPct), perMin = rate * (1 - (comm > 0 && comm < 100 ? comm : 0) / 100) / 1440;
    // two amounts are the same figure when they differ by less than a minute of demurrage (and never by less than a cent)
    const tol = Math.max(0.011, perMin * 0.99);
    const res = { ours: round2(ours), claimed: round2(claimed), gap: round2(claimed - ours), gapMin: perMin > 0 ? Math.round((claimed - ours) / perMin) : null, tolerance: tol, matches: [], shifts: [], rate: null };
    if (Math.abs(claimed - ours) <= tol) return res;

    const tryOn = (list) => { const c = clone(calc); for (const h of list) h.apply(c); return signedNet(c); };
    const show = (h) => ({ kind: h.kind, port: h.port, value: h.value, label: h.label, event: h.event });
    const cand = candidates(calc), seen = new Set();
    for (const h of cand) {
      if (seen.has(h.key)) continue; // one explanation per thing changed: the first way of putting it
      const amount = tryOn([h]);
      if (amount != null && Math.abs(amount - claimed) <= tol) { seen.add(h.key); res.matches.push({ kinds: [show(h)], amount: round2(amount) }); }
    }
    res.matches = res.matches.slice(0, 6);

    // the same gap as a shift of one moment: "as if laytime had started at …", "as if the count had stopped at …"
    (calc.ports || []).forEach((p, i) => {
      const r = base.ports[i];
      if (!r) return;
      const start = r.start, end = E.parseDT(p.completed);
      if (start != null && end != null) {
        const at = solve((m) => tryOn([{ apply: (c) => { c.ports[i].nor.rule = 'manual'; c.ports[i].nor.manualStart = E.fmtDT(m); } }]), start - 30 * 1440, end, claimed, tol);
        if (at != null && at !== start) res.shifts.push({ kind: 'start_shift', port: i, at: E.fmtDT(at), byMin: at - start });
        const stop = solve((m) => tryOn([{ apply: (c) => { c.ports[i].completed = E.fmtDT(m); } }]), start, end + 30 * 1440, claimed, tol);
        if (stop != null && stop !== end) res.shifts.push({ kind: 'end_shift', port: i, at: E.fmtDT(stop), byMin: stop - end });
      }
    });

    // the same time at another rate
    const t = base.totals, mins = t.outcome === 'demurrage' && !(t.desMin > 0 && t.despatch > 0) ? t.demMin : 0;
    if (mins > 0 && claimed > 0 && !(E.num(calc.commissionPct) > 0)) {
      const implied = claimed / (mins / 1440), near = Math.round(implied / 50) * 50;
      if (near > 0 && Math.abs(implied - near) < 0.5 && Math.abs(near - rate) >= 1) res.rate = near;
    }
    return res;
  }

  return { signedNet, candidates, explain };
});
