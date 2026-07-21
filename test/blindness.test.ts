import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * A directory listing embedded here (rather than a runtime `fs.readdir`
 * walk) so this check has zero dependency on how the test runner resolves
 * glob patterns. Update this list when adding a new src/ file - the
 * omission would be caught immediately by any of the other test files
 * failing to import it, so keeping this list current is low-risk.
 */
const SRC_FILES = [
  'admission.ts',
  'closeCodes.ts',
  'config.ts',
  'connection.ts',
  'index.ts',
  'keepalive.ts',
  'logging.ts',
  'rendezvous.ts',
  'server.ts',
  'types.ts',
  'wireData.ts',
  'guards/caps.ts',
  'guards/rateLimit.ts',
  'guards/slotFormat.ts',
  'http/health.ts',
  'http/landing.ts',
  'http/metrics.ts',
  'net/clientIp.ts',
];

describe('the relay stays blind: no runtime import of @kangentic/protocol', () => {
  for (const relativePath of SRC_FILES) {
    it(`src/${relativePath} does not import @kangentic/protocol`, () => {
      const contents = readFileSync(path.join(import.meta.dirname, '..', 'src', relativePath), 'utf8');
      expect(contents).not.toMatch(/from\s+['"]@kangentic\/protocol['"]/);
      expect(contents).not.toMatch(/require\(\s*['"]@kangentic\/protocol['"]\s*\)/);
    });
  }
});
