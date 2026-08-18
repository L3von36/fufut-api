#!/usr/bin/env node
/**
 * Drift detector: does what is deployed still correspond to what is in git?
 *
 * The original incident was not really a coding mistake — it was that this
 * Worker had no source repository at all. It was deployed from someone's
 * machine, so a rewrite could drop every auth check and leave no diff, no
 * review, and no trace. Reconstructing the source fixes today; this script is
 * what stops it recurring.
 *
 * It compares the live script's identifier surface against the local build. An
 * exact byte match is not expected — esbuild output varies by version — so it
 * compares the set of top-level function names, which is stable and enough to
 * catch "production is running something that is not in this repo".
 *
 * Env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID
 * Usage: node scripts/check-drift.mjs [script-name]
 */

import { execSync } from 'node:child_process';
import { readFileSync, rmSync, existsSync } from 'node:fs';

const SCRIPT = process.argv[2] || 'fufut-api';
const { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT } = process.env;

if (!TOKEN || !ACCOUNT) {
  console.error('Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID');
  process.exit(2);
}

const fnNames = (src) => {
  const out = new Set();
  for (const m of src.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) {
    // esbuild appends numeric suffixes when deduping; normalise them away.
    out.add(m[1].replace(/\d+$/, ''));
  }
  return out;
};

console.log(`Fetching deployed ${SCRIPT}...`);
const res = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/${SCRIPT}`,
  { headers: { Authorization: `Bearer ${TOKEN}` } }
);
if (!res.ok) {
  console.error(`Could not fetch deployed script: ${res.status}`);
  process.exit(2);
}
const deployed = await res.text();

console.log('Building local source...');
execSync('npx wrangler deploy --dry-run --outdir=.drift-build', { stdio: 'pipe' });
const local = readFileSync('.drift-build/index.js', 'utf8');
rmSync('.drift-build', { recursive: true, force: true });

/**
 * Deletions look exactly like drift.
 *
 * A function present in the deployed script and absent from this repo is the
 * signature of an out-of-band deploy — and equally the signature of a commit
 * that legitimately removed it, since production still predates the removal.
 * Failing on both means every deletion blocks deploys until somebody switches
 * the check off, and the check is worth more than that.
 *
 * So a removal has to be declared, in a diff a reviewer sees. That keeps the
 * property that actually matters: nothing disappears from production without a
 * human having said so in git.
 */
const ALLOW_PATH = new URL('./removed-functions.json', import.meta.url);
let declared = [];
if (existsSync(ALLOW_PATH)) {
  try {
    declared = JSON.parse(readFileSync(ALLOW_PATH, 'utf8')).removed || [];
  } catch (e) {
    console.error(`Could not read removed-functions.json: ${e.message}`);
    process.exit(2);
  }
}
const declaredNames = new Set(declared.map((r) => r.name));

const dep = fnNames(deployed);
const loc = fnNames(local);
const gone = [...dep].filter((n) => !loc.has(n));    // live has code we do not
const missing = gone.filter((n) => !declaredNames.has(n));
const accounted = gone.filter((n) => declaredNames.has(n));
const extra = [...loc].filter((n) => !dep.has(n));   // we have code not live
// Entries stop being needed once the deploy lands. Said out loud so the list
// cannot rot into a permanent exemption nobody remembers granting.
const stale = [...declaredNames].filter((n) => !dep.has(n));

if (accounted.length) {
  console.log('\nRemoved deliberately (declared in scripts/removed-functions.json):');
  for (const name of accounted) {
    const row = declared.find((r) => r.name === name);
    console.log(`  ${name} — ${(row && row.why) || 'no reason given'}`);
  }
}
if (stale.length) {
  console.log('\nNo longer deployed; these entries can be deleted from removed-functions.json:');
  console.log('  ' + stale.join(', '));
}

if (missing.length) {
  console.error('\nDRIFT — deployed contains functions absent from this repo:');
  console.error('  ' + missing.join(', '));
  console.error('\nProduction is running code that is not in git. Someone deployed');
  console.error('outside CI. Reconcile before deploying over it.');
  console.error('\nIf this commit removed them on purpose, declare them in');
  console.error('scripts/removed-functions.json with a reason.');
}
if (extra.length) {
  console.log('\nRepo contains functions not yet deployed (expected before a deploy):');
  console.log('  ' + extra.join(', '));
}
if (!missing.length && !extra.length) {
  console.log('\nIn sync: deployed and local expose the same functions.');
}

process.exit(missing.length ? 1 : 0);
