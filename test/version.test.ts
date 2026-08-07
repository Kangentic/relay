import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readVersionFromManifest, RELAY_VERSION } from '../src/version.js';

const RELAY_MANIFEST_URL = new URL('../package.json', import.meta.url);

describe('readVersionFromManifest', () => {
  let fixtureDirectory: string;

  beforeAll(() => {
    fixtureDirectory = mkdtempSync(join(tmpdir(), 'relay-version-'));
  });

  afterAll(() => {
    rmSync(fixtureDirectory, { recursive: true, force: true });
  });

  // Each malformed-manifest case gets a file written for it rather than borrowing an unrelated
  // repo file. Borrowing is what makes this kind of test rot silently: tsconfig.json growing a
  // `//` comment, for instance, would move the "parses but has no version" case onto the
  // JSON.parse catch branch while the assertion stayed green either way.
  function manifestFixture(fileName: string, contents: string): URL {
    const fixturePath = join(fixtureDirectory, fileName);
    writeFileSync(fixturePath, contents, 'utf8');
    return pathToFileURL(fixturePath);
  }

  it('reads the version out of the relay manifest', () => {
    // Compared against an independently parsed manifest, not against RELAY_VERSION, which this
    // same function computed from this same URL and so cannot falsify anything on its own.
    const manifest: unknown = JSON.parse(readFileSync(RELAY_MANIFEST_URL, 'utf8'));
    const { version: manifestVersion } = manifest as { version?: unknown };
    expect(typeof manifestVersion).toBe('string');

    expect(readVersionFromManifest(RELAY_MANIFEST_URL)).toBe(manifestVersion);
    expect(RELAY_VERSION).toBe(manifestVersion);
    expect(RELAY_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  // The version is a cosmetic field on the liveness endpoint, so none of the failure modes below
  // may throw: an unreadable manifest must degrade to no version at all rather than take
  // /healthz down with it.
  it('returns undefined when the manifest is missing', () => {
    expect(readVersionFromManifest(new URL('./no-such-manifest.json', import.meta.url))).toBeUndefined();
  });

  it('returns undefined when the manifest is not JSON', () => {
    expect(readVersionFromManifest(manifestFixture('not-json.json', 'not json at all'))).toBeUndefined();
  });

  it('returns undefined when the JSON parses to something that is not an object', () => {
    expect(readVersionFromManifest(manifestFixture('scalar.json', '"0.2.1"'))).toBeUndefined();
  });

  it('returns undefined when the JSON parses but carries no version', () => {
    expect(readVersionFromManifest(manifestFixture('no-version.json', '{"name":"relay"}'))).toBeUndefined();
  });

  // The two guards below are what stop a malformed version from reaching the wire, where
  // JSON.stringify would happily coerce it into the /healthz body.
  it('returns undefined when version is present but not a string', () => {
    expect(readVersionFromManifest(manifestFixture('numeric-version.json', '{"version":3}'))).toBeUndefined();
  });

  it('returns undefined when version is an empty string', () => {
    expect(readVersionFromManifest(manifestFixture('empty-version.json', '{"version":""}'))).toBeUndefined();
  });
});
