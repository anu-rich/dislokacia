/*
 * Made-up shipping documents for the browser checks: a fixture recap with rider clauses (PDF, two pages)
 * and statements of facts for two ports (images). They describe exactly the built-in "bulk" example, so a
 * reader that gets them right must arrive at the same result: demurrage USD 23,841.93.
 *
 *   const docs = await makeSampleDocs(browser, outDir);   // { cpPdf, sofLoad, sofDischarge, sofHand, cpPages: [png, png] }
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const PAGE_CSS = `
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: #fff; color: #111; }
  .sheet { width: 210mm; min-height: 297mm; padding: 16mm 17mm; page-break-after: always; }
  .mono { font: 10.5pt/1.5 "DejaVu Sans Mono", "Liberation Mono", monospace; white-space: pre-wrap; }
  .serif { font: 11pt/1.45 "Liberation Serif", "DejaVu Serif", serif; }
  h1 { font-size: 15pt; margin: 0 0 3mm; letter-spacing: 0.04em; }
  h2 { font-size: 11.5pt; margin: 6mm 0 1.5mm; }
  p { margin: 0 0 2.5mm; }
  table { border-collapse: collapse; width: 100%; margin-top: 4mm; }
  th, td { border: 1px solid #444; padding: 1.6mm 2mm; text-align: left; vertical-align: top; font-size: 10pt; }
  th { background: #eee; }
  td.t { white-space: nowrap; font-family: "DejaVu Sans Mono", monospace; font-size: 9.5pt; }
  .head td { border: 0; padding: 0.6mm 0; font-size: 10.5pt; }
  .sign { display: flex; justify-content: space-between; margin-top: 14mm; font-size: 10pt; }
  .sign div { width: 45%; border-top: 1px solid #444; padding-top: 1.5mm; }
`;

const RECAP = `From: chartering@broker.example
To: ops@example-trading.example
Subject: MV EXAMPLE TRADER / EXAMPLE TRADING - CLEAN RECAP

WE ARE PLEASED TO CONFIRM THE FOLLOWING FIXTURE CONCLUDED ON 20 FEBRUARY 2026
WITH ALL SUBJECTS LIFTED:

01. VESSEL:        MV EXAMPLE TRADER - GEARED BULK CARRIER, 28,400 MT DWAT, BUILT 2011
02. OWNERS:        EXAMPLE SHIPPING CO.
03. CHARTERERS:    EXAMPLE TRADING LTD.
04. CARGO:         27,500 MT WHEAT IN BULK, 5 PCT MORE OR LESS IN OWNERS' OPTION
05. LOADING PORT:  1 SAFE BERTH NOVOROSSIYSK
06. DISCH. PORT:   1 SAFE BERTH ALEXANDRIA
07. LAYCAN:        5-9 MARCH 2026
08. LOADING RATE:  8,000 MT PER WEATHER WORKING DAY OF 24 CONSECUTIVE HOURS,
                   SATURDAYS, SUNDAYS AND HOLIDAYS EXCEPTED UNLESS USED, IN WHICH
                   CASE ACTUAL TIME USED TO COUNT (SSHEX UU)
09. DISCH. RATE:   5,000 MT PER WEATHER WORKING DAY OF 24 CONSECUTIVE HOURS,
                   FRIDAYS AND HOLIDAYS EXCEPTED EVEN IF USED (FHEX EIU)
10. LAYTIME NON-REVERSIBLE BETWEEN LOADING AND DISCHARGING PORTS
11. FREIGHT:       USD 24.75 PER METRIC TON FIOST, BASIS 1/1
12. DEMURRAGE:     USD 14,500 PER DAY OR PRO RATA.
    DESPATCH:      HALF DEMURRAGE ON WORKING TIME SAVED BOTH ENDS (DHD WTS BENDS)
13. COMMISSION:    3.75 PCT TOTAL ON FREIGHT, DEADFREIGHT AND DEMURRAGE
14. OTHERWISE AS PER GENCON 1994 CHARTER PARTY WITH LOGICAL AMENDMENTS AND
    THE RIDER CLAUSES ATTACHED

END OF RECAP. PLEASE CONFIRM ALL IN ORDER.
BEST REGARDS / CHARTERING DESK`;

const RIDER = `
<h1>RIDER CLAUSES</h1>
<p>to the charter party dated 20 February 2026 — MV EXAMPLE TRADER</p>
<h2>Clause 19 — Notice of readiness and commencement of laytime</h2>
<p>At both ends notice of readiness may be tendered by e-mail, whether in berth or not, whether in port or not. Laytime shall commence at 13:00 hours if notice of readiness is given up to and including 12:00 hours, and at 08:00 hours on the next working day if notice is given after 12:00 hours, unless sooner commenced, in which case actual time used to count.</p>
<p>At the loading port notice of readiness is to be tendered within office hours, 08:00 to 17:00 Monday to Friday and 08:00 to 12:00 on Saturday.</p>
<h2>Clause 20 — Shifting</h2>
<p>Time used in shifting from the anchorage or waiting place to the loading or discharging berth shall not count as laytime.</p>
<h2>Clause 21 — Weather</h2>
<p>Laytime shall not count during periods in which loading or discharging is prevented by bad weather.</p>
<h2>Clause 22 — Vessel's gear</h2>
<p>Time lost by reason of breakdown of the vessel's cranes or other gear shall not count as laytime nor as time on demurrage.</p>
<h2>Clause 23 — Demurrage</h2>
<p>Once on demurrage, always on demurrage.</p>
<h2>Clause 24 — Waiting for berth</h2>
<p>Time lost in waiting for berth shall count as laytime, subject to the exceptions of this charter party.</p>
`;

const head = (port, operation) => `
<h1>STATEMENT OF FACTS</h1>
<table class="head">
  <tr><td>Port:</td><td><b>${port}</b></td><td>Operation:</td><td><b>${operation}</b></td></tr>
  <tr><td>Vessel:</td><td><b>MV EXAMPLE TRADER</b></td><td>Voyage:</td><td><b>V.014</b></td></tr>
  <tr><td>Cargo:</td><td colspan="3"><b>27,500 MT wheat in bulk</b> — bill of lading quantity 27,500.000 MT</td></tr>
</table>`;
const rows = (list, cls) => '<table><tr><th>Date</th><th>Day</th><th>From</th><th>To</th><th>Remarks</th></tr>' +
  list.map((r) => `<tr><td class="t ${cls || ''}">${r[0]}</td><td class="${cls || ''}">${r[1]}</td><td class="t ${cls || ''}">${r[2]}</td><td class="t ${cls || ''}">${r[3]}</td><td class="${cls || ''}">${r[4]}</td></tr>`).join('') + '</table>';
const SIGN = '<div class="sign"><div>Master / for Owners</div><div>Agents / for Charterers</div></div>';

const LOAD_ROWS = [
  ['06.03.2026', 'Fri', '07:30', '', 'Vessel arrived at Novorossiysk roads and anchored'],
  ['06.03.2026', 'Fri', '09:00', '', 'Notice of readiness tendered by e-mail'],
  ['06.03.2026', 'Fri', '10:30', '12:40', 'Shifting from anchorage to berth No. 21; all fast 12:40'],
  ['06.03.2026', 'Fri', '14:00', '', 'Initial draft survey completed'],
  ['06.03.2026', 'Fri', '14:10', '', 'Loading commenced'],
  ['06.03.2026', 'Fri', '14:10', '24:00', 'Loading'],
  ['07.03.2026', 'Sat', '00:00', '08:00', 'No cargo work'],
  ['07.03.2026', 'Sat', '08:00', '20:00', 'Loading continued on Saturday (overtime ordered by shippers)'],
  ['07.03.2026', 'Sat', '20:00', '24:00', 'No cargo work — weekend'],
  ['08.03.2026', 'Sun', '00:00', '24:00', 'No cargo work — weekend'],
  ['09.03.2026', 'Mon', '00:00', '10:00', 'Loading'],
  ['09.03.2026', 'Mon', '10:00', '14:30', 'Rain — loading suspended'],
  ['09.03.2026', 'Mon', '14:30', '24:00', 'Loading'],
  ['10.03.2026', 'Tue', '00:00', '24:00', 'Loading'],
  ['11.03.2026', 'Wed', '00:00', '21:00', 'Loading'],
  ['11.03.2026', 'Wed', '21:00', '', 'Loading completed'],
  ['11.03.2026', 'Wed', '23:10', '', 'Cargo documents on board; vessel sailed 23:50'],
];
const DISCHARGE_ROWS = [
  ['15.03.2026', 'Sun', '08:40', '', 'Vessel arrived at Alexandria outer anchorage'],
  ['15.03.2026', 'Sun', '10:00', '', 'Notice of readiness tendered'],
  ['16.03.2026', 'Mon', '06:00', '09:00', 'Shifting from anchorage to berth'],
  ['16.03.2026', 'Mon', '09:30', '', 'Discharging commenced'],
  ['16.03.2026', 'Mon', '09:30', '24:00', 'Discharging'],
  ['17.03.2026', 'Tue', '00:00', '24:00', 'Discharging'],
  ['18.03.2026', 'Wed', '00:00', '14:00', 'Discharging'],
  ['18.03.2026', 'Wed', '14:00', '16:00', 'Ship’s crane No. 2 out of order — discharging stopped'],
  ['18.03.2026', 'Wed', '16:00', '24:00', 'Discharging'],
  ['19.03.2026', 'Thu', '00:00', '24:00', 'Discharging'],
  ['20.03.2026', 'Fri', '00:00', '24:00', 'Friday — no work'],
  ['21.03.2026', 'Sat', '00:00', '24:00', 'Public holiday — no work'],
  ['22.03.2026', 'Sun', '00:00', '24:00', 'Discharging'],
  ['23.03.2026', 'Mon', '00:00', '24:00', 'Discharging'],
  ['24.03.2026', 'Tue', '00:00', '18:00', 'Discharging'],
  ['24.03.2026', 'Tue', '18:00', '', 'Discharging completed'],
];

const doc = (body, extraCss) => '<!doctype html><html><head><meta charset="utf-8"><style>' + PAGE_CSS + (extraCss || '') + '</style></head><body>' + body + '</body></html>';

/**
 * @param {import('playwright').Browser} browser
 * @param {string} dir  where the files are written
 */
