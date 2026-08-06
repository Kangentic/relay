import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { createLogger } from '../src/logging.js';
import { SRC_ROOT, everySourceFile } from './helpers/sourceFiles.js';

/**
 * The relay's privacy claim about the pairing graph is that a raw slot id
 * never reaches a log line. Today that holds for the strongest possible
 * reason: no log call site passes a slot at all. Nothing enforced that, so
 * this file does, because the claim is only worth documenting if a future
 * `logger.info('paired', { slot: conn.slot })` fails the build. The files
 * come from the same src/ walk the blindness test uses, so a brand-new
 * module is scanned without anyone remembering to list it.
 */

describe('slot ids never reach a log line', () => {
  it.each(everySourceFile())('src/%s passes no slot-derived field to a logger call', (relativePath) => {
    const contents = readFileSync(path.join(SRC_ROOT, relativePath), 'utf8');
    // Matches a logger call whose fields object mentions a slot, e.g.
    // logger.info('paired', { slot: conn.slot }) or { slotId }.
    const loggerCallWithSlotField = /(?:logger|log)\.(?:error|warn|info|debug)\s*\([^)]*\bslot/i;
    expect(contents).not.toMatch(loggerCallWithSlotField);
  });

  it('routes any future slot logging through slotRef rather than the raw value', () => {
    // slotRef is currently uncalled. If a call site is ever added, it must be
    // this one, so the salted-hash behavior below is what ships.
    const logger = createLogger({ logLevel: 'info', logSlotHashing: true, slotLogSalt: 'test-salt' });
    const slotId = 'a'.repeat(64);
    const reference = logger.slotRef(slotId);

    expect(reference).not.toBe(slotId);
    expect(reference).not.toContain(slotId);
    expect(reference.length).toBeLessThan(slotId.length);
  });

  it('produces a stable reference for one salt and a different one for another', () => {
    const slotId = 'b'.repeat(64);
    const first = createLogger({ logLevel: 'info', logSlotHashing: true, slotLogSalt: 'salt-one' });
    const second = createLogger({ logLevel: 'info', logSlotHashing: true, slotLogSalt: 'salt-two' });

    expect(first.slotRef(slotId)).toBe(first.slotRef(slotId));
    expect(first.slotRef(slotId)).not.toBe(second.slotRef(slotId));
  });

  it('returns the raw slot when hashing is disabled, which is why no call site may exist', () => {
    const slotId = 'c'.repeat(64);
    const logger = createLogger({ logLevel: 'info', logSlotHashing: false, slotLogSalt: 'test-salt' });
    expect(logger.slotRef(slotId)).toBe(slotId);
  });
});
