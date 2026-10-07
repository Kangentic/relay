/**
 * Coverage for scripts/review-verdict.mjs, the deterministic /code-review verdict.
 *
 * The verdict used to live in prose ("Needs revision" whenever anything was skipped), which gave
 * the same state different labels from pass to pass. These cases pin the contract the skill and
 * the board both act on:
 *
 * 1. The verdict depends on statuses and checks only, never on how many findings there are.
 * 2. A non-quick blocked finding, or a failed check, is Blocked on its own and names a step.
 * 3. A quick fix never changes the verdict, even when it could not be applied.
 * 4. Validation refuses `skipped`, a reasonless refutation, a stepless blocker, a decision on a
 *    quick finding, and follow-ups with no filed task.
 * 5. The closing block is the last thing printed, with no trailing `Next:` line.
 * 6. Ledger lines are keyed by file, symbol and mechanism, and carry no line number.
 *
 * The script is driven through its CLI rather than imported: that is exactly how the skill
 * invokes it, and `scripts/` is outside the tsconfig `include`, so an import would need a
 * hand-maintained declaration file that could drift from the script.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT_PATH = path.join(import.meta.dirname, '..', 'scripts', 'review-verdict.mjs');

const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Writes `report` to a temp findings file and runs the script over it. */
function runVerdict(report: unknown, extraArguments: readonly string[] = []): CommandResult {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'relay-review-verdict-'));
  temporaryDirectories.push(directory);
  const findingsPath = path.join(directory, 'findings.json');
  writeFileSync(findingsPath, JSON.stringify(report), 'utf8');

  try {
    const stdout = execFileSync(process.execPath, [SCRIPT_PATH, findingsPath, ...extraArguments], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      exitCode: failure.status ?? 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

const PASSING_CHECKS = { typecheck: 'pass', blindness: 'pass', scopedTests: 'pass' } as const;

function finding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    severity: 'high',
    category: 'Correctness',
    location: 'src/rendezvous.ts:42',
    file: 'src/rendezvous.ts',
    symbol: 'handleConnection',
    mechanism: 'await between reading and mutating slot state',
    status: 'fixed',
    ...overrides,
  };
}

