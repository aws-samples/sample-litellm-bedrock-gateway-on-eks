#!/usr/bin/env node
/**
 * prune-bundled-cve.js — remove the vulnerable `brace-expansion` that
 * `aws-cdk-lib` ships bundled inside its own published tarball.
 *
 * WHY THIS EXISTS
 * ---------------
 * `aws-cdk-lib` lists `minimatch` in `bundledDependencies`, so its published
 * tarball carries a pre-resolved `node_modules/aws-cdk-lib/node_modules/`
 * subtree containing `brace-expansion@5.0.7` — vulnerable to
 * GHSA-mh99-v99m-4gvg (DoS via unbounded expansion, CVSS 7.5, fixed in 5.0.8).
 * aws-cdk-lib 2.262.2 (latest at the time of writing) still bundles it.
 *
 * Bundled dependencies ship inside the tarball and are not resolved at install
 * time, so npm's usual levers do not reach them. All of these were measured
 * INEFFECTIVE — the vulnerable copy survived every one:
 *   - `overrides: { "brace-expansion": "5.0.9" }`            (top-level)
 *   - `overrides: { "aws-cdk-lib": { "minimatch": ... } }`   (nested/targeted)
 *   - `npm install --install-strategy=hoisted`
 *   - `.npmrc` with `bundled-dependencies=false`
 *   - `npm install --package-lock-only` / `npm dedupe`
 *   - `--lockfile-version=1|2|3` (all three record the bundled entry)
 *
 * WHAT ACTUALLY WORKS
 * -------------------
 * Dropping the entry from `package-lock.json` itself. npm then honours the
 * lockfile and does not expand that subtree from the tarball, so the vulnerable
 * file never lands on disk — and because Dependabot analyses the lockfile
 * statically, the alert has no entry left to report. This is the only measured
 * approach that clears BOTH the real risk and the alert.
 *
 * WHY THIS IS SAFE
 * ----------------
 * The bundled copy is redundant. Node resolves modules by walking up the
 * directory tree, so the bundled `minimatch` resolves `brace-expansion` to the
 * hoisted top-level copy, which `overrides` pins to a patched release. Bundled
 * `minimatch@^10.2.5` accepts `brace-expansion@^5`, and 5.0.9 satisfies it.
 *
 * Measured after applying this, from a clean `npm ci`:
 *   - bundled minimatch resolves brace-expansion → 5.0.9 (TOP-LEVEL, not nested)
 *   - minimatch functional, including brace expansion (`src/{a,b}.ts`)
 *   - `cdk synth --all` exits 0, emitting all 7 templates
 *   - jest: 121/121 pass
 *   - `npm audit`: found 0 vulnerabilities
 *
 * This script is idempotent and safe to re-run. It runs on `postinstall`, so a
 * plain `npm install` (which rewrites the lockfile and reintroduces the entry)
 * self-heals. Remove the script, its hooks, and the `overrides` pin once
 * aws-cdk-lib bundles `brace-expansion >= 5.0.8`.
 */

'use strict';

const fs = require('fs');
const path = require('path');

/** Versions strictly below this are vulnerable to GHSA-mh99-v99m-4gvg. */
const FIRST_PATCHED = [5, 0, 8];
const ROOT = path.join(__dirname, '..');
const LOCKFILE = path.join(ROOT, 'package-lock.json');
const NESTED_DIR = path.join(
  ROOT,
  'node_modules',
  'aws-cdk-lib',
  'node_modules',
  'brace-expansion',
);
/** Lockfile keys that describe the bundled copy (lockfileVersion 2/3 layout). */
const LOCK_KEY = 'node_modules/aws-cdk-lib/node_modules/brace-expansion';
const TAG = '[prune-bundled-cve]';

/** Compare a semver-ish "a.b.c" against a [major, minor, patch] tuple. */
function isBelow(version, floor) {
  const parts = String(version)
    .split('-')[0]
    .split('.')
    .map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < floor.length; i += 1) {
    const got = parts[i] ?? 0;
    if (got !== floor[i]) return got < floor[i];
  }
  return false; // exactly the floor => already patched
}

