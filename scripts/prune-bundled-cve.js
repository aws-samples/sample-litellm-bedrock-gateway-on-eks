#!/usr/bin/env node
/**
 * prune-bundled-cve.js — remove the vulnerable `brace-expansion` copy that
 * `aws-cdk-lib` ships inside its own published tarball.
 *
 * WHY THIS EXISTS
 * ---------------
 * `aws-cdk-lib` lists `minimatch` in its `bundledDependencies`, so the published
 * tarball carries a pre-resolved `node_modules/aws-cdk-lib/node_modules/` subtree
 * that includes `brace-expansion@5.0.7`. That version is vulnerable to
 * GHSA-mh99-v99m-4gvg (DoS via unbounded expansion, CVSS 7.5, fixed in 5.0.8).
 *
 * Bundled dependencies ship inside the tarball and are NOT resolved at install
 * time, so none of npm's normal levers reach them. All of the following were
 * tried and verified INEFFECTIVE against this copy:
 *   - `overrides: { "brace-expansion": "5.0.9" }`          (top-level)
 *   - `overrides: { "aws-cdk-lib": { "minimatch": ... } }` (nested/targeted)
 *   - `npm install --install-strategy=hoisted`
 *   - `.npmrc` with `bundled-dependencies=false`
 *
 * WHY DELETING IT IS SAFE
 * -----------------------
 * The bundled copy is redundant. Node resolves modules by walking up the
 * directory tree, so once the nested copy is gone, the bundled `minimatch`
 * resolves `brace-expansion` to the hoisted top-level copy, which this repo
 * pins to a patched release via `overrides`. Bundled `minimatch@^10.2.5`
 * accepts `brace-expansion@^5`, so 5.0.9 satisfies it.
 *
 * Verified empirically before adopting this approach:
 *   - bundled minimatch resolves to top-level brace-expansion 5.0.9
 *   - minimatch stays functional, including brace expansion (`src/{a,b}.ts`)
 *   - `cdk synth --all` exits 0 and emits all five stack templates
 *   - the full jest suite (121 tests) passes
 *
 * KNOWN LIMITATION
 * ----------------
 * This removes the vulnerable code from disk, but Dependabot analyses
 * `package-lock.json` statically, and npm always records the bundled entry
 * (`inBundle: true`) there because it comes from the tarball's metadata. The
 * alert therefore remains visible on GitHub even though the vulnerable file is
 * gone. Tracking the alert is a repo-settings decision; see docs/DECISIONS.md.
 *
 * Remove this script once aws-cdk-lib bundles brace-expansion >= 5.0.8.
 */

'use strict';

const fs = require('fs');
const path = require('path');

/** Versions strictly below this are vulnerable to GHSA-mh99-v99m-4gvg. */
const FIRST_PATCHED = [5, 0, 8];
const TARGET = path.join(
  __dirname,
  '..',
  'node_modules',
  'aws-cdk-lib',
  'node_modules',
  'brace-expansion',
);
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
  return false; // exactly equal to the floor => already patched
}

function main() {
  if (!fs.existsSync(TARGET)) {
    // Either already pruned, or aws-cdk-lib changed its bundling. Say which,
    // rather than silently reporting success — a quiet "nothing to do" is how
    // this guard would rot unnoticed after an upstream change.
    console.log(
      `${TAG} no bundled brace-expansion under aws-cdk-lib — nothing to prune ` +
        `(already pruned, or upstream changed its bundling; if aws-cdk-lib no ` +
        `longer bundles it, delete this script and its postinstall hook).`,
    );
    return;
  }

  let version = 'unknown';
  try {
    version = JSON.parse(
      fs.readFileSync(path.join(TARGET, 'package.json'), 'utf8'),
    ).version;
  } catch (err) {
    console.warn(
      `${TAG} WARNING: found ${TARGET} but could not read its package.json ` +
        `(${err.message}). Leaving it untouched — refusing to delete a directory ` +
        `whose version cannot be confirmed.`,
    );
    return;
  }

  if (!isBelow(version, FIRST_PATCHED)) {
    console.log(
      `${TAG} bundled brace-expansion is ${version} (>= ${FIRST_PATCHED.join('.')}), ` +
        `not vulnerable to GHSA-mh99-v99m-4gvg — keeping it. This script is now ` +
        `obsolete and can be removed along with its postinstall hook.`,
    );
    return;
  }

  try {
    fs.rmSync(TARGET, { recursive: true, force: true });
    console.log(
      `${TAG} removed bundled brace-expansion@${version} from aws-cdk-lib ` +
        `(GHSA-mh99-v99m-4gvg). The bundled minimatch now resolves to the ` +
        `patched top-level copy pinned in package.json overrides.`,
    );
  } catch (err) {
    // Never fail the install over a hardening step — but never hide it either.
    console.warn(
      `${TAG} WARNING: could not remove ${TARGET} (${err.message}). The ` +
        `vulnerable bundled brace-expansion@${version} is STILL PRESENT on disk. ` +
        `Install continues; re-run "npm run prune-bundled-cve" to retry.`,
    );
  }
}

main();
