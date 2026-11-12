'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const S = require('../tools/site.js');

const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('every page exists, declares its language, a title and a description', () => {
  for (const p of S.PAGES) {
    const html = read(p.file);
    const lang = /<html lang="([a-z]+)">/.exec(html);
    assert.ok(lang, p.file + ': html lang');
    assert.equal(lang[1], p.lang, p.file + ': language');
    const title = /<title>([^<]+)<\/title>/.exec(html);
    assert.ok(title && title[1].length >= 20 && title[1].length <= 90, p.file + ': title length ' + (title ? title[1].length : 0));
    const desc = /<meta name="description" content="([^"]+)">/.exec(html);
    assert.ok(desc && desc[1].length >= 80 && desc[1].length <= 260, p.file + ': description length ' + (desc ? desc[1].length : 0));
    assert.ok(/<!--SEO-->[\s\S]*<!--\/SEO-->/.test(html), p.file + ': SEO block');
    assert.ok(/<meta name="viewport" content="width=device-width, initial-scale=1/.test(html), p.file + ': viewport');
    assert.equal((html.match(/<h1[\s>]/g) || []).length, p.group === 'app' ? 0 : 1, p.file + ': exactly one h1');
  }
});

test('no broken internal links, scripts, styles or anchors', () => {
  const broken = [];
  for (const p of S.PAGES) {
    const html = read(p.file), dir = path.dirname(path.join(ROOT, p.file));
    const ids = (file) => new Set([...fs.readFileSync(file, 'utf8').matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    for (const m of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
      let ref = m[1].replace(/&amp;/g, '&');
      if (/^(https?:|mailto:|data:|tel:)/.test(ref)) continue;
      let hash = '';
      const h = ref.indexOf('#');
      if (h >= 0) { hash = ref.slice(h + 1); ref = ref.slice(0, h); }
      ref = ref.split('?')[0];
      let target = ref === '' ? path.join(ROOT, p.file) : path.resolve(dir, ref);
      if (fs.existsSync(target) && fs.statSync(target).isDirectory()) target = path.join(target, 'index.html');
      if (!target.startsWith(ROOT)) { broken.push(p.file + ' -> ' + m[1] + ' (outside the site)'); continue; }
      if (!fs.existsSync(target)) { broken.push(p.file + ' -> ' + m[1]); continue; }
      if (hash && /\.html$/.test(target) && !ids(target).has(hash)) broken.push(p.file + ' -> ' + m[1] + ' (no such anchor)');
    }
  }
  assert.deepEqual(broken, []);
});

test('translations link to each other', () => {
  for (const p of S.PAGES) {
    const html = read(p.file), dir = path.dirname(path.join(ROOT, p.file));
    for (const other of S.PAGES.filter((o) => o.group === p.group && o !== p)) {
      const rel = path.relative(dir, path.join(ROOT, other.file)).split(path.sep).join('/').replace(/(^|\/)index\.html$/, '$1') || './';
      assert.ok(html.includes('href="' + rel + '"'), p.file + ' should link to ' + other.file + ' as ' + rel);
    }
  }
});

test('site tool: SEO block, sitemap and robots', () => {
  assert.equal(S.cleanSite('https://stalia.example/'), 'https://stalia.example');
  assert.equal(S.cleanSite('  https://user.github.io/stalia//'), 'https://user.github.io/stalia');
  assert.equal(S.cleanSite('javascript:alert(1)'), '');
  assert.equal(S.cleanSite('stalia.example'), '');
  assert.equal(S.cleanSite('https://x.example/"><script>'), '');

  const home = S.PAGES[0], ruGuide = S.PAGES.find((p) => p.file === 'ru/guides/shinc-shex-sshex-fhex.html'), app = S.PAGES.find((p) => p.group === 'app');
  assert.equal(S.seoBlock(home, ''), '<link rel="canonical" href="./">');
  assert.equal(S.seoBlock(ruGuide, ''), '<link rel="canonical" href="shinc-shex-sshex-fhex.html">');
  const b = S.seoBlock(home, 'https://stalia.example');
  assert.ok(b.includes('<link rel="canonical" href="https://stalia.example/">'));
  assert.ok(b.includes('hreflang="ru" href="https://stalia.example/ru/"'));
  assert.ok(b.includes('hreflang="kk" href="https://stalia.example/kk/"'));
  assert.ok(b.includes('hreflang="x-default" href="https://stalia.example/"'));
  assert.ok(b.includes('og:image" content="https://stalia.example/assets/og-en.png"'));
  assert.ok(!S.seoBlock(app, 'https://stalia.example').includes('hreflang'), 'a page without translations has no alternates');
  assert.ok(S.seoBlock(ruGuide, 'https://stalia.example').includes('og-ru.png'));

  const sm = S.sitemap('https://stalia.example');
  assert.equal((sm.match(/<url>/g) || []).length, S.PAGES.length);
  assert.ok(sm.includes('<loc>https://stalia.example/kk/guides/staliya-esepteu.html</loc>'));
  assert.ok(S.robots('https://stalia.example').includes('Sitemap: https://stalia.example/sitemap.xml'));
  assert.ok(!S.robots('').includes('Sitemap'));
});

test('site tool: applying an address rewrites pages and config, and is repeatable', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stalia-site-'));
  for (const p of S.PAGES) { fs.mkdirSync(path.dirname(path.join(tmp, p.file)), { recursive: true }); fs.copyFileSync(path.join(ROOT, p.file), path.join(tmp, p.file)); }
  fs.copyFileSync(path.join(ROOT, 'app', 'config.js'), path.join(tmp, 'app', 'config.js'));
  S.writeConfigSite(tmp, 'https://stalia.example');
  assert.equal(S.readConfigSite(tmp), 'https://stalia.example');
  delete require.cache[require.resolve(path.join(tmp, 'app', 'config.js'))];
  assert.equal(require(path.join(tmp, 'app', 'config.js')).siteUrl, 'https://stalia.example');
  assert.equal(S.applyTo(tmp, 'https://stalia.example').length, S.PAGES.length);
  assert.deepEqual(S.applyTo(tmp, 'https://stalia.example'), [], 'second run changes nothing');
  const ru = fs.readFileSync(path.join(tmp, 'ru', 'index.html'), 'utf8');
  assert.ok(ru.includes('<link rel="canonical" href="https://stalia.example/ru/">'));
  assert.equal((ru.match(/<!--SEO-->/g) || []).length, 1);
  assert.ok(fs.existsSync(path.join(tmp, 'sitemap.xml')));
  S.applyTo(tmp, '');
  assert.ok(!fs.existsSync(path.join(tmp, 'sitemap.xml')));
  assert.ok(fs.readFileSync(path.join(tmp, 'ru', 'index.html'), 'utf8').includes('<link rel="canonical" href="./">'));
});

test('app shell: the offline cache lists every file the calculator page loads', () => {
  const html = read('app/index.html'), sw = read('app/sw.js'), css = read('assets/base.css');
  const needed = [...html.matchAll(/\s(?:href|src)="([^"#?]+\.(?:js|css|svg|webmanifest))"/g)].map((m) => m[1]);
  assert.ok(needed.length >= 10);
  for (const f of needed) assert.ok(sw.includes("'" + f + "'"), 'sw.js must cache ' + f);
  // every font the stylesheet can request for Latin, Russian and Kazakh text is cached too
  const fonts = [...css.matchAll(/url\(fonts\/([\w-]+)\.woff2\)/g)].map((m) => m[1]).filter((f) => !/latin-ext/.test(f) || /plex-sans/.test(f));
  for (const f of fonts) assert.ok(sw.includes("'" + f + "'"), 'sw.js must cache font ' + f);
  const manifest = JSON.parse(read('app/manifest.webmanifest'));
  for (const i of manifest.icons) assert.ok(fs.existsSync(path.resolve(ROOT, 'app', i.src)), 'icon ' + i.src);
});