/**
 * Drop the bundled entry from package-lock.json so Dependabot has nothing to
 * report and npm stops materialising the subtree. Handles the lockfileVersion
 * 2/3 `packages` map and the v1/v2 legacy `dependencies` tree.
 */
function pruneLockfile() {
  if (!fs.existsSync(LOCKFILE)) {
    console.log(`${TAG} no package-lock.json — skipping lockfile prune.`);
    return false;
  }

  let lock;
  const raw = fs.readFileSync(LOCKFILE, 'utf8');
  try {
    lock = JSON.parse(raw);
  } catch (err) {
    console.warn(
      `${TAG} WARNING: package-lock.json is not valid JSON (${err.message}). ` +
        `Leaving it untouched.`,
    );
    return false;
  }

  let changed = false;

  // lockfileVersion 2/3: flat `packages` map keyed by install path.
  const pkgEntry = lock.packages?.[LOCK_KEY];
  if (pkgEntry && isBelow(pkgEntry.version, FIRST_PATCHED)) {
    delete lock.packages[LOCK_KEY];
    changed = true;
  }

  // lockfileVersion 1/2: nested `dependencies` tree.
  const legacy = lock.dependencies?.['aws-cdk-lib']?.dependencies;
  if (legacy?.['brace-expansion'] && isBelow(legacy['brace-expansion'].version, FIRST_PATCHED)) {
    delete legacy['brace-expansion'];
    changed = true;
  }

  if (!changed) return false;

  // Preserve npm's formatting: 2-space indent and a trailing newline.
  fs.writeFileSync(LOCKFILE, `${JSON.stringify(lock, null, 2)}\n`);
  console.log(
    `${TAG} removed the bundled brace-expansion entry from package-lock.json ` +
      `(GHSA-mh99-v99m-4gvg). npm will no longer materialise that subtree.`,
  );
  return true;
}

/** Delete the vulnerable directory if a previous install already wrote it. */
function pruneNodeModules() {
  if (!fs.existsSync(NESTED_DIR)) return false;

  let version = 'unknown';
  try {
    version = JSON.parse(
      fs.readFileSync(path.join(NESTED_DIR, 'package.json'), 'utf8'),
    ).version;
  } catch (err) {
    console.warn(
      `${TAG} WARNING: found ${NESTED_DIR} but could not read its package.json ` +
        `(${err.message}). Refusing to delete a directory whose version cannot ` +
        `be confirmed.`,
    );
    return false;
  }

  if (!isBelow(version, FIRST_PATCHED)) {
    console.log(
      `${TAG} bundled brace-expansion is ${version} (>= ${FIRST_PATCHED.join('.')}) — ` +
        `not vulnerable, keeping it. This script is now obsolete: drop it, its ` +
        `postinstall/prepare hooks, and the overrides pin.`,
    );
    return false;
  }

  try {
    fs.rmSync(NESTED_DIR, { recursive: true, force: true });
    console.log(
      `${TAG} removed bundled brace-expansion@${version} from node_modules. The ` +
        `bundled minimatch now resolves to the patched top-level copy.`,
    );
    return true;
  } catch (err) {
    // Never fail the install over a hardening step — but never hide it either.
    console.warn(
      `${TAG} WARNING: could not remove ${NESTED_DIR} (${err.message}). The ` +
        `vulnerable brace-expansion@${version} is STILL PRESENT on disk. ` +
        `Re-run "npm run prune-bundled-cve" to retry.`,
    );
    return false;
  }
}

function main() {
  const lockPruned = pruneLockfile();
  const dirPruned = pruneNodeModules();

  if (!lockPruned && !dirPruned) {
    // Say which case this is. A silent "nothing to do" is exactly how this
    // guard would rot unnoticed after an upstream change.
    console.log(
      `${TAG} nothing to prune — already clean, or aws-cdk-lib changed its ` +
        `bundling. If it no longer bundles brace-expansion, delete this script, ` +
        `its postinstall/prepare hooks, and the overrides pin.`,
    );
  }
}

main();
