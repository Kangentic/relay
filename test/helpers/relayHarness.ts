import { loadConfig } from '../../src/config.js';
import { createRelay, type RelayDeps } from '../../src/server.js';
import type { Config } from '../../src/types.js';

export interface RelayHarness {
  readonly url: string;
  readonly config: Config;
  readonly metrics: ReturnType<typeof createRelay>['metrics'];
  /** For asserting what the relay registered on its server, e.g. that an opt-in feature added no listener. */
  readonly httpServer: ReturnType<typeof createRelay>['httpServer'];
  close(): Promise<void>;
}

/** Starts a relay on an ephemeral loopback port for a test, with overridable config/deps. */
export async function startTestRelay(
  configOverrides: Partial<Config> = {},
  deps: RelayDeps = {},
): Promise<RelayHarness> {
  const baseConfig = loadConfig({});
  const config: Config = Object.freeze({ ...baseConfig, port: 0, bindAddress: '127.0.0.1', ...configOverrides });
  const relay = createRelay(config, deps);
  const { port } = await relay.listen();

  return {
    url: `ws://127.0.0.1:${port}`,
    config,
    metrics: relay.metrics,
    httpServer: relay.httpServer,
    close: () => relay.close(),
  };
}
