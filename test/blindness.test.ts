import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { SRC_ROOT, everySourceFile, everyTypeScriptFile } from './helpers/sourceFiles.js';

const SRC_FILES = everySourceFile();

/**
 * Forms of importing @kangentic/protocol that must not appear in src/.
 * Bare `from '@kangentic/protocol'` is only the obvious one; a subpath
 * import, a dynamic import(), or a createRequire() call would each pull the
 * protocol package into the running relay just as effectively.
 */
const FORBIDDEN_IMPORT_FORMS: ReadonlyArray<{ readonly label: string; readonly pattern: RegExp }> = [
  { label: 'static import', pattern: /from\s+['"]@kangentic\/protocol(?:\/[^'"]*)?['"]/ },
  { label: 'require()', pattern: /require\(\s*['"]@kangentic\/protocol(?:\/[^'"]*)?['"]\s*\)/ },
  { label: 'dynamic import()', pattern: /import\(\s*['"`]@kangentic\/protocol(?:\/[^'"`]*)?['"`]\s*\)/ },
  { label: 'bare specifier reference', pattern: /['"`]@kangentic\/protocol/ },
];

describe('the relay stays blind: no runtime import of @kangentic/protocol', () => {
  it('finds the src/ tree to scan', () => {
    // Guards against a silently empty walk making every case below vacuous.
    expect(SRC_FILES.length).toBeGreaterThan(10);
    expect(SRC_FILES).toContain('server.ts');
    expect(SRC_FILES).toContain('rendezvous.ts');
  });

  it.each(SRC_FILES)('src/%s references @kangentic/protocol in no form', (relativePath) => {
    const contents = readFileSync(path.join(SRC_ROOT, relativePath), 'utf8');
    for (const { label, pattern } of FORBIDDEN_IMPORT_FORMS) {
      expect(contents, `${relativePath} must not contain a ${label} of @kangentic/protocol`).not.toMatch(
        pattern,
      );
    }
  });

  it('keeps @kangentic/protocol a devDependency, never a runtime dependency', () => {
    // The import scan proves no src/ file reaches for it; this proves a
    // deployed image would not even ship it.
    const manifest: unknown = JSON.parse(
      readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8'),
    );
    const { dependencies, devDependencies } = manifest as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(Object.keys(dependencies ?? {})).not.toContain('@kangentic/protocol');
    expect(Object.keys(devDependencies ?? {})).toContain('@kangentic/protocol');
  });

  it('imports the protocol package from exactly one test file', () => {
    const testRoot = import.meta.dirname;
    // This file is excluded because it names the package in its own match
    // patterns above, which is a mention rather than an import. The walk
    // recurses for the same reason the src/ one does: a helper under
    // test/helpers/ must not be able to pick the package up through a
    // directory this check never opened.
    const importers = everyTypeScriptFile(testRoot)
      .filter((relativePath) => relativePath !== 'blindness.test.ts')
      .filter((relativePath) =>
        /from\s+['"]@kangentic\/protocol['"]/.test(readFileSync(path.join(testRoot, relativePath), 'utf8')),
      );

    expect(importers).toEqual(['integration.protocol-handshake.test.ts']);
  });
});
