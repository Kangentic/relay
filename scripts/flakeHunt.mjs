#!/usr/bin/env node
// Flake hunter for the unit suite: runs `vitest run --project unit` N times and
// reports only the crash rate and which test file failed to report, so an
// intermittent "Worker exited unexpectedly" can be measured instead of
// re-rolled. Written for the investigation into that crash on Windows; kept in
// the repo so the next person does not have to rebuild it.
//
// Usage:
//   node scripts/flakeHunt.mjs --runs 30
//   node scripts/flakeHunt.mjs --runs 30 --node C:\path\to\node22\node.exe
//   node scripts/flakeHunt.mjs --runs 30 -- --pool=threads
//
// Flags (all optional):
//   --runs       how many times to run the suite            (default 30)
//   --node       node binary to run vitest under. Use this to hold the repo
//                fixed and vary only the runtime, e.g. against a portable
//                Node 22 unpacked into a scratch directory (default: the
//                node running this script)
//   --project    vitest project to run                      (default unit)
//   --keep-going report the full run count even after the first crash. Off by
//                default: the first crash is usually all you need, and each
//                run costs real wall clock
//   --log-dir    where the full output of each run is written
//                (default: a fresh temp directory, printed at startup)
//   --patch-tinypool
//                temporarily rewrite tinypool's onUnexpectedExit so the worker
//                exit code and signal reach the error message. Tinypool
//                registers that handler with no parameters, so by default the
//                one number that says *how* the worker died is discarded. The
//                patch is reverted when the run ends normally, and on SIGINT
//                where the platform delivers it. A hard kill can still leave
//                it applied, so if worker exit codes show up when you did not
//                ask for them, re-run with this flag and let it finish, or
//                `npm install --no-engine-strict` to restore the vendored file.
//                The override is needed because you would be hunting on Node
//                24, which `.npmrc`'s engine-strict makes a hard install failure
//   --           everything after a bare `--` is forwarded to vitest verbatim,
//                e.g. `-- --pool=threads --no-file-parallelism`
//
// Why it parses the terminal output rather than --reporter=json: the JSON
// reporter writes its file when the run finishes reporting, so on exactly the
// runs this script exists to catch, that file can be missing or truncated. The
// per-file tick lines and the `Test Files x passed (y)` summary are what a
// crashed run does still print.
//
// Naming the guilty file: under the default forks pool with isolate, Vitest
// runs each test file in its own child process (measured: 23 files, 23
// distinct pids). So the file that never reported is the file that crashed,
// not a bystander. This script recovers it by diffing the files that printed a
// result against every file it has seen report across the session.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vitestEntry = join(repositoryRoot, 'node_modules', 'vitest', 'vitest.mjs');

function parseArgs(argv) {
  const options = {
    runs: 30,
    nodeBinary: process.execPath,
    project: 'unit',
    keepGoing: false,
    patchTinypool: false,
    logDirectory: null,
    vitestArgs: [],
  };
  for (let argumentIndex = 2; argumentIndex < argv.length; argumentIndex += 1) {
    const flag = argv[argumentIndex];
    if (flag === '--') {
      options.vitestArgs = argv.slice(argumentIndex + 1);
      break;
    }
    if (flag === '--keep-going') {
      options.keepGoing = true;
      continue;
    }
    if (flag === '--patch-tinypool') {
      options.patchTinypool = true;
      continue;
    }
    const value = argv[argumentIndex + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    // Every value-taking flag would otherwise swallow the next flag as a literal
    // value and drop its effect silently. `--runs` and `--node` are covered
    // incidentally by their own validation; `--project` and `--log-dir` are not,
    // and `--log-dir --keep-going` would quietly stop the hunt at the first crash
    // while writing logs into a directory named `--keep-going`.
    if (value.startsWith('--')) throw new Error(`${flag} needs a value, got the flag "${value}"`);
    argumentIndex += 1;
    if (flag === '--runs') {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`--runs needs a positive integer, got "${value}"`);
      options.runs = parsed;
      continue;
    }
    if (flag === '--node') {
      if (!existsSync(value)) throw new Error(`--node binary not found: ${value}`);
      options.nodeBinary = value;
      continue;
    }
    if (flag === '--project') {
      options.project = value;
      continue;
    }
    if (flag === '--log-dir') {
      options.logDirectory = value;
      continue;
    }
    throw new Error(`Unknown flag: ${flag}`);
  }
  return options;
}

