#!/usr/bin/env node
/*
 * Builds app/vendor/reader/stalia-reader.js: the reading code of server/ and the Anthropic SDK in one file
 * for the browser. The calculator loads it only when somebody reads documents with their own Claude API key.
 *
 *   cd server && npm install && cd ..      (once: brings the SDK and the bundler)
 *   node tools/build-reader.js
 *
 * Run it again after changing anything in server/src/ or app/schema.js. The tests fail if it is out of date.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'app', 'vendor', 'reader', 'stalia-reader.js');
/** Everything of ours that ends up in the bundle. */
const SOURCES = ['server/src/direct.js', 'server/src/reader.js', 'server/src/prompt.js', 'server/shared/schema.cjs', 'server/package.json'];

function sourceHash(root) {
  const h = crypto.createHash('sha256');
  for (const f of SOURCES) h.update(f + '\n').update(fs.readFileSync(path.join(root || ROOT, f)));
  return h.digest('hex').slice(0, 32);
}
const builtFrom = (root) => {
  const file = path.join(root || ROOT, 'app', 'vendor', 'reader', 'stalia-reader.js');
  const m = fs.existsSync(file) ? /^\/\* stalia-reader · sources ([0-9a-f]{32}) /.exec(fs.readFileSync(file, 'utf8').slice(0, 200)) : null;
  return m ? m[1] : '';
};

module.exports = { sourceHash, builtFrom, SOURCES };

if (require.main === module) {
  let esbuild;
  try { esbuild = require(path.join(ROOT, 'server', 'node_modules', 'esbuild')); } catch (e) {
    console.error('The bundler is not installed. Run "npm install" in server/ first.'); process.exit(1);
  }
  const sdkDir = path.join(ROOT, 'server', 'node_modules', '@anthropic-ai', 'sdk');
  const pkg = JSON.parse(fs.readFileSync(path.join(sdkDir, 'package.json'), 'utf8')), sdk = pkg.version;
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  // the SDK's licence travels with the bundle
  fs.writeFileSync(path.join(path.dirname(OUT), 'LICENSE-anthropic-sdk.txt'),
    'The file stalia-reader.js contains the Anthropic SDK for TypeScript, version ' + sdk + ' (' + pkg.license + ').\n' +
    'https://github.com/anthropics/anthropic-sdk-typescript\n\n' + fs.readFileSync(path.join(sdkDir, 'LICENSE'), 'utf8'));
  esbuild.buildSync({
    entryPoints: [path.join(ROOT, 'server', 'src', 'direct.js')], outfile: OUT, bundle: true, format: 'esm', platform: 'browser', target: 'es2020',
    minify: true, legalComments: 'none',
    banner: { js: '/* stalia-reader · sources ' + sourceHash() + ' · Anthropic SDK ' + sdk + ' (' + pkg.license + ', see LICENSE-anthropic-sdk.txt) · built by tools/build-reader.js: do not edit */' },
  });
  console.log('Wrote ' + path.relative(ROOT, OUT) + ' (' + Math.round(fs.statSync(OUT).size / 1024) + ' KB)');
}
