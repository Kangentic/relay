import { createHash } from 'node:crypto';
import type { Config, LogLevel } from './types.js';

const LEVEL_RANK: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

export interface Logger {
  error(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  debug(message: string, fields?: Record<string, unknown>): void;
  /**
   * Hashes a slot id for a log line under the configured salt (or returns it
   * unmodified when LOG_SLOT_HASHING is disabled). Never log a raw slot id
   * directly: two peers' co-occurring slot hashes still form a pairing
   * graph, but a raw slot is a bearer secret for that rendezvous.
   */
  slotRef(slotId: string): string;
}

function write(level: LogLevel, minimumLevel: LogLevel, message: string, fields?: Record<string, unknown>): void {
  if (LEVEL_RANK[level] > LEVEL_RANK[minimumLevel]) return;
  const line = { time: new Date().toISOString(), level, message, ...fields };
  const target = level === 'error' || level === 'warn' ? console.error : console.log;
  target(JSON.stringify(line));
}

export function createLogger(config: Pick<Config, 'logLevel' | 'logSlotHashing' | 'slotLogSalt'>): Logger {
  return {
    error: (message, fields) => write('error', config.logLevel, message, fields),
    warn: (message, fields) => write('warn', config.logLevel, message, fields),
    info: (message, fields) => write('info', config.logLevel, message, fields),
    debug: (message, fields) => write('debug', config.logLevel, message, fields),
    slotRef: (slotId) => {
      if (!config.logSlotHashing) return slotId;
      return createHash('sha256').update(config.slotLogSalt).update(slotId).digest('base64url').slice(0, 12);
    },
  };
}
