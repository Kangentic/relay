import type { Config, LogLevel } from './types.js';

const LOG_LEVELS: readonly LogLevel[] = ['error', 'warn', 'info', 'debug'];

class ConfigError extends Error {
  constructor(variableName: string, reason: string) {
    super(`Invalid config for ${variableName}: ${reason}`);
    this.name = 'ConfigError';
  }
}

function readInt(env: NodeJS.ProcessEnv, name: string, defaultValue: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    throw new ConfigError(name, `expected a non-negative integer, got "${raw}"`);
  }
  return parsed;
}

function readBoolean(env: NodeJS.ProcessEnv, name: string, defaultValue: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === '') return defaultValue;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new ConfigError(name, `expected "true" or "false", got "${raw}"`);
}

function readString(env: NodeJS.ProcessEnv, name: string, defaultValue: string): string {
  const raw = env[name];
  return raw === undefined || raw === '' ? defaultValue : raw;
}

function readOptionalString(env: NodeJS.ProcessEnv, name: string): string | null {
  const raw = env[name];
  return raw === undefined || raw === '' ? null : raw;
}

function readLogLevel(env: NodeJS.ProcessEnv, name: string, defaultValue: LogLevel): LogLevel {
  const raw = readString(env, name, defaultValue);
  if (!LOG_LEVELS.includes(raw as LogLevel)) {
    throw new ConfigError(name, `expected one of ${LOG_LEVELS.join(', ')}, got "${raw}"`);
  }
  return raw as LogLevel;
}

function readRegExp(env: NodeJS.ProcessEnv, name: string, defaultValue: string): RegExp {
  const raw = readString(env, name, defaultValue);
  try {
    return new RegExp(raw);
  } catch (error) {
    throw new ConfigError(name, `not a valid regular expression: ${String(error)}`);
  }
}

function readCidrList(env: NodeJS.ProcessEnv, name: string): readonly string[] {
  const raw = env[name];
  if (raw === undefined || raw === '') return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function randomSalt(): string {
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

/** Parses and validates every relay env var into a frozen Config. Fails fast on bad input. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const config: Config = {
    port: readInt(env, 'PORT', 8080),
    bindAddress: readString(env, 'BIND_ADDRESS', '0.0.0.0'),
    wsPath: readString(env, 'WS_PATH', '/'),
    slotIdPattern: readRegExp(env, 'SLOT_ID_PATTERN', '^[0-9a-f]{64}$'),
    maxConnections: readInt(env, 'MAX_CONNECTIONS', 10_000),
    maxConnectionsPerIp: readInt(env, 'MAX_CONNECTIONS_PER_IP', 20),
    maxConnectionsPerSlot: readInt(env, 'MAX_CONNECTIONS_PER_SLOT', 2),
    rateLimitIpPerMinute: readInt(env, 'RATE_LIMIT_IP_PER_MIN', 120),
    rateLimitIpBurst: readInt(env, 'RATE_LIMIT_IP_BURST', 40),
    rateLimitSlotPerMinute: readInt(env, 'RATE_LIMIT_SLOT_PER_MIN', 60),
    rateLimitSlotBurst: readInt(env, 'RATE_LIMIT_SLOT_BURST', 20),
    maxMessageBytes: readInt(env, 'MAX_MESSAGE_BYTES', 1_114_112),
    maxSessionBytes: readInt(env, 'MAX_SESSION_BYTES', 1_073_741_824),
    maxParkedBufferBytes: readInt(env, 'MAX_PARKED_BUFFER_BYTES', 1_048_576),
    maxBufferedBytes: readInt(env, 'MAX_BUFFERED_BYTES', 4_194_304),
    pingIntervalMs: readInt(env, 'PING_INTERVAL_MS', 30_000),
    parkTimeoutMs: readInt(env, 'PARK_TIMEOUT_MS', 60_000),
    maxSessionMs: readInt(env, 'MAX_SESSION_MS', 0),
    shutdownGraceMs: readInt(env, 'SHUTDOWN_GRACE_MS', 10_000),
    trustProxy: readBoolean(env, 'TRUST_PROXY', false),
    trustedProxyCidrs: readCidrList(env, 'TRUSTED_PROXY_CIDRS'),
    ipv6PrefixBits: readInt(env, 'IPV6_PREFIX_BITS', 64),
    metricsEnabled: readBoolean(env, 'METRICS_ENABLED', true),
    metricsToken: readOptionalString(env, 'METRICS_TOKEN'),
    logLevel: readLogLevel(env, 'LOG_LEVEL', 'info'),
    logSlotHashing: readBoolean(env, 'LOG_SLOT_HASHING', true),
    slotLogSalt: readString(env, 'SLOT_LOG_SALT', randomSalt()),
    admissionWebhookUrl: readOptionalString(env, 'ADMISSION_WEBHOOK_URL'),
    admissionWebhookTimeoutMs: readInt(env, 'ADMISSION_WEBHOOK_TIMEOUT_MS', 3_000),
    admissionFailOpen: readBoolean(env, 'ADMISSION_FAIL_OPEN', true),
  };

  if (config.port < 1 || config.port > 65_535) {
    throw new ConfigError('PORT', `must be between 1 and 65535, got ${config.port}`);
  }
  if (config.ipv6PrefixBits < 1 || config.ipv6PrefixBits > 128) {
    throw new ConfigError('IPV6_PREFIX_BITS', `must be between 1 and 128, got ${config.ipv6PrefixBits}`);
  }
  if (config.maxConnectionsPerSlot < 1) {
    throw new ConfigError('MAX_CONNECTIONS_PER_SLOT', 'must be at least 1');
  }

  return Object.freeze(config);
}
