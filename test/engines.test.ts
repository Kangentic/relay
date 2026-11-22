/**
 * package.json's `engines.node` must never admit a Node version that some installed package then
 * refuses. `.npmrc` sets `engine-strict=true`, so such a version passes this repo's own check and
 * then fails the install outright on the dependency, which is the trap @sentry/node opened
 * (`>=20.19.0 <22.0.0 || >=22.12.0 <23.0.0 || >=23.2.0`) against the old `>=20 <23`.
 *
 * Dev dependencies count: every documented install path (the Dockerfile's build stage, CI, a
 * contributor's `npm install`) runs a full install under engine-strict. Optional packages do not:
 * npm skips an optional package whose engines do not match rather than failing the install.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import semver from 'semver';
import { describe, expect, it } from 'vitest';

interface LockfileEntry {
  readonly optional?: boolean;
  readonly engines?: { readonly node?: string };
}

const REPO_ROOT = path.join(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
  engines: { node: string };
};
const lockfile = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package-lock.json'), 'utf8')) as {
  packages: Record<string, LockfileEntry>;
};
const declaredRange = manifest.engines.node;

describe('the declared Node range', () => {
  it('is accepted by every non-optional package in the lockfile', () => {
    const refusals: string[] = [];
    for (const [key, entry] of Object.entries(lockfile.packages)) {
      if (key === '' || entry.optional === true) continue;
      const packageRange = entry.engines?.node;
      if (typeof packageRange !== 'string') continue;
      if (!semver.subset(declaredRange, packageRange)) refusals.push(`${key} requires ${packageRange}`);
    }
    expect(refusals, `narrow engines.node in package.json to the intersection`).toEqual([]);
  });

  it('matches the copy npm keeps at the lockfile root', () => {
    expect(lockfile.packages['']?.engines?.node).toBe(declaredRange);
  });

  it('still covers the Node versions CI and the image actually run', () => {
    // checks.yml's matrix resolves 20 to the final 20.x release, and the image's
    // node:22-bookworm-slim and CI's 22 to a current 22.x.
    expect(semver.satisfies('20.20.2', declaredRange)).toBe(true);
    expect(semver.satisfies('22.23.4', declaredRange)).toBe(true);
  });
});
