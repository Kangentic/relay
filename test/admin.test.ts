import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startTestRelay, type RelayHarness } from './helpers/relayHarness.js';
import { connectTestClient } from './helpers/wsClient.js';
import type { RejectReason } from '../src/closeCodes.js';
import { PEER_ROLES } from '../src/guards/peerRole.js';
import { ADMIN_PAGE_HTML } from '../src/http/adminPage.js';
import type { Logger } from '../src/logging.js';

let relay: RelayHarness | undefined;
let directory: string | undefined;

afterEach(async () => {
  await relay?.close();
  relay = undefined;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

/**
 * Lifts a declaration out of the page's inline script so it can be called
 * directly. The script lives in a template literal, so nothing else in the
 * toolchain can reach it: no import, no bundler, no type check. The rate
 * helpers below are too easy to get subtly wrong to leave at "it parses".
 *
 * A name is looked up as a function first and as a top-level `var` second, so
 * a helper that closes over a constant (waitingNote over WAITING_ROLES) can be
 * lifted by naming both rather than by hand-copying the constant into the test,
 * which would defeat the point of extracting it from the page at all.
 */
function pageDeclaration(name: string): string {
  const functionStart = ADMIN_PAGE_HTML.indexOf(`function ${name}(`);
  if (functionStart !== -1) {
    let depth = 0;
    for (let index = ADMIN_PAGE_HTML.indexOf('{', functionStart); index < ADMIN_PAGE_HTML.length; index += 1) {
      if (ADMIN_PAGE_HTML[index] === '{') depth += 1;
      else if (ADMIN_PAGE_HTML[index] === '}') {
        depth -= 1;
        if (depth === 0) return ADMIN_PAGE_HTML.slice(functionStart, index + 1);
      }
    }
    throw new Error(`unbalanced braces in ${name}`);
  }
  const variableStart = ADMIN_PAGE_HTML.indexOf(`var ${name} = `);
  if (variableStart === -1) throw new Error(`the page no longer defines ${name}`);
  const end = ADMIN_PAGE_HTML.indexOf(';', variableStart);
  if (end === -1) throw new Error(`unterminated declaration of ${name}`);
  return ADMIN_PAGE_HTML.slice(variableStart, end + 1);
}

function pageFunction(names: readonly string[], returned: string): (intervalMs: number) => unknown {
  const bodies = names.map(pageDeclaration);
  return new Function(
    'intervalMs',
    `var state = { meta: { intervalMs: intervalMs } };\n${bodies.join('\n')}\nreturn ${returned};`,
  ) as (intervalMs: number) => unknown;
}

/**
 * Runs the page's own renderTable over the given rows and returns the markup
 * it wrote. "The script parses" proves nothing about whether a column renders;
 * this is the closest thing to a browser the unit tier has, and it needs only
 * the one DOM call renderTable makes.
 */
function renderTableOver(rows: readonly Record<string, unknown>[], rangeMs: number, timeZone: string | null): string {
  const bodies = [
    'LIVE_RANGE',
    'DAY_MS',
    'NAMED_REJECTS',
    'fmtCount',
    'fmtBytes',
    'fmtTime',
    'zoneLabel',
    'esc',
    'sumValues',
    'rejectBreakdown',
    'perSecond',
    'plotRows',
    'renderTable',
  ].map(pageDeclaration);
  const run = new Function(
    'rows',
    'rangeMs',
    'timeZone',
    `var host = { hidden: false, innerHTML: "" };
var document = { getElementById: function () { return host; } };
var state = { meta: { intervalMs: 60000 }, table: true, rows: rows, liveRows: [], rangeMs: rangeMs, timeZone: timeZone };
${bodies.join('\n')}
renderTable();
return host.innerHTML;`,
  ) as (rows: readonly Record<string, unknown>[], rangeMs: number, timeZone: string | null) => string;
  return run(rows, rangeMs, timeZone);
}

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

  it('hedges every role it shows, because the client declares it and nothing checks', async () => {
    // The role is self-declared and unauthenticated, so the page must report
    // what a peer claimed rather than assert what it is. Nothing else pins
    // this, and it is the kind of wording that erodes one edit at a time.
    relay = await startTestRelay({ adminEnabled: true });
    const html = await (await fetch(`${httpBase(relay)}/admin`)).text();

    expect(html).toContain('Waiting peers by reported role');
    expect(html).toContain('" waiting to pair"');
    expect(html).toContain('", reported "');
    expect(html).toContain('the relay never verifies');
    // The healthy-idle reading has to be stated, or a parked desktop reads as
    // a stalled pairing, which is the misreading this whole feature exists to
    // stop. Both the chart hint and the pairing chart carry it.
    expect(html).toContain('normal idle state');
    expect(html).toContain('healthy idle');
  });

  it('draws a gap for a partial window without blanking the live view or older rows', () => {
    // The recorder flushes a trailing partial-interval row at shutdown so a
    // deploy does not lose its last seconds, and delta/windowMs turns four
    // connections over 200 ms into 1,200/min. Suppressing that is easy; doing
    // it without also suppressing legitimate rows is what this pins.
    type Trustworthy = (row: Record<string, unknown>) => boolean;
    const trustworthyAtInterval = (intervalMs: number) =>
      pageFunction(['nominalWindowMs', 'rateIsTrustworthy'], 'rateIsTrustworthy')(intervalMs) as Trustworthy;

    const raw = (windowMs: number) => ({ windowMs, resolutionSeconds: 60, sourceRowCount: 1 });
    const trustworthy = trustworthyAtInterval(60_000);

    expect(trustworthy(raw(200))).toBe(false);
    expect(trustworthy(raw(60_000))).toBe(true);
    // Synthesized live rows carry a 2-second poll gap against a resolution of
    // 60. Judging them by that resolution would blank the entire Live view,
    // and the flag cannot be inferred: seedLiveFromHistory mixes real recorder
    // rows into the same array.
    expect(trustworthy({ ...raw(2_000), live: true })).toBe(true);
    expect(trustworthy({ ...raw(300), live: true })).toBe(true);
    // An hourly bucket holding one 60-second row is a correct rate for the
    // minute the relay was up, not a fragment.
    expect(trustworthy({ windowMs: 60_000, resolutionSeconds: 3600, sourceRowCount: 1 })).toBe(true);

    // METRICS_HISTORY_INTERVAL_MS is configurable, and rows already on disk
    // were written under whatever it used to be. Judging them by the CURRENT
    // interval would blank a week of charts the moment it is raised.
    expect(trustworthyAtInterval(300_000)(raw(60_000))).toBe(true);
    expect(trustworthyAtInterval(300_000)(raw(200))).toBe(false);
    expect(trustworthyAtInterval(15_000)(raw(60_000))).toBe(true);
    // No recorder at all reports intervalMs 0, which must not divide by zero
    // into suppressing everything.
    expect(trustworthyAtInterval(0)(raw(60_000))).toBe(true);
  });

  it('writes the waiting tile note from the data, not just from the right words being present', () => {
    // The tile note is the user-facing payload of the whole role split, and the
    // two tests above only prove the wording exists somewhere in the script.
    // This runs the function, so reverting it to the old undifferentiated
    // "N waiting to pair" fails here rather than passing on a substring.
    type WaitingNote = (live: Record<string, unknown>) => string;
    const waitingNote = pageFunction(
      ['fmtInt', 'WAITING_ROLES', 'waitingNote'],
      'waitingNote',
    )(60_000) as WaitingNote;

    const note = (desktop: number, mobile: number, unknown: number) =>
      waitingNote({ waitingSlots: desktop + mobile + unknown, waitingSlotsByRole: { desktop, mobile, unknown } });

    expect(note(0, 0, 0)).toBe('none waiting to pair');
    // A lone parked desktop is the resting state of every online desktop, so
    // this is the string an operator reads most often.
    expect(note(1, 0, 0)).toBe('1 waiting to pair, reported 1 desktop');
    // Zero-valued roles are omitted: spelling out every zero wraps the note a
    // line past every other tile at eight across.
    expect(note(2, 1, 0)).toBe('3 waiting to pair, reported 2 desktop, 1 mobile');
    expect(note(0, 1, 0)).toBe('1 waiting to pair, reported 1 mobile');
    expect(note(1, 1, 1)).toBe('3 waiting to pair, reported 1 desktop, 1 mobile, 1 unknown');
    // Role order follows WAITING_ROLES rather than insertion order, so the note
    // does not reshuffle between polls.
    expect(note(0, 0, 2)).toBe('2 waiting to pair, reported 2 unknown');
    // A payload from a relay that predates the split still reads correctly
    // rather than throwing or printing "undefined".
    expect(waitingNote({ waitingSlots: 2 })).toBe('2 waiting to pair');
  });

  it('formats times in the zone it is given, so the UTC toggle actually moves the clock', () => {
    // fmtTime takes the zone as a parameter precisely so this can run it. The
    // epoch sits half an hour past midnight UTC: in UTC that is the 18th, five
    // hours west it is still the 17th, and the day number is the one part of
    // a localized date that reads the same in every locale a CI runner might
    // have. Nothing here compares the local branch against UTC, because on a
    // runner whose zone is UTC they are legitimately identical.
    type FormatTime = (ms: number, rangeMs: number, timeZone: string | null) => string;
    const fmtTime = pageFunction(['LIVE_RANGE', 'DAY_MS', 'fmtTime'], 'fmtTime')(60_000) as FormatTime;
    const justPastMidnightUtc = Date.UTC(2026, 8, 18, 0, 30);
    const thirtyDays = 30 * 86_400_000;

    expect(fmtTime(justPastMidnightUtc, thirtyDays, 'UTC')).toContain('18');
    expect(fmtTime(justPastMidnightUtc, thirtyDays, 'Etc/GMT+5')).toContain('17');
    // The multi-day branch (48h) prints month, day and hour, and the day is
    // again what a five-hour shift carries across midnight.
    const twoDays = 2 * 86_400_000;
    expect(fmtTime(justPastMidnightUtc, twoDays, 'UTC')).toContain('18');
    expect(fmtTime(justPastMidnightUtc, twoDays, 'Etc/GMT+5')).toContain('17');
    // The live and sub-day branches take the zone too; the hour is what moves,
    // so the same instant must print differently five hours apart. Minutes
    // alone would not prove it: a whole-hour offset never changes them, so a
    // branch that dropped the zone would still pass on a runner in any
    // whole-hour zone, which is nearly all of them.
    expect(fmtTime(justPastMidnightUtc, 0, 'UTC')).toContain('30:00');
    expect(fmtTime(justPastMidnightUtc, 0, 'UTC')).not.toBe(fmtTime(justPastMidnightUtc, 0, 'Etc/GMT+5'));
    expect(fmtTime(justPastMidnightUtc, 3_600_000, 'UTC')).toContain('30');
    expect(fmtTime(justPastMidnightUtc, 3_600_000, 'UTC')).not.toBe(fmtTime(justPastMidnightUtc, 3_600_000, 'Etc/GMT+5'));
    // Null means the browser's own zone and must not throw.
    expect(typeof fmtTime(justPastMidnightUtc, thirtyDays, null)).toBe('string');

    // The header label: the toggled zone verbatim, otherwise whatever short
    // name Intl gives the runner's own zone. Which one is not asserted, since
    // CI and a developer machine legitimately differ; that it is a non-empty
    // string and never "undefined" is.
    const zoneLabel = pageFunction(['zoneLabel'], 'zoneLabel')(60_000) as (timeZone: string | null) => string;
    expect(zoneLabel('UTC')).toBe('UTC');
    expect(zoneLabel(null)).toMatch(/^.+$/);
    expect(zoneLabel(null)).not.toBe('undefined');
  });

  it('folds every reject reason it does not name into other, including ones it has never seen', () => {
    // The history file accepts any key it finds on disk, so a reason added to
    // the relay after this page was written must still be counted somewhere
    // visible rather than silently dropped from the row.
    type Breakdown = (rejects: Record<string, number> | undefined) => {
      named: number[];
      other: number;
      otherParts: string[];
    };
    const rejectBreakdown = pageFunction(['NAMED_REJECTS', 'rejectBreakdown'], 'rejectBreakdown')(60_000) as Breakdown;

    const split = rejectBreakdown({
      park_timeout: 4,
      probe_evicted: 1,
      // Deliberately out of order: the tooltip sorts, and a fixture that
      // arrived already sorted would not notice if it stopped.
      some_future_reason: 2,
      rate_limit_ip: 3,
      admission: 0,
    });
    // Named columns land in NAMED_REJECTS order; an absent key reads zero.
    expect(split.named).toEqual([4, 0, 1]);
    expect(split.other).toBe(5);
    // Sorted, humanized, and without the zero-valued key: that is what the
    // tooltip shows, and a "0" entry would only pad it.
    expect(split.otherParts).toEqual(['rate limit ip 3', 'some future reason 2']);

    expect(rejectBreakdown({})).toEqual({ named: [0, 0, 0], other: 0, otherParts: [] });
    expect(rejectBreakdown(undefined)).toEqual({ named: [0, 0, 0], other: 0, otherParts: [] });

    // NAMED_REJECTS is a hand-typed copy inside the page script, where a typo
    // would crash nothing: the column would read zero forever while the real
    // count folded into Other. Typing the expected list as RejectReason makes
    // tsc catch the typo, and the equality catches the two lists drifting.
    const namedRejects: readonly RejectReason[] = ['park_timeout', 'slot_busy', 'probe_evicted'];
    expect(pageFunction(['NAMED_REJECTS'], 'NAMED_REJECTS')(60_000)).toEqual(namedRejects);
  });

  it('gives the table the columns an incident read needs and names the zone in its header', async () => {
    // Reading the 2026-09-18 incident took a fetch of /admin/data and a
    // script, because the fields that carried the story were JSON-only.
    relay = await startTestRelay({ adminEnabled: true });
    const html = await (await fetch(`${httpBase(relay)}/admin`)).text();

    for (const header of ['Peer closed', 'Pong timeouts', 'Park timeout', 'Slot busy', 'Probe evicted', '>Other<']) {
      expect(html).toContain(header);
    }
    // The Time header carries the zone, and the toggle is the one control that
    // changes it. Default is the browser's own zone: not pressed.
    expect(html).toContain('zoneLabel(state.timeZone)');
    expect(html).toContain('id="zoneToggle" aria-pressed="false"');
    // The charts follow the same toggle: axis labels and the hover caption go
    // through the same zone-aware call as the table cells. Nothing in this
    // tier can draw a chart, so the call sites are pinned by text.
    expect(html).toContain('fmtTime(pts[at].t, state.rangeMs, state.timeZone)');
    expect(html).toContain('fmtTime(pts[idx].t, state.rangeMs, state.timeZone)');
    // The hint states what the layout cannot: the two teardown columns are
    // inside Teardowns, a probe eviction is counted in both namespaces, and
    // the reject-derived teardown causes make Teardowns and Rejects overlap.
    expect(html).toContain('two of the causes inside Teardowns');
    expect(html).toContain('counted as both a pong timeout and a probe_evicted reject');
    expect(html).toContain('Teardowns and Rejects overlap on those as well');
  });

  it('lists the same roles the relay reports, so a fourth cannot vanish from the tile', async () => {
    // The page is a template literal and cannot import, so its role list is a
    // second hand-maintained copy of PEER_ROLES. Without this, adding a role
    // would surface it on /metrics and in the chart while the tile silently
    // ignored it, which is the same class of drift the field-parity test below
    // exists to catch.
    relay = await startTestRelay({ adminEnabled: true });
    const html = await (await fetch(`${httpBase(relay)}/admin`)).text();

    const declaration = html.match(/var WAITING_ROLES = (\[[^\]]*\]);/);
    expect(declaration).not.toBeNull();
    expect(JSON.parse((declaration?.[1] ?? '[]').replace(/'/g, '"'))).toEqual([...PEER_ROLES]);
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

  it('reports the Access identity for display, and nothing at all without it', async () => {
    relay = await startTestRelay({ adminEnabled: true });

    const signedIn = (await (
      await fetch(`${httpBase(relay)}/admin/data`, {
        headers: { 'cf-access-authenticated-user-email': 'someone@example.com' },
      })
    ).json()) as { meta: { viewer: string | null } };
    expect(signedIn.meta.viewer).toBe('someone@example.com');

    // An SSH tunnel or a local run has no edge in front of it. That must read
    // as "no identity" rather than an empty string the page would render as a
    // blank pill.
    const direct = (await (await fetch(`${httpBase(relay)}/admin/data`)).json()) as {
      meta: { viewer: string | null };
    };
    expect(direct.meta.viewer).toBeNull();
  });

  it('bounds the Access identity, since anything reaching the origin controls it', async () => {
    relay = await startTestRelay({ adminEnabled: true });

    const overlong = (await (
      await fetch(`${httpBase(relay)}/admin/data`, {
        headers: { 'cf-access-authenticated-user-email': 'a'.repeat(400) },
      })
    ).json()) as { meta: { viewer: string | null } };
    expect(overlong.meta.viewer).toBeNull();

    const blank = (await (
      await fetch(`${httpBase(relay)}/admin/data`, {
        headers: { 'cf-access-authenticated-user-email': '   ' },
      })
    ).json()) as { meta: { viewer: string | null } };
    expect(blank.meta.viewer).toBeNull();
  });

  it('renders the identity as text, never as markup', async () => {
    relay = await startTestRelay({ adminEnabled: true });
    const html = await (await fetch(`${httpBase(relay)}/admin`)).text();

    // The value originates in a forgeable request header, so the page must set
    // it with textContent. innerHTML here would turn a header into script
    // injection on the one surface an operator trusts.
    expect(html).toContain('document.getElementById("viewerEmail")');
    expect(html).toMatch(/viewerEmail[^]{0,120}textContent/);
    expect(html).not.toMatch(/viewerEmail[^]{0,120}innerHTML/);
    // Sign-out is Cloudflare's own endpoint: the relay grows no session to end.
    expect(html).toContain('/cdn-cgi/access/logout');
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
      'waitingSlotsByRole',
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
      // The table's Peer closed and Pong timeouts columns read these directly,
      // not through closedByCause.
      'peerClosedDelta',
      'pongTimeoutsDelta',
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
    expect(row['waitingDesktop']).toHaveProperty('maximum');
    expect(row['waitingMobile']).toHaveProperty('maximum');
    expect(row['waitingUnknown']).toHaveProperty('maximum');
    // A bounded three-value dimension, so the live split is the same shape on
    // every response rather than only the roles that happened to connect.
    expect(payload.live).toHaveProperty('waitingSlotsByRole.desktop');
    expect(payload.live).toHaveProperty('waitingSlotsByRole.mobile');
    expect(payload.live).toHaveProperty('waitingSlotsByRole.unknown');
  });

  it('renders the table over rows the relay actually served, with the new columns filled in', async () => {
    // The field-parity test above proves the names exist on the wire; this
    // proves the page turns them into cells. The row is one the endpoint
    // really produced, with only the counters under test overridden, so the
    // shape cannot drift from what the browser will be handed.
    directory = await mkdtemp(join(tmpdir(), 'relay-admin-'));
    relay = await startTestRelay({
      adminEnabled: true,
      metricsHistoryPath: join(directory, 'history.ndjson'),
      metricsHistoryIntervalMs: 1_000,
    });
    const base = httpBase(relay);

    let payload = { rows: [] as Record<string, unknown>[] };
    const deadline = Date.now() + 6_000;
    while (payload.rows.length === 0 && Date.now() < deadline) {
      payload = (await (await fetch(`${base}/admin/data?range=3600000`)).json()) as typeof payload;
    }
    const served = payload.rows[0];
    if (served === undefined) throw new Error('expected a row');

    const row = {
      ...served,
      peerClosedDelta: 3,
      pongTimeoutsDelta: 2,
      rejectsByReasonDelta: { park_timeout: 4, probe_evicted: 1, rate_limit_ip: 5, some_future_reason: 1 },
      closedByCause: { ...(served['closedByCause'] as Record<string, number>), peerClosed: 3, heartbeat: 2, parkTimeout: 4 },
    };

    const html = renderTableOver([row], 3_600_000, 'UTC');
    const headers = [...html.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((match) => match[1]);
    expect(headers).toEqual([
      'Time (UTC)', 'Res', 'Active peak', 'Active avg', 'Paired peak', 'Waiting', 'Frames/s', 'Bytes/s', 'Conns', 'Sessions',
      'Teardowns', 'Peer closed', 'Pong timeouts', 'Rejects', 'Park timeout', 'Slot busy', 'Probe evicted', 'Other',
      'CPU %', 'Loop p99', 'RSS %',
    ]);

    const cells = [...html.matchAll(/<td([^>]*)>([^<]*)<\/td>/g)].map((match) => ({ attributes: match[1] ?? '', text: match[2] ?? '' }));
    expect(cells).toHaveLength(headers.length);
    const byHeader = (name: string) => cells[headers.indexOf(name)];
    expect(byHeader('Teardowns')?.text).toBe('9');
    expect(byHeader('Peer closed')?.text).toBe('3');
    expect(byHeader('Pong timeouts')?.text).toBe('2');
    expect(byHeader('Rejects')?.text).toBe('11');
    expect(byHeader('Park timeout')?.text).toBe('4');
    // Absent on the row, so it renders as a muted zero rather than "n/a".
    expect(byHeader('Slot busy')?.text).toBe('0');
    expect(byHeader('Slot busy')?.attributes).toContain('class="zero"');
    expect(byHeader('Probe evicted')?.text).toBe('1');
    // The fold, with its split in the tooltip and the unknown reason kept.
    expect(byHeader('Other')?.text).toBe('6');
    expect(byHeader('Other')?.attributes).toContain('title="rate limit ip 5, some future reason 1"');

    // With nothing to fold, Other is a muted zero with no tooltip at all; an
    // empty title would show as a blank hover box.
    const namedOnlyHtml = renderTableOver([{ ...row, rejectsByReasonDelta: { park_timeout: 4 } }], 3_600_000, 'UTC');
    const namedOnlyCells = [...namedOnlyHtml.matchAll(/<td([^>]*)>([^<]*)<\/td>/g)].map((match) => ({ attributes: match[1] ?? '', text: match[2] ?? '' }));
    const namedOnlyOther = namedOnlyCells[headers.indexOf('Other')];
    expect(namedOnlyOther?.text).toBe('0');
    expect(namedOnlyOther?.attributes).toBe(' class="zero"');

    // The zone reaches the cell, not just the header: five hours apart, the
    // same instant prints a different hour.
    const westernHtml = renderTableOver([row], 3_600_000, 'Etc/GMT+5');
    const timeCell = (markup: string) => markup.match(/<td>([^<]*)<\/td>/)?.[1];
    expect(timeCell(westernHtml)).not.toBe(timeCell(html));
    expect(westernHtml).toContain('<th>Time (Etc/GMT+5)</th>');
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