describe('review-verdict: the verdict itself', () => {
  it('is Ready with no findings at all', () => {
    const result = runVerdict({ checks: PASSING_CHECKS, findings: [] });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Verdict: Ready');
  });

  it('is Ready however many findings were fixed or refuted', () => {
    const many = Array.from({ length: 12 }, (_unused, index) =>
      finding({
        id: index + 1,
        status: index % 2 === 0 ? 'fixed' : 'refuted',
        reason: index % 2 === 0 ? undefined : 'the code does not bear it out',
      }),
    );

    const result = runVerdict({ checks: PASSING_CHECKS, findings: many });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Verdict: Ready');
  });

  it('is Blocked on a single non-quick blocked finding, and numbers its step', () => {
    const result = runVerdict({
      checks: PASSING_CHECKS,
      findings: [
        finding({
          status: 'blocked',
          reason: 'the fix broke typecheck twice',
          step: 'redesign the teardown path so the cap release stays single-shot',
        }),
      ],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Verdict: Blocked');
    expect(result.stdout).toContain(
      '1. src/rendezvous.ts:42: redesign the teardown path so the cap release stays single-shot',
    );
  });

  it('stays Ready when the only blocked finding is a quick one', () => {
    const result = runVerdict({
      checks: PASSING_CHECKS,
      findings: [finding({ quick: true, status: 'blocked', reason: 'the stale comment moved' })],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Verdict: Ready');
  });

  it('is Blocked on a failed check alone, naming the command to run', () => {
    const result = runVerdict({
      checks: { ...PASSING_CHECKS, blindness: 'fail' },
      findings: [],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Verdict: Blocked');
    expect(result.stdout).toContain('Blindness test:');
    expect(result.stdout).toContain('npx vitest run test/blindness.test.ts');
  });

  it('accepts scopedTests: none, which is not a failure', () => {
    const result = runVerdict({
      checks: { ...PASSING_CHECKS, scopedTests: 'none' },
      findings: [],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Verdict: Ready');
  });

  it('ends on the closing block, with no Next line after it', () => {
    const result = runVerdict({
      checks: PASSING_CHECKS,
      findings: [
        finding({
          status: 'blocked',
          reason: 'needs a deploy to measure',
          step: 'run the compaction over a real 7-day store',
        }),
      ],
    });

    const lines = result.stdout.trimEnd().split('\n');
    expect(lines.at(-2)).toBe('Verdict: Blocked');
    expect(lines.at(-1)).toBe('1. src/rendezvous.ts:42: run the compaction over a real 7-day store');
    expect(result.stdout).not.toContain('Next:');
  });
});

describe('review-verdict: validation', () => {
  it('refuses the retired `skipped` status and exits 2', () => {
    const result = runVerdict({
      checks: PASSING_CHECKS,
      findings: [finding({ status: 'skipped' })],
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('status must be one of fixed, refuted, blocked');
  });

  it('refuses a refuted finding with no reason', () => {
    const result = runVerdict({ checks: PASSING_CHECKS, findings: [finding({ status: 'refuted' })] });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('reason is required for a refuted finding');
  });

  it('refuses a blocked finding with no step', () => {
    const result = runVerdict({
      checks: PASSING_CHECKS,
      findings: [finding({ status: 'blocked', reason: 'cannot run it here' })],
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('step is required for a blocked finding');
  });

  it('refuses a decision on a quick finding, since a choice is not mechanical', () => {
    const result = runVerdict({
      checks: PASSING_CHECKS,
      findings: [
        finding({ quick: true, decision: { chosen: 'the first form', alternative: 'the second form' } }),
      ],
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('decision is not valid on a quick finding');
  });

  it('refuses a decision that names no alternative', () => {
    const result = runVerdict({
      checks: PASSING_CHECKS,
      findings: [finding({ decision: { chosen: 'the first form' } })],
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('decision needs both chosen and alternative');
  });

  it('refuses follow-ups with no filed task id', () => {
    const result = runVerdict({
      checks: PASSING_CHECKS,
      findings: [],
      followUps: [{ title: 'Rework the cap accounting', location: 'src/guards/caps.ts', why: 'needs its own design' }],
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('followUpTask is required with followUps');
  });

  it('refuses a missing check key', () => {
    const result = runVerdict({ checks: { typecheck: 'pass', scopedTests: 'pass' }, findings: [] });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('checks.blindness must be one of pass, fail');
  });
});

describe('review-verdict: the ledger', () => {
  it('keys each line by file, symbol and mechanism, with no line number', () => {
    const result = runVerdict(
      {
        checks: PASSING_CHECKS,
        findings: [
          finding({ status: 'refuted', reason: 'the synchronous path has no await' }),
          finding({
            id: 2,
            file: 'src/connection.ts',
            symbol: 'forward',
            mechanism: 'per-frame allocation in the hot path',
            location: 'src/connection.ts:88',
            decision: { chosen: 'a preallocated buffer', alternative: 'a per-frame slice' },
          }),
        ],
      },
      ['--ledger'],
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      'Refuted: src/rendezvous.ts handleConnection: await between reading and mutating slot state - the synchronous path has no await',
    );
    expect(result.stdout).toContain(
      'Decisions: src/connection.ts forward: per-frame allocation in the hot path - chose a preallocated buffer over a per-frame slice',
    );
    // Line numbers drift between passes, so a ledger key must never carry one.
    expect(result.stdout).not.toContain(':42');
    expect(result.stdout).not.toContain(':88');
  });

  it('collapses a multi-line reason onto one line', () => {
    const result = runVerdict(
      {
        checks: PASSING_CHECKS,
        findings: [finding({ status: 'refuted', reason: 'first part\nsecond part\n  third part' })],
      },
      ['--ledger'],
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trimEnd().split('\n')).toHaveLength(1);
    expect(result.stdout).toContain('first part second part third part');
  });

  it('prints nothing when there is nothing to record', () => {
    const result = runVerdict({ checks: PASSING_CHECKS, findings: [finding()] }, ['--ledger']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });
});

describe('review-verdict: the summary counts', () => {
  it('leaves quick findings out of the status counts but names them on their own line', () => {
    const result = runVerdict({
      checks: PASSING_CHECKS,
      findings: [
        finding(),
        finding({ id: 2, quick: true }),
        finding({ id: 3, quick: true }),
        finding({ id: 4, status: 'refuted', reason: 'not borne out' }),
      ],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Fixed: 1 (0 by decision). Refuted: 1. Blocked: 0.');
    expect(result.stdout).toContain('Quick fixes: 2');
  });

  it('lists the severities in critical, high, medium, low order', () => {
    const result = runVerdict({
      checks: PASSING_CHECKS,
      findings: [finding({ severity: 'low' }), finding({ id: 2, severity: 'critical' })],
    });

    expect(result.stdout).toContain('Findings: 1 critical, 0 high, 0 medium, 1 low');
  });

  it('counts a re-raise and lists each decision with its alternative', () => {
    const result = runVerdict({
      checks: PASSING_CHECKS,
      findings: [
        finding({
          decision: { chosen: 'a preallocated buffer', alternative: 'a per-frame slice' },
          reRaise: { of: 'Refuted: src/connection.ts forward: per-frame allocation', newEvidence: 'a load test now fails' },
        }),
      ],
    });

    expect(result.stdout).toContain('Re-raised with new evidence: 1');
    expect(result.stdout).toContain('### Decisions made (1)');
    expect(result.stdout).toContain('chose a preallocated buffer. The alternative was a per-frame slice.');
  });
});

describe('review-verdict: the CLI contract', () => {
  it('exits 2 with a usage error when given no findings path', () => {
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
    expect(stderr).toContain('usage: node scripts/review-verdict.mjs');
  });

  it('exits 2 when the findings file is not valid JSON', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'relay-review-verdict-'));
    temporaryDirectories.push(directory);
    const findingsPath = path.join(directory, 'findings.json');
    writeFileSync(findingsPath, '{ not json', 'utf8');

    let exitCode = 0;
    let stderr = '';
    try {
      execFileSync(process.execPath, [SCRIPT_PATH, findingsPath], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      const failure = error as { status?: number; stderr?: string };
      exitCode = failure.status ?? 1;
      stderr = failure.stderr ?? '';
    }

    expect(exitCode).toBe(2);
    expect(stderr).toContain('could not read');
  });
});