// Tinypool declares `onUnexpectedExit = () => {...}` with no parameters, so
// Node's (code, signal) arguments are dropped and the error says only that the
// worker died. Folding them into the message is what distinguishes a native
// access violation (3221225477 / 0xC0000005 on Windows) from an abort, an
// uncaught exception, or a deliberate process.exit(0).
const tinypoolEntry = join(repositoryRoot, 'node_modules', 'tinypool', 'dist', 'index.js');
const TINYPOOL_ORIGINAL = `	onUnexpectedExit = () => {
		this.process.emit("error", new Error("Worker exited unexpectedly"));
	};`;
const TINYPOOL_PATCHED = `	onUnexpectedExit = (code, signal) => {
		this.process.emit("error", new Error(\`Worker exited unexpectedly [pid=\${this.process.pid} code=\${code} signal=\${signal}]\`));
	};`;

function patchTinypool() {
  const source = readFileSync(tinypoolEntry, 'utf8');
  // Already patched means a previous run was killed before it could revert.
  // Still hand back a real revert rather than a no-op, so the file cannot stay
  // patched indefinitely once any run exits cleanly.
  if (!source.includes(TINYPOOL_PATCHED)) {
    if (!source.includes(TINYPOOL_ORIGINAL)) {
      throw new Error(`cannot patch ${tinypoolEntry}: onUnexpectedExit does not match the expected source (tinypool version changed?)`);
    }
    writeFileSync(tinypoolEntry, source.replace(TINYPOOL_ORIGINAL, TINYPOOL_PATCHED));
  }
  let reverted = false;
  return () => {
    if (reverted) return;
    reverted = true;
    writeFileSync(tinypoolEntry, readFileSync(tinypoolEntry, 'utf8').replace(TINYPOOL_PATCHED, TINYPOOL_ORIGINAL));
  };
}

