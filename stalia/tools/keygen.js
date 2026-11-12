#!/usr/bin/env node
/*
 * Stalia licence key tool (no dependencies, Node 18+).
 *
 *   node tools/keygen.js init                      create your master key (once) and register it in app/config.js
 *   node tools/keygen.js issue --name "ACME Shipping" --days 365
 *   node tools/keygen.js issue --name "ACME Shipping" --until 2027-12-31
 *   node tools/keygen.js issue --name "ACME Shipping" --perpetual
 *   node tools/keygen.js batch --count 10 --days 180            ten keys "Tester 01" … "Tester 10" for people who try Pro for free
 *   node tools/keygen.js batch --names "Aigerim, Daniyar" --days 90 --plan tester --out keys.txt
 *   node tools/keygen.js verify STL1.xxxxx.yyyyy   check a key against app/config.js
 *   node tools/keygen.js pubkey                    print the public key of your master key
 *
 * The master key lives in tools/.private/stalia-private-key.pem (never committed).
 * Use --key <path> or the STALIA_PRIVATE_KEY variable to keep it elsewhere.
 * Whoever holds that file can mint licences — keep a backup and keep it private.
 */
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'app', 'config.js');
const PRIVATE_DIR = path.join(__dirname, '.private');
const DEFAULT_KEY = process.env.STALIA_PRIVATE_KEY || path.join(PRIVATE_DIR, 'stalia-private-key.pem');
const LEDGER = path.join(PRIVATE_DIR, 'issued.csv');
const PREFIX = 'STL1';

const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const today = () => new Date().toISOString().slice(0, 10);

/** @returns {{privatePem:string, publicJwk:{kty:string,crv:string,x:string,y:string}}} */
function generateKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
  };
}

function publicJwkOf(privatePem) {
  const jwk = crypto.createPublicKey(crypto.createPrivateKey(privatePem)).export({ format: 'jwk' });
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
}

/**
 * @param {string} privatePem
 * @param {{name:string, plan?:string, exp?:string|null, iat?:string, id?:string}} lic
 * @returns {string} licence key
 */
