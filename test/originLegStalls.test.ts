/**
 * Coverage for scripts/originLegStalls.mjs, the origin-leg stall measure over CONNECTION_TRACE lines
 * that docs/latency.md's 2026-11-12 results and the tunnel A/B rest on.
 *
 * The cases pin what a reader of its output relies on:
 *
 * 1. A calm trace, every colo at its own ordinary transit, reports no stall: different colos'
 *    different distances to the origin are not excess.
 * 2. A dial the edge stamped 3 s before the relay saw it reads as about 3 s of excess, lands on the
 *    right day, counts as paired when it paired, and heads the largest list.
 * 3. `--exclude` drops a probe's own window, and compose's log prefix and non-trace lines are
 *    tolerated, since the export is a grep over mixed log output.
 *
 * Driven through its CLI, like test/reviewVerdict.test.ts and for the same reason: `scripts/` is
 * outside the tsconfig `include`.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT_PATH = path.join(import.meta.dirname, '..', 'scripts', 'originLegStalls.mjs');
// Any epoch works as long as the ray prefix fits 10 hex digits; this one matches real 2026 rays.
const RAY_EPOCH_SECONDS = 1_350_000_000;
const RAY_UNITS_PER_SECOND = 1600;
const START_MS = Date.parse('2026-11-09T10:00:00Z');
const TRANSIT_SECONDS_BY_COLO: Readonly<Record<string, number>> = { EWR: 0.02, LHR: 0.08, SIN: 0.25, ATL: 0.03 };
const COLOS = Object.keys(TRANSIT_SECONDS_BY_COLO);
const PLANTED_STALL_SECONDS = 3;

const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

interface DialSpec {
  readonly relayMs: number;
  readonly colo: string;
  readonly edgeToRelaySeconds: number;
  readonly sequence: number;
  readonly pairedAfterMs: number | null;
}

/** One trace line as the relay logs it, with a CF-Ray whose prefix dates the edge's stamp. */
function traceLine(dial: DialSpec): string {
  const rayUnits = Math.floor((dial.relayMs / 1000 - dial.edgeToRelaySeconds - RAY_EPOCH_SECONDS) * RAY_UNITS_PER_SECOND);
  const cfRay = `${rayUnits.toString(16).padStart(10, '0')}${dial.sequence.toString(16).padStart(6, '0')}-${dial.colo}`;
  return JSON.stringify({
    time: new Date(dial.relayMs + 60_000).toISOString(),
    level: 'info',
    message: 'connection trace',
    role: 'desktop',
    cfRay,
    upgradeReceivedAt: new Date(dial.relayMs).toISOString(),
    socketAgeAtUpgradeMs: 0.2,
    pairedAfterMs: dial.pairedAfterMs,
    closeCode: 4408,
  });
}

/** 400 calm dials over 100 minutes across four colos, each at its colo's transit plus jitter. */
function calmDials(): DialSpec[] {
  return Array.from({ length: 400 }, (_, index) => {
    const colo = COLOS[index % COLOS.length] ?? 'EWR';
    return {
      relayMs: START_MS + index * 15_000,
      colo,
      edgeToRelaySeconds: (TRANSIT_SECONDS_BY_COLO[colo] ?? 0) + ((index * 7) % 10) / 1000,
      sequence: index,
      pairedAfterMs: null,
    };
  });
}

/** Three EWR dials at 10:30-10:32 that waited PLANTED_STALL_SECONDS past the edge, all paired. */
function plantedStalls(): DialSpec[] {
  return [0, 1, 2].map((offsetMinutes) => ({
    relayMs: Date.parse('2026-11-09T10:30:07Z') + offsetMinutes * 60_000,
    colo: 'EWR',
    edgeToRelaySeconds: (TRANSIT_SECONDS_BY_COLO['EWR'] ?? 0) + PLANTED_STALL_SECONDS,
    sequence: 1000 + offsetMinutes,
    pairedAfterMs: 5,
  }));
}

function runScript(lines: readonly string[], extraArguments: readonly string[] = []): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'relay-origin-leg-'));
  temporaryDirectories.push(directory);
  const tracesPath = path.join(directory, 'traces.ndjson');
  writeFileSync(tracesPath, lines.join('\n') + '\n', 'utf8');
  return execFileSync(process.execPath, [SCRIPT_PATH, tracesPath, ...extraArguments], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('scripts/originLegStalls.mjs', () => {
  it('reports no stall when every colo sits at its own ordinary transit', () => {
    const output = runScript(calmDials().map(traceLine));
    expect(output).toContain('dials 400,');
    expect(output).toContain('over 1 s: 0/400 (0.00%)');
    expect(output).toContain('over 0.5 s: 0/400 (0.00%)');
  });

  it('measures a dial held past the edge as excess, by day, by pairing and largest first', () => {
    const output = runScript([...calmDials(), ...plantedStalls()].map(traceLine));
    expect(output).toContain('over 1 s: 3/403 (0.74%)');
    expect(output).toContain('over 2 s: 3/403 (0.74%)');
    expect(output).toContain('over 5 s: 0/403 (0.00%)');
    expect(output).toContain('dials that went on to pair, over 1 s: 3/3 (100.00%)');
    expect(output).toContain('2026-11-09: 3/403 (0.74%)');
    expect(output).toContain('episodes 1; with 10+ stalls 0');

    const largest = output.slice(output.indexOf('largest'));
    const excessValues = [...largest.matchAll(/excess (\d+\.\d+) s/g)].map((match) => Number(match[1]));
    expect(excessValues).toHaveLength(3);
    for (const excess of excessValues) {
      expect(excess).toBeGreaterThan(PLANTED_STALL_SECONDS - 0.06);
      expect(excess).toBeLessThan(PLANTED_STALL_SECONDS + 0.06);
    }
  });

  it('drops an excluded window and tolerates a compose prefix and non-trace lines', () => {
    const [firstPlanted, ...otherPlanted] = plantedStalls();
    if (firstPlanted === undefined) throw new Error('no planted stall');
    const lines = [
      ...calmDials().map(traceLine),
      `relay-1  | ${traceLine(firstPlanted)}`,
      ...otherPlanted.map(traceLine),
      'not json at all',
      JSON.stringify({ level: 'info', message: 'relay listening', port: 8080 }),
    ];
    expect(runScript(lines)).toContain('over 1 s: 3/403 (0.74%)');

    const excluded = runScript(lines, ['--exclude', '2026-11-09T10:29:00Z/2026-11-09T10:33:00Z']);
    expect(excluded).toMatch(/over 1 s: 0\/\d+ \(0\.00%\)/);
    expect(excluded).not.toContain('dials 403,');
  });

  it('prints its usage and exits 2 without a traces file', () => {
    let exitCode = 0;
    let stderr = '';
    try {
      execFileSync(process.execPath, [SCRIPT_PATH], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      const failure = error as { status?: number; stderr?: string };
      exitCode = failure.status ?? 1;
      stderr = failure.stderr ?? '';
    }
    expect(exitCode).toBe(2);
    expect(stderr).toContain('usage: node scripts/originLegStalls.mjs');
  });
});
