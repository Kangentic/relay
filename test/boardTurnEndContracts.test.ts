/**
 * Pins the final-line contracts between this repo's own board (`kangentic.json`) and the script
 * and skills that print the lines its "On agent turn end" rows read.
 *
 * A Text match row moves a card only when the whole last line of the agent's final message
 * matches it. When a row and its producer drift apart (a reworded skill, a renamed row, the
 * verdict printed above its steps again) nothing errors anywhere: the card just waits in its
 * column forever, which is the failure this file exists to catch. Each row is therefore held to
 * the thing that prints its line:
 *
 * 1. Code Review: `scripts/review-verdict.mjs`'s closing block ENDS on exactly the
 *    "Back for revisions" and "On to Testing" lines. Exact equality is stricter than the board's
 *    own matcher on purpose: the script is deterministic, so a lenient matcher is never what
 *    makes this pass. The Blocked case also pins the verdict BELOW its numbered steps, which is
 *    the ordering bug this chain was built on top of.
 * 2. Testing: `/pull-request` prints the "On to Merge" line in its success step and names the row
 *    that reads it, and its escalation line does not match that row.
 * 3. Executing: the "Apply findings" message asks for exactly the "On to Code Review" line.
 * 4. Merge: `/merge-pull-request` prints the "On to Release" line in its report step and the
 *    "Back to Testing" line in its re-verify step. Back to Testing returns a red-CI stop a limited
 *    number of times, and Testing's "On to Merge" allows one more run than that, so every round
 *    trip the board allows can come back to Merge.
 * 5. Release: `/release` prints the "Finish" line in its report step. This is the one line printed
 *    after real users are already served, so the skill gates it on the deploy having actually
 *    landed.
 * 6. Row shape: every Text match row on the board is one this file pins, a Text match sits only on
 *    a turn-end row, no row's line matches another row in the same column, and every
 *    `move_to_column` target is a column that exists.
 *
 * A skill pin reads only the step that PRINTS the line, because each skill also quotes it in its
 * "Outcome line" section, where a quote alone would pass with the printing step gone.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const REPOSITORY_ROOT = path.join(import.meta.dirname, '..');
const SCRIPT_PATH = path.join(REPOSITORY_ROOT, 'scripts', 'review-verdict.mjs');

const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

interface AutomationRow {
  readonly name: string;
  readonly type: string;
  readonly on?: string;
  readonly condition?: { text?: string | readonly string[]; agent?: string };
  readonly filter?: { labels?: readonly string[]; priorities?: readonly string[] };
  readonly targetColumn?: string;
  readonly message?: string;
  readonly maxRuns?: number;
}

interface BoardColumn {
  readonly name: string;
  readonly automations?: Record<string, readonly AutomationRow[]>;
}

function readRepositoryFile(relativePath: string): string {
  return readFileSync(path.join(REPOSITORY_ROOT, relativePath), 'utf8');
}

const board = JSON.parse(readRepositoryFile('kangentic.json')) as { readonly columns: readonly BoardColumn[] };

function turnEndRow(columnName: string, rowName: string): AutomationRow {
  const column = board.columns.find((candidate) => candidate.name === columnName);
  if (!column) throw new Error(`kangentic.json has no "${columnName}" column`);
  const row = column.automations?.onTurnEnd?.find((candidate) => candidate.name === rowName);
  if (!row) throw new Error(`kangentic.json's ${columnName} column has no "${rowName}" turn-end row`);
  return row;
}

/** A row's Text match, or undefined when it has none. */
function textMatchOf(row: AutomationRow): string | undefined {
  const text = row.condition?.text;
  if (text === undefined) return undefined;
  return Array.isArray(text) ? text.join('\n') : (text as string);
}

/** The one line a contract row's agent has to end on. */
function finalLineOf(columnName: string, rowName: string): string {
  const finalLine = textMatchOf(turnEndRow(columnName, rowName));
  if (finalLine === undefined) throw new Error(`the ${columnName} "${rowName}" row has no Text match`);
  if (finalLine.includes('\n')) {
    throw new Error(`the ${columnName} "${rowName}" row has several patterns; a contract pins one line`);
  }
  return finalLine;
}

/** A boolean with a message, so a failure names the missing text instead of printing a whole skill. */
function expectTextIn(source: string, sourceName: string, expectedText: string): void {
  expect(source.includes(expectedText), `${sourceName} does not contain ${expectedText}`).toBe(true);
}

/**
 * The text from a `## ` heading up to the next one. The search for the end keeps the trailing
 * space, so a `### ` subheading inside the step does not end it.
 */
function sectionOf(source: string, sourceName: string, heading: string): string {
  const start = source.indexOf(`\n${heading}`);
  if (start === -1) throw new Error(`${sourceName} has no "${heading}" heading`);
  const end = source.indexOf('\n## ', start + 1);
  return source.slice(start, end === -1 ? undefined : end);
}

