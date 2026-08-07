import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startTestRelay, type RelayHarness } from './helpers/relayHarness.js';
import { connectTestClient } from './helpers/wsClient.js';
import type { Logger } from '../src/logging.js';

let relay: RelayHarness | undefined;
let directory: string | undefined;

afterEach(async () => {
  await relay?.close();
  relay = undefined;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

function httpBase(harness: RelayHarness): string {
  return harness.url.replace('ws://', 'http://');
}

function collectingLogger(lines: { level: string; message: string }[]): Logger {
  const record = (level: string) => (message: string) => {
    lines.push({ level, message });
  };
  return {
    error: record('error'),
    warn: record('warn'),
    info: record('info'),
    debug: record('debug'),
    slotRef: (slotId: string) => slotId,
  };
}

describe('/admin when disabled', () => {
  it('404s both routes, indistinguishable from any other unknown path', async () => {
    relay = await startTestRelay({ adminEnabled: false });
    const base = httpBase(relay);

    expect((await fetch(`${base}/admin`)).status).toBe(404);
    expect((await fetch(`${base}/admin/data`)).status).toBe(404);
    // The same 404 an unrelated path gets, so the surface is not advertised.
    expect((await fetch(`${base}/nothing-here`)).status).toBe(404);
  });

  it('builds no recorder at all, so no timer, no sampler and no file exist', async () => {
    directory = await mkdtemp(join(tmpdir(), 'relay-admin-'));
    const historyPath = join(directory, 'history.ndjson');

    relay = await startTestRelay({
      adminEnabled: false,
      metricsHistoryPath: null,
      metricsAllowUnauthenticated: true,
    });

    expect(existsSync(historyPath)).toBe(false);
    // A null recorder is what removes these keys: they are only reported when
    // one exists, so their absence is the observable proof of "off by default".
    const body = (await (await fetch(`${httpBase(relay)}/metricz`)).json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('historyRecorderHealthy');
    expect(body['eventLoopLagP99Ms']).toBeNull();
  });
});

describe('/admin when enabled', () => {
  it('serves a self-contained page that makes no external requests', async () => {
    relay = await startTestRelay({ adminEnabled: true });
    const response = await fetch(`${httpBase(relay)}/admin`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(html).toContain('Kangentic Relay');
    // Conventional ranges, plus the client-derived Live view. data-range="0" is
    // the sentinel for "draw from the poll series, do not query history".
    for (const range of ['data-range="0"', '1h', '6h', '24h', '7d', '30d', '1y']) {
      expect(html).toContain(range);
    }
    // A private operational page must not pull in third-party script or fonts.
    expect(html).not.toMatch(/src="https?:\/\//);
    expect(html).not.toMatch(/href="https?:\/\/[^"]*\.(css|js)/);
    expect(html).not.toContain('cdn.');
  });

  it('ships an inline script that actually parses', async () => {
    // The dashboard's JavaScript is hand-written inside a template literal, so
    // nothing else in the toolchain ever compiles it: no bundler, no tsc, no
    // lint pass. A typo would ship a blank page that every other test here
    // still reports as 200 with the right headers.
    relay = await startTestRelay({ adminEnabled: true });
    const html = await (await fetch(`${httpBase(relay)}/admin`)).text();

    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1] ?? '');
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) {
      // Compiles without executing, so this is a pure syntax assertion.
      expect(() => new Function(script)).not.toThrow();
    }
  });

  it('defines dark under both the media query and the explicit theme stamp', async () => {
    // The media query alone cannot serve a toggle: on a light OS no dark media
    // block ever matches, so stamping data-theme="dark" would change nothing
    // and the switch would look broken to exactly the people who wanted it.
    relay = await startTestRelay({ adminEnabled: true });
    const html = await (await fetch(`${httpBase(relay)}/admin`)).text();

    expect(html).toContain('@media (prefers-color-scheme: dark)');
    // Guarded, so an explicit light choice still beats an OS set to dark.
    expect(html).toContain(':root:not([data-theme="light"])');
    expect(html).toContain(':root[data-theme="dark"]');

    // Both scopes must actually carry the dark steps, not just exist.
    const darkStepCount = html.split('--surface-1: #1a1a19').length - 1;
    expect(darkStepCount).toBe(2);
    // Applied before first paint so a stored dark choice does not flash light.
    expect(html.indexOf('relayAdminTheme')).toBeLessThan(html.indexOf('<style>'));
  });

  it('exposes the theme control as a two-state switch, not a labelled button', async () => {
    // A cycling text button made you read a word to learn the current theme and
    // guess what the next press would do. A sun/moon switch shows both
    // destinations at once, which is why it carries no text at all.
    relay = await startTestRelay({ adminEnabled: true });
    const html = await (await fetch(`${httpBase(relay)}/admin`)).text();

    const control = html.slice(html.indexOf('id="themeToggle"'));
    expect(control.slice(0, 200)).toContain('role="switch"');
    // Text-free, so it needs a name of its own for a screen reader.
    expect(control.slice(0, 200)).toContain('aria-label="Dark mode"');
    expect(control.slice(0, control.indexOf('</button>'))).toContain('class="glyph sun"');
    expect(control.slice(0, control.indexOf('</button>'))).toContain('class="glyph moon"');
    // No "System" position: following the system is the unset state, so nothing
    // is written until an explicit flip.
    expect(html).not.toContain('THEME_ORDER');
    expect(html).toContain('localStorage.setItem(THEME_KEY, theme)');
  });

  it('inlines a brandmark that can actually scale', async () => {
    // The vendored asset has width/height but no viewBox. That is fine for a
    // data-URI favicon and broken inline: with no viewBox there is no mapping
    // to the element box, so the mark ignores its 30px container and paints
    // across the entire page. Rendered output is the only place this shows up.
    relay = await startTestRelay({ adminEnabled: true });
    const html = await (await fetch(`${httpBase(relay)}/admin`)).text();

    const inlineMark = html.slice(html.indexOf('class="mark"'), html.indexOf('</span>', html.indexOf('class="mark"')));
    expect(inlineMark).toContain('<svg');
    expect(inlineMark).toContain('viewBox="0 0 512 512"');
    expect(inlineMark).not.toContain('width="512"');
  });

  it('warns at startup that the relay does not authenticate the surface', async () => {
    const lines: { level: string; message: string }[] = [];
    relay = await startTestRelay({ adminEnabled: true }, { logger: collectingLogger(lines) });

    const warning = lines.find((line) => line.level === 'warn' && line.message.includes('NOT authenticated'));
    expect(warning).toBeDefined();
  });

  it('answers /admin/data with live counters and a cursor', async () => {
    relay = await startTestRelay({ adminEnabled: true });
    const body = (await (await fetch(`${httpBase(relay)}/admin/data`)).json()) as {
      live: Record<string, unknown>;
      rows: unknown[];
      cursorMs: number;
      meta: Record<string, unknown>;
    };

    expect(body.live).toHaveProperty('activeConnections');
    expect(body.live).toHaveProperty('closedByCause');
    expect(body.meta['historyEnabled']).toBe(true);
    // No path configured, so the recorder is memory-only by design.
    expect(body.meta['historyPersistence']).toBe('memory');
    expect(Array.isArray(body.rows)).toBe(true);
  });

  it('reflects a live pairing in the counters it reports', async () => {
    relay = await startTestRelay({ adminEnabled: true });
    const slotId = 'a'.repeat(64);
    const peerA = await connectTestClient(relay.url, slotId);
    const peerB = await connectTestClient(relay.url, slotId);
    peerA.send(Buffer.from([1, 2, 3]));
    await peerB.nextMessage();

    const body = (await (await fetch(`${httpBase(relay)}/admin/data`)).json()) as {
      live: { activeConnections: number; pairedSlots: number; framesForwardedTotal: number };
    };
    expect(body.live.activeConnections).toBe(2);
    expect(body.live.pairedSlots).toBe(1);
    expect(body.live.framesForwardedTotal).toBe(1);

    peerA.close();
    peerB.close();
  });

  it('leaks no slot id, no IP address and no frame content', async () => {
    relay = await startTestRelay({ adminEnabled: true });
    const slotId = 'b3c4'.repeat(16);
    const peerA = await connectTestClient(relay.url, slotId);
    const peerB = await connectTestClient(relay.url, slotId);
    peerA.send(Buffer.from('sensitive-payload-marker'));
    await peerB.nextMessage();

    const raw = await (await fetch(`${httpBase(relay)}/admin/data`)).text();
    // The dashboard inherits the MetricsSnapshot guarantee: aggregates only.
    expect(raw).not.toContain(slotId);
    expect(raw).not.toContain('127.0.0.1');
    expect(raw).not.toContain('sensitive-payload-marker');

    peerA.close();
    peerB.close();
  });

  it('serves a gzip-encoded body when the client accepts it', async () => {
    relay = await startTestRelay({ adminEnabled: true });
    const response = await fetch(`${httpBase(relay)}/admin/data`, { headers: { 'accept-encoding': 'gzip' } });
    const body = (await response.json()) as { meta: Record<string, unknown> };
    // Decoding happens transparently, so a correct parse is the proof the
    // compressed path produced a valid body.
    expect(response.status).toBe(200);
    expect(body.meta).toHaveProperty('serverTimeMs');
  });

  it('persists rows to the configured path and serves them back', async () => {
    directory = await mkdtemp(join(tmpdir(), 'relay-admin-'));
    const historyPath = join(directory, 'history.ndjson');

    relay = await startTestRelay({
      adminEnabled: true,
      metricsHistoryPath: historyPath,
      metricsHistoryIntervalMs: 1_000,
    });

    const body = (await (await fetch(`${httpBase(relay)}/admin/data`)).json()) as { meta: Record<string, unknown> };
    expect(body.meta['historyPersistence']).toBe('file');
    expect(body.meta['recorderHealthy']).toBe(true);

    // Closing flushes a final row, which proves the whole path end to end.
    await relay.close();
    relay = undefined;
    expect(existsSync(historyPath)).toBe(true);
  });

  it('sends every field the page reads, so a rename cannot silently blank the charts', async () => {
    // The page and the endpoint are only coupled by these names. Rename one in
    // admin.ts and the charts go empty while every status code stays 200.
    directory = await mkdtemp(join(tmpdir(), 'relay-admin-'));
    relay = await startTestRelay({
      adminEnabled: true,
      metricsHistoryPath: join(directory, 'history.ndjson'),
      metricsHistoryIntervalMs: 1_000,
    });
    const base = httpBase(relay);

    let payload = { rows: [] as Record<string, unknown>[], live: {}, meta: {}, cursorMs: 0 };
    const deadline = Date.now() + 6_000;
    while (payload.rows.length === 0 && Date.now() < deadline) {
      payload = (await (await fetch(`${base}/admin/data?range=3600000`)).json()) as typeof payload;
    }
    expect(payload.rows.length).toBeGreaterThan(0);

    for (const key of [
      'activeConnections',
      'waitingSlots',
      'pairedSlots',
      'sessionsTotal',
      'bytesForwardedTotal',
      'uptimeSeconds',
      'cpuPercent',
      'eventLoopLagP99Ms',
      'rssPercent',
      'rssBytes',
    ]) {
      expect(payload.live).toHaveProperty(key);
    }
    for (const key of [
      'serverTimeMs',
      'historyPersistence',
      'ringCapacity',
      'intervalMs',
      'recorderHealthy',
      'truncated',
      'skippedLineCount',
      'instanceId',
      'capacity',
    ]) {
      expect(payload.meta).toHaveProperty(key);
    }
    // Without the ceilings the dashboard can show a number but not whether it
    // is close to anything, which is the whole point of the headroom tiles.
    const capacity = (payload.meta as { capacity: Record<string, unknown> }).capacity;
    for (const key of ['maxConnections', 'maxUnpairedConnections', 'maxBufferedBytes', 'memoryLimitBytes']) {
      expect(capacity).toHaveProperty(key);
    }
    const row = payload.rows[0];
    if (row === undefined) throw new Error('expected a row');
    for (const key of [
      'timestampMs',
      'windowMs',
      'restartCount',
      'framesForwardedDelta',
      'bytesForwardedDelta',
      'connectionsDelta',
      'sessionsDelta',
      'rejectsByReasonDelta',
      'closedByCause',
      'maxOutboundBufferBytes',
      'backloggedConnections',
      'maxParkedBufferBytes',
    ]) {
      expect(row).toHaveProperty(key);
    }
    // The charts read `.maximum` off each gauge, not a bare number.
    expect(row['activeConnections']).toHaveProperty('maximum');
    expect(row['waitingSlots']).toHaveProperty('maximum');
    expect(row['pairedSlots']).toHaveProperty('maximum');
  });

  it('samples live connection queue depth into the recorded rows', async () => {
    // The relay has no per-frame latency metric by design, so outbound queue
    // depth is the only signal that a consumer is falling behind. If this is
    // not wired the charts render an honest-looking flat line forever.
    directory = await mkdtemp(join(tmpdir(), 'relay-admin-'));
    relay = await startTestRelay({
      adminEnabled: true,
      metricsHistoryPath: join(directory, 'history.ndjson'),
      metricsHistoryIntervalMs: 1_000,
    });
    const slotId = 'e'.repeat(64);
    const peerA = await connectTestClient(relay.url, slotId);
    const peerB = await connectTestClient(relay.url, slotId);
    peerA.send(Buffer.alloc(4_096, 7));
    await peerB.nextMessage();

    let rows: { maxOutboundBufferBytes: number | null; backloggedConnections: number | null }[] = [];
    const deadline = Date.now() + 6_000;
    while (rows.length === 0 && Date.now() < deadline) {
      const body = (await (await fetch(`${httpBase(relay)}/admin/data?range=3600000`)).json()) as {
        rows: typeof rows;
      };
      rows = body.rows;
    }
    expect(rows.length).toBeGreaterThan(0);
    // Sampled, so a number rather than the null an unwired sampler would leave.
    expect(typeof rows[rows.length - 1]?.maxOutboundBufferBytes).toBe('number');
    expect(typeof rows[rows.length - 1]?.backloggedConnections).toBe('number');

    peerA.close();
    peerB.close();
  });

  it('samples the pre-pair buffer of a peer still waiting for its partner', async () => {
    // The other queue-depth test pairs both peers first, so nothing is ever
    // parked and maxParkedBufferBytes stays 0 throughout it. Pre-pair buffering
    // is its own path (it is how the first-pairing handshake travels), and
    // wiring pendingBytes to the wrong field would go unnoticed without this.
    directory = await mkdtemp(join(tmpdir(), 'relay-admin-'));
    relay = await startTestRelay({
      adminEnabled: true,
      metricsHistoryPath: join(directory, 'history.ndjson'),
      metricsHistoryIntervalMs: 1_000,
    });
    // No partner, so these bytes stay in the pre-pair buffer rather than being
    // forwarded and forgotten.
    const parkedPeer = await connectTestClient(relay.url, 'f'.repeat(64));
    parkedPeer.send(Buffer.alloc(4_096, 3));

    let maxParkedBufferBytes = 0;
    // Inside the 5s default test timeout on purpose: a regression here should
    // fail on the assertion, saying what was wrong, not as a bare timeout. One
    // 1s recorder tick is all this needs.
    const deadline = Date.now() + 3_500;
    while (maxParkedBufferBytes === 0 && Date.now() < deadline) {
      const body = (await (await fetch(`${httpBase(relay)}/admin/data?range=3600000`)).json()) as {
        rows: { maxParkedBufferBytes: number | null }[];
      };
      maxParkedBufferBytes = body.rows[body.rows.length - 1]?.maxParkedBufferBytes ?? 0;
    }
    expect(maxParkedBufferBytes).toBeGreaterThanOrEqual(4_096);

    parkedPeer.close();
  });

  it('answers a live cursor from the ring, and only a cold one from the file', async () => {
    // What makes an open dashboard nearly free: the 2-second poll must be
    // served from memory. A cursor the ring cannot cover falls through to a
    // whole-file stream, which is correct but is a page-load cost, not a poll
    // cost - so a page that polls with a stale or zero cursor would pay it
    // every time.
    directory = await mkdtemp(join(tmpdir(), 'relay-admin-'));
    relay = await startTestRelay({
      adminEnabled: true,
      metricsHistoryPath: join(directory, 'history.ndjson'),
      metricsHistoryIntervalMs: 1_000,
    });
    const base = httpBase(relay);

    let cursorMs = 0;
    const deadline = Date.now() + 3_500;
    while (cursorMs === 0 && Date.now() < deadline) {
      cursorMs = ((await (await fetch(`${base}/admin/data?range=3600000`)).json()) as { cursorMs: number })
        .cursorMs;
    }
    expect(cursorMs).toBeGreaterThan(0);

    const fromRing = (await (await fetch(`${base}/admin/data?since=${cursorMs}`)).json()) as {
      meta: { servedFrom: string };
    };
    expect(fromRing.meta.servedFrom).toBe('ring');

    // The epoch is older than the ring's oldest row, so this is the cold path.
    const fromFile = (await (await fetch(`${base}/admin/data?since=0`)).json()) as {
      meta: { servedFrom: string };
    };
    expect(fromFile.meta.servedFrom).toBe('file');
  });

  it('honors the since cursor, returning only newer rows', async () => {
    directory = await mkdtemp(join(tmpdir(), 'relay-admin-'));
    relay = await startTestRelay({
      adminEnabled: true,
      metricsHistoryPath: join(directory, 'history.ndjson'),
      metricsHistoryIntervalMs: 1_000,
    });
    const base = httpBase(relay);

    const first = (await (await fetch(`${base}/admin/data`)).json()) as { cursorMs: number };
    const second = (await (await fetch(`${base}/admin/data?since=${first.cursorMs}`)).json()) as {
      rows: { timestampMs: number }[];
    };
    for (const row of second.rows) expect(row.timestampMs).toBeGreaterThan(first.cursorMs);
  });
});
