import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { CLOSE_CODE } from '../src/closeCodes.js';
import { SRC_ROOT, everySourceFile } from './helpers/sourceFiles.js';

/**
 * Codes that exist in the enum but that the relay never sends, because the
 * situations they name are all resolved before a WebSocket exists (or with a
 * standard code). A client that waits for one of these waits forever, so if
 * a code leaves this list it has to leave the RESERVED block in
 * src/closeCodes.ts and the documentation at the same time.
 */
const RESERVED_NEVER_SENT = ['BAD_SLOT', 'SHUTTING_DOWN', 'IDLE_TIMEOUT'] as const;

describe('reserved close codes are never sent', () => {
  it.each(RESERVED_NEVER_SENT)('CLOSE_CODE.%s has no use outside its own declaration', (name) => {
    const usages = everySourceFile()
      .filter((relativePath) => path.basename(relativePath) !== 'closeCodes.ts')
      .filter((relativePath) => readFileSync(path.join(SRC_ROOT, relativePath), 'utf8').includes(`CLOSE_CODE.${name}`));

    expect(usages).toEqual([]);
  });

  it('documents every reserved code in the RESERVED block', () => {
    const source = readFileSync(path.join(SRC_ROOT, 'closeCodes.ts'), 'utf8');
    for (const name of RESERVED_NEVER_SENT) {
      const declaration = source.slice(0, source.indexOf(`${name}:`));
      expect(declaration).toContain('RESERVED');
    }
  });

  it('keeps every close code inside the private-use range', () => {
    for (const code of Object.values(CLOSE_CODE)) {
      expect(code).toBeGreaterThanOrEqual(4000);
      expect(code).toBeLessThanOrEqual(4999);
    }
  });

  it('assigns each close code a distinct number', () => {
    const codes = Object.values(CLOSE_CODE);
    expect(new Set(codes).size).toBe(codes.length);
  });
});