function issueKey(privatePem, lic) {
  if (!lic || !String(lic.name || '').trim()) throw new Error('Licensee name is required (--name).');
  if (lic.exp && !/^\d{4}-\d{2}-\d{2}$/.test(lic.exp)) throw new Error('Expiry must look like 2027-12-31.');
  const payload = {
    id: lic.id || crypto.randomBytes(4).toString('hex'),
    n: String(lic.name).trim(),
    p: lic.plan || 'pro',
    iat: lic.iat || today(),
    exp: lic.exp || null,
  };
  const head = PREFIX + '.' + b64u(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = crypto.sign('sha256', Buffer.from(head, 'ascii'), { key: crypto.createPrivateKey(privatePem), dsaEncoding: 'ieee-p1363' });
  return head + '.' + b64u(sig);
}

function readConfigKeys(configPath) {
  const src = fs.readFileSync(configPath || CONFIG_PATH, 'utf8');
  const m = /\/\*KEYS-START\*\/([\s\S]*?)\/\*KEYS-END\*\//.exec(src);
  if (!m) throw new Error('Markers /*KEYS-START*/ … /*KEYS-END*/ not found in ' + (configPath || CONFIG_PATH));
  return { src, keys: JSON.parse(m[1]) };
}

function writeConfigKeys(keys, configPath) {
  const { src } = readConfigKeys(configPath);
  // The block between the markers must stay strict JSON (readConfigKeys parses it).
  const body = keys.length ? '[\n      ' + keys.map((k) => JSON.stringify(k)).join(',\n      ') + '\n    ]' : '[]';
  fs.writeFileSync(configPath || CONFIG_PATH, src.replace(/\/\*KEYS-START\*\/[\s\S]*?\/\*KEYS-END\*\//, () => '/*KEYS-START*/' + body + '/*KEYS-END*/'));
  // the reading server checks licence keys with the same public keys: keep its copy in step with the site
  if (!configPath) require('./sync-server.js').sync();
}

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next == null || next.startsWith('--')) out[k] = true; else { out[k] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

function loadPrivate(a) {
  const p = a.key || DEFAULT_KEY;
  if (!fs.existsSync(p)) {
    throw new Error('Master key not found: ' + p + '\nCreate it with:  node tools/keygen.js init');
  }
  return fs.readFileSync(p, 'utf8');
}

async function main(argv) {
  const a = args(argv);
  const cmd = a._[0];
  if (cmd === 'init') {
    const p = a.key || DEFAULT_KEY;
    if (fs.existsSync(p) && !a.force) {
      throw new Error('A master key already exists: ' + p + '\nUse --force to create a new one (old licences keep working unless you also pass --replace).');
    }
    const kp = generateKeyPair();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, kp.privatePem, { mode: 0o600 });
    const { keys } = readConfigKeys();
    writeConfigKeys(a.replace ? [kp.publicJwk] : keys.concat([kp.publicJwk]));
    console.log('Master key written to: ' + p);
    console.log('Public key registered in app/config.js (' + (a.replace ? 'replaced' : 'added') + ').');
    console.log('Back the master key file up somewhere private. Do not publish it.');
    return;
  }
  /** The expiry the command line asks for: --until, --perpetual, or --days (a year unless `fallbackDays` says otherwise). */
  const expiryOf = (fallbackDays) => {
    if (a.until) return String(a.until);
    if (a.perpetual) return null;
    const days = a.days == null ? fallbackDays : Number(a.days);
    if (!(days > 0)) throw new Error('--days must be a positive number.');
    return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
  };
  /** Issue one key and write it down in the ledger. */
  const issueAndRecord = (pem, lic) => {
    const key = issueKey(pem, lic);
    const payload = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString('utf8'));
    try {
      fs.mkdirSync(PRIVATE_DIR, { recursive: true });
      if (!fs.existsSync(LEDGER)) fs.writeFileSync(LEDGER, 'id,issued,expires,plan,licensee\n');
      fs.appendFileSync(LEDGER, [payload.id, payload.iat, payload.exp || 'perpetual', payload.p, JSON.stringify(payload.n)].join(',') + '\n');
    } catch (e) { /* the ledger is a convenience only */ }
    return { key, payload };
  };
  if (cmd === 'issue') {
    const { key, payload } = issueAndRecord(loadPrivate(a), { name: a.name, plan: a.plan, exp: expiryOf(365) });
    console.error('Licensee: ' + payload.n + ' · plan: ' + payload.p + ' · valid until: ' + (payload.exp || 'no expiry') + ' · id: ' + payload.id);
    console.log(key);
    return;
  }
  if (cmd === 'batch') {
    // free Pro for colleagues and testers: one key a person, all in one file that is ready to be passed on
    const pem = loadPrivate(a);
    let names = String(a.names || '').split(',').map((n) => n.trim()).filter(Boolean);
    if (!names.length) {
      const count = a.count == null ? 5 : Number(a.count);
      if (!(Number.isInteger(count) && count > 0 && count <= 500)) throw new Error('--count must be a whole number from 1 to 500 (or give --names "A, B, C").');
      names = Array.from({ length: count }, (_, i) => (a.name || 'Tester') + ' ' + String(i + 1).padStart(2, '0'));
    }
    const exp = expiryOf(90), plan = a.plan || 'tester';
    const out = path.resolve(a.out || path.join(PRIVATE_DIR, 'keys-' + today() + '.txt'));
    const lines = ['Stalia Pro: ' + names.length + ' key' + (names.length === 1 ? '' : 's') + ', issued ' + today() + ', valid until ' + (exp || 'no expiry') + '.',
      'To switch Pro on: open the calculator, press "Pro" at the top, paste the key under "I have a licence key", press "Activate".', ''];
    for (const name of names) {
      const { key } = issueAndRecord(pem, { name, plan, exp });
      lines.push(name, key, '');
    }
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, lines.join('\n'), { mode: 0o600 });
    console.log(names.length + ' key' + (names.length === 1 ? '' : 's') + ' written to ' + out);
    return;
  }
  if (cmd === 'verify') {
    const key = a._[1];
    if (!key) throw new Error('Usage: node tools/keygen.js verify <KEY>');
    const lic = require(path.join(ROOT, 'app', 'license.js'));
    const { keys } = readConfigKeys();
    const r = await lic.verifyOfflineKey(key, keys);
    console.log(JSON.stringify(r, null, 2));
    process.exitCode = r.ok ? 0 : 1;
    return;
  }
  if (cmd === 'pubkey') {
    console.log(JSON.stringify(publicJwkOf(loadPrivate(a))));
    return;
  }
  console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^#!.*\n\/\*\n?/, '').replace(/^ \* ?/gm, ''));
}

module.exports = { generateKeyPair, publicJwkOf, issueKey, readConfigKeys, writeConfigKeys, PREFIX };

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => { console.error('Error: ' + e.message); process.exit(1); });
}
