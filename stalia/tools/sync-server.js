#!/usr/bin/env node
/*
 * Copies into server/ the three things the reading server shares with the site, so that the
 * server folder can be deployed on its own:
 *
 *   app/schema.js    -> server/shared/schema.cjs      the shape of a reader's answer
 *   app/license.js   -> server/shared/license.cjs     how a licence key is verified
 *   app/config.js    -> server/src/public-keys.js     the public keys that verify licence keys
 *
 *   node tools/sync-server.js
 *
 * "node tools/keygen.js init" runs this by itself. The tests fail if the copies are out of date.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const NOTE = '/* Copy of ../../app/%s — do not edit here. Edit the original, then run: node tools/sync-server.js */\n';

function publicKeysOf(root) {
  const src = fs.readFileSync(path.join(root, 'app', 'config.js'), 'utf8');
  const m = /\/\*KEYS-START\*\/([\s\S]*?)\/\*KEYS-END\*\//.exec(src);
  if (!m) throw new Error('Markers /*KEYS-START*/ … /*KEYS-END*/ not found in app/config.js');
  return JSON.parse(m[1]);
}

/** @returns {Object<string,string>} file path (relative to the project) -> the content it must have */
function expected(root) {
  root = root || ROOT;
  const copy = (name) => NOTE.replace('%s', name) + fs.readFileSync(path.join(root, 'app', name), 'utf8');
  return {
    'server/shared/schema.cjs': copy('schema.js'),
    'server/shared/license.cjs': copy('license.js'),
    'server/src/public-keys.js':
      '// Public keys that verify Stalia licence keys. Written by tools/sync-server.js from app/config.js: do not edit by hand.\n' +
      'export default ' + JSON.stringify(publicKeysOf(root), null, 2) + ';\n',
  };
}

function sync(root) {
  root = root || ROOT;
  const changed = [];
  for (const [rel, content] of Object.entries(expected(root))) {
    const file = path.join(root, rel);
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === content) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    changed.push(rel);
  }
  return changed;
}

module.exports = { expected, sync };

if (require.main === module) {
  const changed = sync();
  console.log(changed.length ? 'Updated: ' + changed.join(', ') : 'The server copies are up to date.');
}
