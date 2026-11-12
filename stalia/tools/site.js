#!/usr/bin/env node
/*
 * Stalia site address tool (no dependencies).
 *
 *   node tools/site.js https://your-domain.com    set the public address of the site everywhere
 *   node tools/site.js                            re-apply the address already stored in app/config.js
 *
 * It writes siteUrl into app/config.js, fills the <!--SEO--> block of every page
 * (canonical address, language alternates, link-preview image) and creates
 * sitemap.xml and robots.txt for search engines.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

/** Every public page. Pages with the same `group` are translations of one another. */
const PAGES = [
  { file: 'index.html', url: '/', lang: 'en', group: 'home', priority: '1.0' },
  { file: 'ru/index.html', url: '/ru/', lang: 'ru', group: 'home', priority: '1.0' },
  { file: 'kk/index.html', url: '/kk/', lang: 'kk', group: 'home', priority: '1.0' },
  { file: 'app/index.html', url: '/app/', lang: 'en', group: 'app', priority: '0.9' },
  { file: 'guides/how-to-calculate-laytime.html', url: '/guides/how-to-calculate-laytime.html', lang: 'en', group: 'howto', priority: '0.8' },
  { file: 'ru/guides/raschet-staliynogo-vremeni.html', url: '/ru/guides/raschet-staliynogo-vremeni.html', lang: 'ru', group: 'howto', priority: '0.8' },
  { file: 'kk/guides/staliya-esepteu.html', url: '/kk/guides/staliya-esepteu.html', lang: 'kk', group: 'howto', priority: '0.8' },
  { file: 'guides/shinc-shex-sshex-fhex.html', url: '/guides/shinc-shex-sshex-fhex.html', lang: 'en', group: 'terms', priority: '0.8' },
  { file: 'ru/guides/shinc-shex-sshex-fhex.html', url: '/ru/guides/shinc-shex-sshex-fhex.html', lang: 'ru', group: 'terms', priority: '0.8' },
];

/** 'https://x.com/' -> 'https://x.com'; anything that is not an http(s) address -> ''. */
function cleanSite(s) {
  s = String(s || '').trim().replace(/\/+$/, '');
  return /^https?:\/\/[a-z0-9.-]+(:\d+)?(\/[\w./-]*)?$/i.test(s) ? s : '';
}

const alternates = (page) => PAGES.filter((p) => p.group === page.group);
const relativeSelf = (page) => (page.url.endsWith('/') ? './' : path.posix.basename(page.url));

/** The lines that go between <!--SEO--> and <!--/SEO--> on a page. */
function seoBlock(page, site) {
  if (!site) return '<link rel="canonical" href="' + relativeSelf(page) + '">';
  const out = ['<link rel="canonical" href="' + site + page.url + '">'];
  const alts = alternates(page);
  if (alts.length > 1) {
    for (const a of alts) out.push('<link rel="alternate" hreflang="' + a.lang + '" href="' + site + a.url + '">');
    const en = alts.find((a) => a.lang === 'en') || alts[0];
    out.push('<link rel="alternate" hreflang="x-default" href="' + site + en.url + '">');
  }
  out.push('<meta property="og:url" content="' + site + page.url + '">');
  out.push('<meta property="og:image" content="' + site + '/assets/og-' + page.lang + '.png">');
  out.push('<meta name="twitter:image" content="' + site + '/assets/og-' + page.lang + '.png">');
  return out.join('\n');
}

function sitemap(site) {
  const rows = PAGES.map((p) => {
    const alts = alternates(p);
    const links = alts.length > 1
      ? alts.map((a) => '    <xhtml:link rel="alternate" hreflang="' + a.lang + '" href="' + site + a.url + '"/>').join('\n') + '\n'
      : '';
    return '  <url>\n    <loc>' + site + p.url + '</loc>\n' + links + '    <priority>' + p.priority + '</priority>\n  </url>';
  });
  return '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n' + rows.join('\n') + '\n</urlset>\n';
}

const robots = (site) => 'User-agent: *\nAllow: /\n' + (site ? '\nSitemap: ' + site + '/sitemap.xml\n' : '');

function applyTo(root, site) {
  const changed = [];
  for (const page of PAGES) {
    const file = path.join(root, page.file);
    const src = fs.readFileSync(file, 'utf8');
    if (!/<!--SEO-->[\s\S]*?<!--\/SEO-->/.test(src)) throw new Error('No <!--SEO--> block in ' + page.file);
    const next = src.replace(/<!--SEO-->[\s\S]*?<!--\/SEO-->/, () => '<!--SEO-->\n' + seoBlock(page, site) + '\n<!--/SEO-->');
    if (next !== src) { fs.writeFileSync(file, next); changed.push(page.file); }
  }
  fs.writeFileSync(path.join(root, 'robots.txt'), robots(site));
  const sm = path.join(root, 'sitemap.xml');
  if (site) fs.writeFileSync(sm, sitemap(site)); else if (fs.existsSync(sm)) fs.unlinkSync(sm);
  return changed;
}

function readConfigSite(root) {
  const m = /siteUrl:\s*'([^']*)'/.exec(fs.readFileSync(path.join(root, 'app', 'config.js'), 'utf8'));
  return m ? m[1] : '';
}
function writeConfigSite(root, site) {
  const file = path.join(root, 'app', 'config.js');
  const src = fs.readFileSync(file, 'utf8');
  if (!/siteUrl:\s*'[^']*'/.test(src)) throw new Error("siteUrl: '…' not found in app/config.js");
  fs.writeFileSync(file, src.replace(/siteUrl:\s*'[^']*'/, () => "siteUrl: '" + site + "'"));
}

module.exports = { PAGES, cleanSite, seoBlock, sitemap, robots, applyTo, readConfigSite, writeConfigSite };

if (require.main === module) {
  const arg = process.argv[2];
  let site;
  if (arg) {
    site = cleanSite(arg);
    if (!site) { console.error('That does not look like a site address. Example: node tools/site.js https://stalia.example'); process.exit(1); }
    writeConfigSite(ROOT, site);
  } else site = cleanSite(readConfigSite(ROOT));
  const changed = applyTo(ROOT, site);
  console.log(site ? 'Site address: ' + site : 'No site address yet — pages keep relative addresses.');
  console.log('Pages updated: ' + (changed.length ? changed.join(', ') : 'none (already up to date)'));
  console.log(site ? 'Wrote sitemap.xml and robots.txt.' : 'Wrote robots.txt. Run again with your address once the site is online.');
}
