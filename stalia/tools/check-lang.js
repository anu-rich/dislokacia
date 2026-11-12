#!/usr/bin/env node
/*
 * Checks one language of the site: the interface strings in app/lang/<code>.js
 * and the landing page in <code>/index.html.
 *
 *   node tools/check-lang.js tr
 *
 * Prints every problem it finds and exits with 1, or prints OK.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const code = process.argv[2];
if (!/^[a-z]{2}$/.test(code || '')) { console.error('Usage: node tools/check-lang.js <two-letter code>'); process.exit(1); }

const problems = [];
const warn = [];
const bad = (m) => problems.push(m);

// ---------------------------------------------------------------- strings
const I = require(path.join(ROOT, 'app', 'i18n.js'));
const en = I.STRINGS.en, enExamples = I.examplesText('en');
const packFile = path.join(ROOT, 'app', 'lang', code + '.js');
let pack = null;
if (!fs.existsSync(packFile)) bad('missing file app/lang/' + code + '.js');
else {
  try { pack = require(packFile); } catch (e) { bad('app/lang/' + code + '.js does not load: ' + e.message); }
}
if (pack) {
  if (pack.code !== code) bad('pack.code must be "' + code + '"');
  for (const k of ['label', 'name']) if (!pack[k] || typeof pack[k] !== 'string') bad('pack.' + k + ' is missing');
  const f = pack.format || {};
  try { new Intl.NumberFormat(f.locale).format(1234.5); } catch (e) { bad('format.locale "' + f.locale + '" is not a valid locale'); }
  if (!/DD/.test(f.date || '') || !/MMM|MM/.test(f.date || '') || !/YYYY/.test(f.date || '')) bad('format.date must contain DD, MM or MMM, and YYYY');
  if (!/DD/.test(f.dayShort || '') || !/MMM|MM/.test(f.dayShort || '') || /YYYY/.test(f.dayShort || '')) bad('format.dayShort must contain DD and MM or MMM, without YYYY');
  if (typeof f.durSpace !== 'boolean') bad('format.durSpace must be true or false');
  if (f.csvSep !== ',' && f.csvSep !== ';') bad('format.csvSep must be "," or ";"');

  const s = pack.strings || {};
  const missing = Object.keys(en).filter((k) => !(k in s)), extra = Object.keys(s).filter((k) => !(k in en));
  if (missing.length) bad('missing keys (' + missing.length + '): ' + missing.slice(0, 12).join(', ') + (missing.length > 12 ? ' …' : ''));
  if (extra.length) bad('unknown keys (' + extra.length + '): ' + extra.slice(0, 12).join(', '));
  const ph = (v) => (String(v).match(/\{\w+\}/g) || []).sort().join(',');
  const same = [];
  for (const k of Object.keys(en)) {
    if (!(k in s)) continue;
    if (typeof s[k] !== 'string') { bad(k + ' is not a string'); continue; }
    if (ph(s[k]) !== ph(en[k])) bad(k + ': placeholders must be ' + (ph(en[k]) || '(none)') + ', found ' + (ph(s[k]) || '(none)'));
    if (en[k] !== '' && s[k].trim() === '' && k !== 'a.per') bad(k + ' is empty');
    if (/\s$|^\s/.test(s[k])) bad(k + ' starts or ends with a space');
    if (s[k] === en[k] && en[k].length > 14 && /[a-z]{4,} [a-z]{4,}/i.test(en[k])) same.push(k);
  }
  // international shipping wording legitimately stays in English; a long list of identical sentences does not
  const allowed = /^(st\.term\.(sooner|uu|eiu)|st\.eoe|pro\.title|nav\.(free|pro)|lang\.name)$/;
  const untranslated = same.filter((k) => !allowed.test(k));
  if (untranslated.length > 4) bad('these look untranslated (identical to English): ' + untranslated.slice(0, 15).join(', '));
  else if (untranslated.length) warn.push('identical to English, check: ' + untranslated.join(', '));

  const ex = pack.examples || {};
  for (const k of Object.keys(enExamples)) if (typeof ex[k] !== 'string' || !ex[k]) bad('examples.' + k + ' is missing');
  for (const d of [0, 1, 2, 3, 4, 5, 6]) for (const p of ['dow.', 'dows.']) if (s[p + d] && s[p + d] === en[p + d]) bad(p + d + ' is still English');
  for (let m = 0; m < 12; m++) if (s['mon.' + m] && s['mon.' + m] === en['mon.' + m] && code !== 'en') warn.push('mon.' + m + ' equals English');
}

// ---------------------------------------------------------------- landing page
const pageFile = path.join(ROOT, code, 'index.html');
if (!fs.existsSync(pageFile)) bad('missing file ' + code + '/index.html');
else {
  const html = fs.readFileSync(pageFile, 'utf8');
  const enHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  if (!new RegExp('<html lang="' + code + '">').test(html)) bad('landing: <html lang="' + code + '"> expected');
  const title = /<title>([^<]+)<\/title>/.exec(html);
  if (!title || title[1].length < 20 || title[1].length > 90) bad('landing: <title> must be 20–90 characters, found ' + (title ? title[1].length : 0));
  const desc = /<meta name="description" content="([^"]+)">/.exec(html);
  if (!desc || desc[1].length < 80 || desc[1].length > 260) bad('landing: meta description must be 80–260 characters, found ' + (desc ? desc[1].length : 0));
  if (title && /<title>([^<]+)<\/title>/.exec(enHtml)[1] === title[1]) bad('landing: <title> is still English');
  for (const marker of ['<!--SEO-->', '<!--/SEO-->', '<!--LANGS-->', '<!--/LANGS-->', '<!--LANGLIST-->', '<!--/LANGLIST-->']) {
    if (html.split(marker).length !== 2) bad('landing: marker ' + marker + ' must appear exactly once');
  }
  for (const id of ['documents', 'counts', 'mobile', 'pricing', 'contact', 'faq', 'demo-body', 'contact-email', 'tip']) {
    if (!new RegExp('\\sid="' + id + '"').test(html)) bad('landing: element with id="' + id + '" is missing');
  }
  if ((html.match(/<h1[\s>]/g) || []).length !== 1) bad('landing: exactly one <h1> expected');
  // the page body must have the same structure as the English page (the footer may list fewer guides)
  const body = (src) => (/<main>[\s\S]*<\/main>/.exec(src) || [''])[0];
  const count = (re, src) => (body(src).match(re) || []).length;
  for (const [name, re] of [['<section', /<section[\s>]/g], ['<h2', /<h2[\s>]/g], ['<h3', /<h3[\s>]/g], ['<dt>', /<dt>/g], ['<li>', /<li>/g], ['<p', /<p[\s>]/g], ['data-price=', /data-price=/g], ['data-buy=', /data-buy=/g]]) {
    if (count(re, html) !== count(re, enHtml)) bad('landing: ' + name + ' appears ' + count(re, html) + ' times inside <main>, the English page has ' + count(re, enHtml));
  }
  if (!html.includes('href="../app/?lang=' + code + '"')) bad('landing: links to the calculator must be href="../app/?lang=' + code + '"');
  if (/href="app\//.test(html) || /src="app\//.test(html) || /(href|src)="assets\//.test(html)) bad('landing: paths must start with ../ (found app/ or assets/ without it)');
  const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  const want = ['../app/config.js', '../app/engine.js', '../app/i18n.js', '../app/lang/' + code + '.js', '../app/model.js', '../app/view.js', '../assets/site.js'];
  if (scripts.join(' ') !== want.join(' ')) bad('landing: script tags must be exactly, in order: ' + want.join(', '));
  // every relative link must lead somewhere
  const dir = path.dirname(pageFile);
  for (const m of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
    let ref = m[1].replace(/&amp;/g, '&');
    if (/^(https?:|mailto:|data:|tel:|#)/.test(ref)) continue;
    ref = ref.split('#')[0].split('?')[0];
    if (ref === '') continue;
    let target = path.resolve(dir, ref);
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) target = path.join(target, 'index.html');
    // pages of the other new languages may not exist yet while they are being written
    if (!fs.existsSync(target) && !/\/(uk|tr|el|zh)\/index\.html$/.test(target)) bad('landing: broken link ' + m[1]);
  }
  // visible English left behind
  const text = html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ');
  for (const phrase of ['Open the calculator', 'What it counts', 'Three steps', 'Why trust the arithmetic', 'Pricing', 'Questions', 'On your phone', 'Free. No sign-up', 'Buy monthly', 'per month']) {
    if (text.includes(phrase)) bad('landing: English text left in the page: "' + phrase + '"');
  }
}

for (const w of warn) console.log('note: ' + w);
if (problems.length) { console.log(problems.map((p) => 'PROBLEM: ' + p).join('\n')); console.log('\n' + problems.length + ' problem(s) for "' + code + '"'); process.exit(1); }
console.log('OK — "' + code + '" strings and landing page pass all checks');
