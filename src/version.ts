import { readFileSync } from 'node:fs';

/**
 * This package's own manifest, located relative to this module rather than to the process working
 * directory so it resolves the same way everywhere: `src/version.ts` under `tsx`, `dist/version.js`
 * in the runtime image (the build mirrors `src/` into `dist/`, and the Dockerfile copies
 * `package.json` in beside it), and the source path under Vitest.
 *
 * A static JSON import would read better but would place `package.json` outside
 * `tsconfig.build.json`'s `rootDir`, which fails `npm run build` while `npm run typecheck` still
 * passes - an asymmetry that would only surface in CI.
 */
const RELAY_MANIFEST_URL = new URL('../package.json', import.meta.url);

/**
 * The `version` string from a package manifest, or undefined if the file is missing, unreadable,
 * not JSON, or carries no usable version. Takes the location as an argument so both failure
 * branches are testable without mocking `node:fs`.
 */
export function readVersionFromManifest(manifestUrl: URL): string | undefined {
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestUrl, 'utf8'));
  } catch {
    return undefined;
  }
  if (typeof manifest !== 'object' || manifest === null || !('version' in manifest)) {
    return undefined;
  }
  const { version } = manifest;
  return typeof version === 'string' && version.length > 0 ? version : undefined;
}

/**
 * Resolved once at module load, deliberately without throwing: the version is a cosmetic field on
 * the liveness endpoint, so an absent or malformed manifest must not take `/healthz` down with it.
 * It stays undefined in that case, which makes `JSON.stringify` drop the key entirely rather than
 * publish a sentinel like "unknown" that a client would render verbatim.
 */
export const RELAY_VERSION: string | undefined = readVersionFromManifest(RELAY_MANIFEST_URL);