/** Runs the verdict script over `report` the way the skill does, and returns its stdout. */
function runVerdict(report: unknown): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'relay-board-contracts-'));
  temporaryDirectories.push(directory);
  const findingsPath = path.join(directory, 'findings.json');
  writeFileSync(findingsPath, JSON.stringify(report), 'utf8');
  return execFileSync(process.execPath, [SCRIPT_PATH, findingsPath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function lastLineOf(text: string): string {
  const lines = text.trimEnd().split('\n');
  return lines[lines.length - 1] ?? '';
}

/**
 * Every Text match row this file holds to a producer, as `<column>/<row>`. Each entry has its
 * producer test in a describe below, so add the two together.
 */
const PINNED_ROWS = new Set([
  'Executing/On to Code Review',
  'Code Review/Back for revisions',
  'Code Review/On to Testing',
  'Testing/On to Merge',
  'Merge/Hold for a batch release',
  'Merge/On to Release',
  'Merge/Back to Testing',
  'Release/Finish',
]);

const PASSING_CHECKS = { typecheck: 'pass', blindness: 'pass', scopedTests: 'pass' } as const;
const READY_REPORT = { checks: PASSING_CHECKS, findings: [] };
// A failed check is a blocker on its own, so no finding is needed to reach Blocked.
const BLOCKED_REPORT = { checks: { ...PASSING_CHECKS, typecheck: 'fail' }, findings: [] };

describe('board turn-end contracts: Code Review', () => {
  it('ends a Ready pass on exactly the On to Testing line', () => {
    expect(lastLineOf(runVerdict(READY_REPORT))).toBe(finalLineOf('Code Review', 'On to Testing'));
  });

  it('ends a Blocked pass on exactly the Back for revisions line, below its numbered steps', () => {
    const output = runVerdict(BLOCKED_REPORT).trimEnd().split('\n');
    expect(output[output.length - 1]).toBe(finalLineOf('Code Review', 'Back for revisions'));
    // The step the verdict is about has to be above it, or the reviewer is told nothing.
    expect(output[output.length - 2], 'a numbered step directly above the verdict').toMatch(/^\d+\. /);
  });

  it('sends the review reply back to Executing, since the numbered steps live in it', () => {
    const backForRevisions = turnEndRow('Code Review', 'Back for revisions');
    expect(backForRevisions.targetColumn).toBe('Executing');
    expect(backForRevisions.message).toContain('{{agentReply}}');
  });

  it('names the ordering in the skill, since the agent pastes the output by hand', () => {
    const skillPath = '.claude/skills/code-review/SKILL.md';
    expectTextIn(readRepositoryFile(skillPath), skillPath, 'The verdict is below its numbered steps');
  });

  /**
   * The parking case, which is the routing rule used in reverse. A step only a person can do adds
   * a `Needs owner:` line BELOW the verdict, so the final line matches neither row and the card
   * stays in Code Review wearing the report. Compared case-insensitively, the way the rows are,
   * so a step whose own text happened to read like a verdict could not route the card by accident.
   */
  it('ends a needs-owner pass on a line that matches neither Code Review row', () => {
    const output = runVerdict({
      checks: PASSING_CHECKS,
      findings: [
        {
          id: 1,
          severity: 'high',
          category: 'Correctness',
          location: 'src/sentry.ts:1',
          file: 'src/sentry.ts',
          mechanism: 'the production secret is not set',
          status: 'blocked',
          needsOwner: true,
          reason: 'this machine cannot be given the production secret',
          step: 'set RELAY_SENTRY_DSN in the production environment',
        },
      ],
    })
      .trimEnd()
      .split('\n');

    const finalLine = output[output.length - 1] ?? '';
    expect(finalLine).toBe('Needs owner: set RELAY_SENTRY_DSN in the production environment');
    // The verdict is still printed, directly above, so a person reads the same Blocked state.
    expect(output[output.length - 2]).toBe(finalLineOf('Code Review', 'Back for revisions'));
    for (const rowName of ['On to Testing', 'Back for revisions']) {
      expect(
        finalLine.toLowerCase(),
        `a needs-owner pass must not match the "${rowName}" row`,
      ).not.toBe(finalLineOf('Code Review', rowName).toLowerCase());
    }
  });
});

describe('board turn-end contracts: Executing', () => {
  it('asks the agent for exactly the line On to Code Review matches', () => {
    const applyFindings = turnEndRow('Executing', 'Apply findings').message ?? '';
    expectTextIn(applyFindings, 'the Apply findings message', `"${finalLineOf('Executing', 'On to Code Review')}"`);
  });

  // An agent told only "not as follow-up tasks" once took on the tasks it had just filed and
  // then deleted them. An unfiled finding still ships inside the task.
  it('keeps the findings pass off work already filed as a task', () => {
    const applyFindings = turnEndRow('Executing', 'Apply findings').message ?? '';
    expectTextIn(applyFindings, 'the Apply findings message', 'not as follow-up tasks');
    expectTextIn(applyFindings, 'the Apply findings message', 'never delete or move one');
  });
});

describe('board turn-end contracts: Testing', () => {
  const skillPath = '.claude/skills/pull-request/SKILL.md';

  it('has /pull-request print the On to Merge line in its report step and name the row', () => {
    const skill = readRepositoryFile(skillPath);
    const reportStep = sectionOf(skill, skillPath, '## Step 7 - Report');
    expectTextIn(reportStep, `${skillPath} Step 7`, `\`${finalLineOf('Testing', 'On to Merge')}\``);
    expectTextIn(sectionOf(skill, skillPath, '## Outcome line'), `${skillPath} Outcome line`, '"On to Merge"');
  });

  it('keeps the escalation line from reading as ready to merge', () => {
    const escalateStep = sectionOf(readRepositoryFile(skillPath), skillPath, '## Step 8b - Escalate');
    expectTextIn(escalateStep, `${skillPath} Step 8b`, '`PR: blocked`');
    expect('PR: blocked').not.toBe(finalLineOf('Testing', 'On to Merge'));
  });
});

describe('board turn-end contracts: Merge', () => {
  const skillPath = '.claude/skills/merge-pull-request/SKILL.md';

  it('has /merge-pull-request print the On to Release line in its report step and name the row', () => {
    const skill = readRepositoryFile(skillPath);
    const reportStep = sectionOf(skill, skillPath, '## Step 5 - Report');
    expectTextIn(reportStep, `${skillPath} Step 5`, `\`${finalLineOf('Merge', 'On to Release')}\``);
    expectTextIn(sectionOf(skill, skillPath, '## Outcome line'), `${skillPath} Outcome line`, '"Finish"');
  });

  it('has /merge-pull-request print the Back to Testing line in its re-verify step', () => {
    const skill = readRepositoryFile(skillPath);
    const reverifyStep = sectionOf(skill, skillPath, '## Step 2 - Re-verify');
    expectTextIn(reverifyStep, `${skillPath} Step 2`, `\`${finalLineOf('Merge', 'Back to Testing')}\``);
    expectTextIn(sectionOf(skill, skillPath, '## Outcome line'), `${skillPath} Outcome line`, '"Back to Testing"');
  });

  // Merging now ships, so the skill has to say so where the line is printed.
  it('warns in the skill that the merge line reaches real users', () => {
    const outcomeSection = sectionOf(readRepositoryFile(skillPath), skillPath, '## Outcome line');
    expectTextIn(outcomeSection, `${skillPath} Outcome line`, 'Releasing is now automatic');
    expect(turnEndRow('Merge', 'On to Release').targetColumn).toBe('Release');
  });

  // The opt-out exists so a batch of tasks can land under one version. It reads the same line as
  // On to Release, so only its label filter and its position above that row keep them apart.
  it('holds a no-release task at Done instead of shipping it', () => {
    const hold = turnEndRow('Merge', 'Hold for a batch release');
    expect(hold.targetColumn).toBe('Done');
    expect(hold.filter?.labels).toEqual(['no-release']);
    expect(textMatchOf(hold)).toBe(finalLineOf('Merge', 'On to Release'));
    expectTextIn(
      sectionOf(readRepositoryFile(skillPath), skillPath, '## Outcome line'),
      `${skillPath} Outcome line`,
      'no-release',
    );
  });

  // Testing's onEnter already sends /pull-request, so a message here would be a second prompt.
  it('sends a red-CI stop back to Testing with no message of its own, a limited number of times', () => {
    const backToTesting = turnEndRow('Merge', 'Back to Testing');
    expect(backToTesting.targetColumn).toBe('Testing');
    expect(backToTesting.message).toBeUndefined();
    expect(backToTesting.maxRuns, 'an unlimited back-route lets a red main bounce a task forever').toBeGreaterThan(0);
  });

  // Frequency counts across the board's own moves, so with On to Merge spent after the first
  // trip, a task would go green in Testing and then stay there.
  it('lets every round trip Back to Testing allows come back to Merge', () => {
    const backToTestingRuns = turnEndRow('Merge', 'Back to Testing').maxRuns ?? Number.POSITIVE_INFINITY;
    const onToMergeRuns = turnEndRow('Testing', 'On to Merge').maxRuns ?? Number.POSITIVE_INFINITY;
    expect(onToMergeRuns, 'On to Merge must allow one more run than Back to Testing').toBeGreaterThan(backToTestingRuns);
  });
});

describe('board turn-end contracts: Release', () => {
  const skillPath = '.claude/skills/release/SKILL.md';

  it('has /release print the Finish line in its report step and name the row', () => {
    const skill = readRepositoryFile(skillPath);
    const reportStep = sectionOf(skill, skillPath, '## Step 6 - Report');
    expectTextIn(reportStep, `${skillPath} Step 6`, `\`${finalLineOf('Release', 'Finish')}\``);
    expectTextIn(sectionOf(skill, skillPath, '## Outcome line'), `${skillPath} Outcome line`, '"Finish"');
  });

  // Done removes the worktree, so a failed deploy must not be archived behind this line.
  it('gates the line on the deploy having actually landed', () => {
    const outcomeSection = sectionOf(readRepositoryFile(skillPath), skillPath, '## Outcome line');
    expectTextIn(outcomeSection, `${skillPath} Outcome line`, 'print no outcome line');
    expect(turnEndRow('Release', 'Finish').targetColumn).toBe('Done');
  });

  /**
   * "Nothing to cut" is the one state where the commands cannot decide the outcome on their own:
   * an empty range means work already on `main` has shipped and work that never merged has not.
   * Step 1 has to send the agent to that decision, because a release that cut nothing otherwise
   * satisfies every gate below it and would archive a card whose work never landed.
   */
  it('makes the empty-range case decide the outcome line rather than assume it', () => {
    const skill = readRepositoryFile(skillPath);
    const step1 = sectionOf(skill, skillPath, '## Step 1 - Confirm there is something to release');
    expectTextIn(step1, `${skillPath} Step 1`, 'does not by itself mean this card is finished');
    expectTextIn(step1, `${skillPath} Step 1`, 'Print no outcome line');
    // And the gate list has to carry the same requirement, or the two could drift apart.
    const outcomeSection = sectionOf(skill, skillPath, '## Outcome line');
    expectTextIn(outcomeSection, `${skillPath} Outcome line`, 'actually inside that tag');
  });
});

describe('board turn-end contracts: row shape', () => {
  const columnNames = new Set(board.columns.map((column) => column.name));
  const everyRow = board.columns.flatMap((column) =>
    Object.entries(column.automations ?? {}).flatMap(([trigger, rows]) =>
      rows.map((row) => ({ columnName: column.name, trigger, row })),
    ),
  );
  const textMatchRows = everyRow.flatMap(({ columnName, trigger, row }) => {
    const finalLine = textMatchOf(row);
    return finalLine === undefined ? [] : [{ columnName, trigger, row, finalLine }];
  });

  it('pins every Text match row on the board, and finds every row it pins', () => {
    const onBoard = new Set(textMatchRows.map(({ columnName, row }) => `${columnName}/${row.name}`));
    expect(onBoard).toEqual(PINNED_ROWS);
  });

  it('puts a Text match only on a turn-end row', () => {
    for (const { columnName, trigger, row } of textMatchRows) {
      expect(trigger, `${columnName} "${row.name}"`).toBe('onTurnEnd');
    }
  });

  /**
   * Two rows may share a line only when a task filter tells them apart, and then the filtered
   * one has to come FIRST: a `move_to_column` ends the list, so an unfiltered row above a
   * filtered one would swallow every task and the filter would never be reached.
   */
  it("never lets one row's line match another in its column, unless a filter separates them", () => {
    for (const { columnName, row, finalLine } of textMatchRows) {
      for (const other of textMatchRows) {
        if (other.columnName !== columnName || other.row === row) continue;
        if (other.finalLine.toLowerCase() !== finalLine.toLowerCase()) continue;
        const oneIsFiltered = row.filter !== undefined || other.row.filter !== undefined;
        expect(oneIsFiltered, `${columnName}: "${finalLine}" is on two rows with no filter between them`).toBe(true);
      }
    }
  });

  it('puts a filtered row above the unfiltered row that shares its line', () => {
    for (const column of board.columns) {
      const rows = column.automations?.onTurnEnd ?? [];
      rows.forEach((row, rowIndex) => {
        if (row.filter === undefined) return;
        const line = textMatchOf(row);
        if (line === undefined) return;
        const unfilteredIndex = rows.findIndex(
          (other) => other.filter === undefined && textMatchOf(other)?.toLowerCase() === line.toLowerCase(),
        );
        if (unfilteredIndex === -1) return;
        expect(
          rowIndex,
          `${column.name}: filtered "${row.name}" must sit above unfiltered "${rows[unfilteredIndex]?.name}"`,
        ).toBeLessThan(unfilteredIndex);
      });
    }
  });

  it('moves only to a column the board has', () => {
    for (const { columnName, row } of everyRow) {
      if (row.type !== 'move_to_column' || row.targetColumn === undefined) continue;
      expect(columnNames.has(row.targetColumn), `${columnName} "${row.name}" -> ${row.targetColumn}`).toBe(true);
    }
  });
});