async function makeSampleDocs(browser, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const ctx = await browser.newContext({ viewport: { width: 794, height: 1123 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const out = {
    cpPdf: path.join(dir, 'charter-party-recap.pdf'),
    cpPages: [path.join(dir, 'charter-party-page-1.png'), path.join(dir, 'charter-party-page-2.png')],
    sofLoad: path.join(dir, 'sof-novorossiysk.png'),
    sofDischarge: path.join(dir, 'sof-alexandria.jpg'),
    sofHand: path.join(dir, 'sof-alexandria-by-hand.png'),
  };

  // charter party: one PDF, and the same two pages as images
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const page1 = '<div class="sheet mono">' + esc(RECAP) + '</div>', page2 = '<div class="sheet serif">' + RIDER + '</div>';
  await page.setContent(doc(page1 + page2));
  await page.pdf({ path: out.cpPdf, format: 'A4', printBackground: true });
  for (let i = 0; i < 2; i++) {
    await page.setContent(doc(i === 0 ? page1 : page2));
    await page.locator('.sheet').screenshot({ path: out.cpPages[i] });
  }

  // statements of facts: a clean scan, and a "photo" taken slightly askew on a desk
  await page.setContent(doc('<div class="sheet serif">' + head('NOVOROSSIYSK', 'LOADING') + rows(LOAD_ROWS) + SIGN + '</div>'));
  await page.locator('.sheet').screenshot({ path: out.sofLoad });
  await page.setContent(doc('<div class="desk"><div class="sheet serif">' + head('ALEXANDRIA', 'DISCHARGING') + rows(DISCHARGE_ROWS) + SIGN + '</div></div>',
    'body { background: #6d5a45; } .desk { padding: 14mm 9mm; } .desk .sheet { transform: rotate(1.3deg); box-shadow: 0 6px 30px rgba(0,0,0,.5); filter: brightness(0.97) contrast(0.96); }'));
  await page.screenshot({ path: out.sofDischarge, type: 'jpeg', quality: 72, fullPage: true });

  // the same discharge port as a form filled in by hand (imitated with a handwriting font, if one is installed next to the tests)
  const fontFile = process.env.HAND_FONT || '';
  if (fontFile && fs.existsSync(fontFile)) {
    const font = '@font-face { font-family: Hand; src: url(data:font/woff2;base64,' + fs.readFileSync(fontFile).toString('base64') + '); } ' +
      'td.hand { font-family: Hand, cursive; font-size: 15pt; line-height: 1; color: #1b2a6b; white-space: nowrap; } ' +
      'tr:nth-child(3n) td.hand { transform: rotate(-1.2deg); } tr:nth-child(3n+1) td.hand { transform: rotate(0.8deg) translateY(1px); }';
    await page.setContent(doc('<div class="sheet serif">' + head('ALEXANDRIA', 'DISCHARGING') + rows(DISCHARGE_ROWS, 'hand') + SIGN + '</div>', font));
    await page.evaluate(() => document.fonts.ready);
    await page.locator('.sheet').screenshot({ path: out.sofHand });
  } else out.sofHand = '';

  await ctx.close();
  return out;
}

module.exports = { makeSampleDocs };