function runOnce(options) {
  return new Promise((resolveRun) => {
    const child = spawn(
      options.nodeBinary,
      [vitestEntry, 'run', '--project', options.project, ...options.vitestArgs],
      {
        cwd: repositoryRoot,
        // Deliberately no CI=1: the point is to reproduce what `npm test` does
        // on this machine, so the child's environment stays as close to a
        // plain local run as piping stdio allows.
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    // Decode as UTF-8 through a StringDecoder rather than per-chunk
    // Buffer.toString, so a multi-byte glyph (the reporter's tick) split across
    // a chunk boundary does not turn into replacement characters in the log.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.on('error', (error) => resolveRun({ output: `${output}\nspawn failed: ${error.message}`, exitCode: null }));
    child.on('close', (exitCode) => resolveRun({ output, exitCode }));
  });
}

// Vitest prints `Test Files  22 passed (23)` / `Tests  297 passed (304)`, where
// the parenthesised number is the total it expected to run. On a worker death
// the two disagree, and the gap is what never reported.
function parseSummaryCounts(strippedOutput, label) {
  const match = strippedOutput.match(new RegExp(`${label}\\s+.*?\\((\\d+)\\)`));
  if (!match) return null;
  const total = Number(match[1]);
  const reported = [...strippedOutput.matchAll(new RegExp(`${label}\\s+(.*?)\\((\\d+)\\)`, 'g'))]
    .flatMap((summaryMatch) => [...summaryMatch[1].matchAll(/(\d+)\s+(?:passed|failed|skipped|todo)/g)])
    .reduce((runningTotal, countMatch) => runningTotal + Number(countMatch[1]), 0);
  return { reported, total };
}

function stripAnsi(output) {
  return output.replace(/\x1b\[[0-9;]*m/g, '');
}

// A Windows NTSTATUS exit code (0xC0000000 and up) means the process was torn
// down by the OS, not by vitest. Under `--pool=threads` the crash takes the
// main vitest process with it, so there is no "Worker exited unexpectedly"
// message and no summary at all: without this check such a run would be
// misfiled as an ordinary test failure.
function isNativeCrashExit(exitCode) {
  return typeof exitCode === 'number' && exitCode >= 0xc0000000;
}

// Takes the ANSI-stripped output. Matching the crash phrase against raw text
// works today only because vitest wraps the whole message in a single colour
// span; strip first so a future reporter that colours it in pieces cannot
// silently downgrade a real crash to an ordinary test failure.
function classify(strippedOutput, exitCode) {
  const workerDied = /Worker exited unexpectedly/.test(strippedOutput) || isNativeCrashExit(exitCode);
  const files = parseSummaryCounts(strippedOutput, 'Test Files');
  const tests = parseSummaryCounts(strippedOutput, 'Tests');
  const workerExit = strippedOutput.match(/Worker exited unexpectedly \[pid=(\d+) code=(\S+) signal=(\S+)\]/);
  if (workerDied) {
    return {
      kind: 'worker-death',
      files,
      tests,
      exitCode,
      workerExit: workerExit
        ? { pid: workerExit[1], code: workerExit[2], signal: workerExit[3] }
        : isNativeCrashExit(exitCode)
          ? { pid: 'main', code: String(exitCode), signal: 'null' }
          : null,
    };
  }
  if (exitCode !== 0) return { kind: 'test-failure', files, tests, exitCode };
  return { kind: 'clean', files, tests, exitCode };
}

// Vitest's non-TTY reporter prints one line per finished file, e.g.
//   ✓ |unit| test/rendezvous.test.ts (6 tests) 55ms
// A file whose process died never prints one, so the set of files that did
// report, subtracted from every file seen reporting so far this session, names
// the crash victim.
function parseReportedFiles(strippedOutput) {
  return new Set([...strippedOutput.matchAll(/\|[^|\n]*\|\s+(\S+\.test\.ts)/g)].map((match) => match[1]));
}

function formatCounts(counts) {
  if (!counts) return 'unparsed';
  return counts.reported === counts.total ? `${counts.total}` : `${counts.reported}/${counts.total} (short by ${counts.total - counts.reported})`;
}

async function main() {
  const options = parseArgs(process.argv);
  if (!existsSync(vitestEntry)) {
    throw new Error(`vitest not found at ${vitestEntry} - run \`npm install\` in this worktree first`);
  }

  const logDirectory = options.logDirectory ?? mkdtempSync(join(tmpdir(), 'relay-flake-'));
  mkdirSync(logDirectory, { recursive: true });
  const forwarded = options.vitestArgs.length > 0 ? ` ${options.vitestArgs.join(' ')}` : '';
  console.log(`flake hunt: ${options.runs} runs of \`vitest run --project ${options.project}${forwarded}\``);
  console.log(`  node       ${options.nodeBinary}`);
  console.log(`  logs       ${logDirectory}`);

  let revertTinypool = () => {};
  if (options.patchTinypool) {
    revertTinypool = patchTinypool();
    // Ctrl-C must not leave a patched node_modules behind.
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.once(signal, () => {
        revertTinypool();
        process.exit(130);
      });
    }
    console.log('  tinypool   patched to report the worker exit code (reverted on exit)');
  }
  console.log('');

  try {
    await hunt(options, logDirectory);
  } finally {
    revertTinypool();
  }
}

async function hunt(options, logDirectory) {
  const crashes = [];
  const failures = [];
  // Every test file seen reporting a result so far. A clean run fills this in
  // one go; it is the reference the crashed runs are diffed against.
  const knownFiles = new Set();
  const startedAt = Date.now();

  for (let runIndex = 1; runIndex <= options.runs; runIndex += 1) {
    const { output, exitCode } = await runOnce(options);
    // Stripped once per run: classification and the reported-file diff both work
    // on plain text, while the log written below keeps the raw output verbatim.
    const plainOutput = stripAnsi(output);
    const result = classify(plainOutput, exitCode);
    writeFileSync(join(logDirectory, `run-${String(runIndex).padStart(3, '0')}-${result.kind}.log`), output);

    const reported = parseReportedFiles(plainOutput);
    for (const file of reported) knownFiles.add(file);

    if (result.kind === 'clean') {
      process.stdout.write(`  run ${runIndex}/${options.runs}: clean\n`);
      continue;
    }

    const victims = [...knownFiles].filter((file) => !reported.has(file));
    const record = { runIndex, ...result, victims };
    if (result.kind === 'worker-death') crashes.push(record);
    else failures.push(record);

    console.log(`  run ${runIndex}/${options.runs}: ${result.kind.toUpperCase()} (exit ${exitCode})`);
    if (result.workerExit) {
      console.log(`    worker      pid ${result.workerExit.pid} exited code=${result.workerExit.code} signal=${result.workerExit.signal}`);
    }
    console.log(`    test files  ${formatCounts(result.files)}`);
    console.log(`    tests       ${formatCounts(result.tests)}`);
    for (const victim of victims) console.log(`    never reported  ${victim}`);
    if (victims.length === 0) {
      console.log('    never reported  (unknown: no clean run yet to compare the file list against)');
    }

    if (!options.keepGoing && result.kind === 'worker-death') {
      console.log('');
      console.log('stopping at the first worker death; pass --keep-going to measure a full rate');
      break;
    }
  }

  const runsCompleted = options.keepGoing ? options.runs : Math.min(options.runs, crashes.length > 0 ? crashes[0].runIndex : options.runs);
  const elapsedMinutes = ((Date.now() - startedAt) / 60_000).toFixed(1);
  // Without --keep-going the loop breaks on the first crash, so the quotient is
  // 1/(the run that crashed): an artefact of stopping, not a measurement. Say so
  // rather than printing a number that reads like a rate and would be wrong to
  // quote anywhere.
  const stoppedAtFirstCrash = !options.keepGoing && crashes.length > 0;

  console.log('');
  console.log('summary');
  console.log(`  runs             ${runsCompleted}`);
  console.log(`  worker deaths    ${crashes.length}`);
  console.log(`  test failures    ${failures.length}`);
  if (stoppedAtFirstCrash) {
    console.log(`  crash rate       not measured (stopped at the first crash on run ${runsCompleted}; use --keep-going)`);
  } else {
    console.log(`  crash rate       ${((crashes.length / runsCompleted) * 100).toFixed(1)}%`);
  }
  console.log(`  elapsed          ${elapsedMinutes} min`);

  const victimTally = new Map();
  for (const crash of crashes) {
    for (const victim of crash.victims) {
      victimTally.set(victim, (victimTally.get(victim) ?? 0) + 1);
    }
  }
  if (victimTally.size > 0) {
    console.log('  files that never reported (the file that crashed):');
    for (const [file, count] of [...victimTally].sort((left, right) => right[1] - left[1])) {
      console.log(`    ${count}x  ${file}`);
    }
  }

  console.log(`  full output      ${logDirectory}`);
  if (crashes.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`flake hunt failed: ${error instanceof Error ? error.message : String(error)}`);
  // Not process.exit(1): stderr writes are asynchronous once the output is
  // redirected, so exiting here can truncate the one line that says what went
  // wrong. Nothing is holding the event loop open at this point.
  process.exitCode = 1;
});
