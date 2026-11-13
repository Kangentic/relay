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
 * 4. A malformed flag value or an unknown flag stops with the usage line and exit 2, instead of
 *    printing a report that looks right and is not.
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

function writeTraces(lines: readonly string[]): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'relay-origin-leg-'));
  temporaryDirectories.push(directory);
  const tracesPath = path.join(directory, 'traces.ndjson');
  writeFileSync(tracesPath, lines.join('\n') + '\n', 'utf8');
  return tracesPath;
}

function runScript(lines: readonly string[], extraArguments: readonly string[] = []): string {
  return execFileSync(process.execPath, [SCRIPT_PATH, writeTraces(lines), ...extraArguments], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

interface FailedRun {
  readonly exitCode: number;
  readonly stderr: string;
}

/** Runs the CLI where it is expected to refuse; a run that exits 0 reports exit code 0. */
function runScriptExpectingFailure(cliArguments: readonly string[]): FailedRun {
  try {
    execFileSync(process.execPath, [SCRIPT_PATH, ...cliArguments], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const failure = error as { status?: number; stderr?: string };
    return { exitCode: failure.status ?? 1, stderr: failure.stderr ?? '' };
  }
  return { exitCode: 0, stderr: '' };
}

describe('scripts/originLegStalls.mjs', () => {
  it('reports no stall when every colo sits at its own ordinary transit', () => {
    const output = runScript(calmDials().map(traceLine));
    expect(output).toContain('dials 400,');
    expect(output).toContain('over 1 s: 0/400 (0.00%)');
    expect(output).toContain('over 0.5 s: 0/400 (0.00%)');
    expect(output).toContain('stalls by colo (stalls/dials): none');
  });

  it('measures a dial held past the edge as excess, by day, by pairing and largest first', () => {
    const output = runScript([...calmDials(), ...plantedStalls()].map(traceLine));
    expect(output).toContain('over 1 s: 3/403 (0.74%)');
    expect(output).toContain('over 2 s: 3/403 (0.74%)');
    expect(output).toContain('over 5 s: 0/403 (0.00%)');
    expect(output).toContain('dials that went on to pair, over 1 s: 3/3 (100.00%)');
    expect(output).toContain('2026-11-09: 3/403 (0.74%)');
    // 100 calm EWR dials (every fourth) plus the 3 planted ones.
    expect(output).toContain('stalls by colo (stalls/dials): EWR 3/103');
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
    const { exitCode, stderr } = runScriptExpectingFailure([]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('usage: node scripts/originLegStalls.mjs');
  });

  // Each of these used to run and print a plausible report: a NaN threshold reads 0 stalls, a NaN
  // gap makes every stall its own episode, a window without a slash excludes nothing, and a
  // misspelled flag was taken as the traces file.
  it('refuses a malformed flag value or an unknown flag instead of reporting on it', () => {
    const tracesPath = writeTraces(calmDials().map(traceLine));
    const refusals: ReadonlyArray<{ readonly cliArguments: readonly string[]; readonly named: string }> = [
      { cliArguments: [tracesPath, '--threshold-seconds', 'abc'], named: '--threshold-seconds' },
      { cliArguments: [tracesPath, '--episode-gap-seconds'], named: '--episode-gap-seconds' },
      { cliArguments: [tracesPath, '--top', '-3'], named: '--top' },
      { cliArguments: [tracesPath, '--exclude', '2026-11-09T10:29:00Z'], named: '--exclude' },
      { cliArguments: [tracesPath, '--treshold-seconds', '2'], named: '--treshold-seconds' },
    ];
    for (const refusal of refusals) {
      const { exitCode, stderr } = runScriptExpectingFailure(refusal.cliArguments);
      expect(exitCode, refusal.cliArguments.join(' ')).toBe(2);
      expect(stderr).toContain(refusal.named);
      expect(stderr).toContain('usage: node scripts/originLegStalls.mjs');
    }
  });
});
