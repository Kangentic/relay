#!/usr/bin/env node
// Restart check for .github/workflows/monitor.yml. Decides whether the relay
// process the monitor just read restarted outside a deploy.
//
// /metricz only says how long the current process has been up. A crash that
// `restart: unless-stopped` recovers from reads as a healthy relay with a
// small uptime, and so does every deploy, which also restarts it. Comparing
// the uptime against the monitor's own interval cannot separate the two, and
// the interval is not real anyway: the schedule says every 30 minutes and
// GitHub ran it every 4 to 9 hours in November 2026.
//
// So this script asks what the start time was, not how long ago it was:
//
// 1. A start inside a production deployment's window is a deploy restart.
//    Every terminal state counts, because a rollback recreates the container
//    inside a failed deployment. A window runs from the deployment's creation
//    to its last status, but never past 30 minutes: deploys take seconds, and
//    no deploy job sets timeout-minutes, so a hung one (or one that never posts
//    a final status) would otherwise explain every crash for up to 6 hours.
// 2. A start before the previous monitor run read /metricz was already judged
//    by that run, so it passes here. That is what makes each restart reported
//    once rather than on every run until the next deploy. The read is dated by
//    that run's "Check /metricz" step start. Its run start is earlier, so it
//    would report a restart in between twice; its Restart check step start is
//    minutes later, so it would pass a restart in between that nobody reported.
// 3. Anything else is an unexplained restart: a crash, an OOM kill (a SIGKILL,
//    which never reaches Sentry), a host reboot or a manual restart. The script
//    exits 1 and writes `unexplained_restart=true` to GITHUB_OUTPUT.
//
// When the GitHub API cannot be read the script exits 1 WITHOUT that output: it
// fails closed, and monitor.yml reports it as an ordinary monitor failure. Its
// step still concluded, so the next run treats this one as having judged the
// window. That is the one gap, and it needs a restart and an API failure in the
// same run.
//
// Prints timestamps, deployment ids, refs and run ids only: never a token or a
// response body, since this workflow's logs are public.
//
// Env: STARTED_AT (epoch seconds, required), GITHUB_REPOSITORY (owner/name,
// required), GITHUB_API_URL, GITHUB_TOKEN, GITHUB_RUN_ID, GITHUB_OUTPUT,
// GITHUB_STEP_SUMMARY. Everything but the first two is optional, so it also
// runs from a workstation against the public API.

import { appendFileSync } from 'node:fs';
import process from 'node:process';
import { isEntrypoint } from '../lib/is-entrypoint.mjs';

/**
 * The name monitor.yml gives the step that runs this script. A later run finds this run's verdict by
 * that name in the jobs API, so the two must match exactly; test/restartCheck.test.ts pins both.
 */
export const RESTART_CHECK_STEP_NAME = 'Restart check';

/**
 * The name monitor.yml gives the step that reads /metricz. A later run dates this run's read by that
 * step's start in the jobs API, so it is a contract too; test/restartCheck.test.ts pins both.
 */
export const METRICZ_STEP_NAME = 'Check /metricz';

const MONITOR_WORKFLOW_FILE = 'monitor.yml';
const DEPLOY_ENVIRONMENT = 'production';
const DEPLOYMENTS_PAGE_SIZE = 30;
const PREVIOUS_RUNS_PAGE_SIZE = 10;
/**
 * The longest a deployment's window runs from its creation, whatever its statuses say. Production
 * deploys took 20 to 90 seconds in 2026, so this leaves every real one whole, rollback included.
 */
const MAX_DEPLOY_WINDOW_MS = 30 * 60 * 1000;
/** Covers the uptime's whole-second rounding and the gap between the /metricz read and the clock read. */
const WINDOW_SLACK_BEFORE_MS = 60_000;
const WINDOW_SLACK_AFTER_MS = 120_000;
const TERMINAL_DEPLOYMENT_STATES = new Set(['success', 'failure', 'error']);
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function isoSeconds(epochMs) {
  return new Date(epochMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function parseTimestamp(value, what) {
  const epochMs = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(epochMs)) throw new Error(`${what} is not a timestamp`);
  return epochMs;
}

/**
 * The decision, with no I/O. `deployWindows` carry `startMs` and `endMs` (an in-progress deployment's
 * end is the caller's now, both capped at MAX_DEPLOY_WINDOW_MS); `previousCheck` carries `runId` and
 * `readAtMs`, when that run read /metricz, and is null when no earlier run ran this step.
 */
export function judgeRestart({ startedAtMs, deployWindows, previousCheck }) {
  const window = deployWindows.find(
    (candidate) =>
      startedAtMs >= candidate.startMs - WINDOW_SLACK_BEFORE_MS &&
      startedAtMs <= candidate.endMs + WINDOW_SLACK_AFTER_MS,
  );
  if (window !== undefined) return { verdict: 'deploy', window };
  if (previousCheck !== null && startedAtMs < previousCheck.readAtMs) return { verdict: 'judged', previousCheck };
  return { verdict: 'unexplained', previousCheck };
}

export function describeJudgement(startedAtMs, judgement) {
  const started = `process started ${isoSeconds(startedAtMs)}`;
  if (judgement.verdict === 'deploy') {
    const { window } = judgement;
    return (
      `${started}, inside ${DEPLOY_ENVIRONMENT} deployment ${window.id} (${window.ref}, ` +
      `${isoSeconds(window.startMs)} to ${window.terminal ? isoSeconds(window.endMs) : 'still running'}): a deploy restart`
    );
  }
  if (judgement.verdict === 'judged') {
    const { previousCheck } = judgement;
    return `${started}, before run ${previousCheck.runId} read /metricz at ${isoSeconds(previousCheck.readAtMs)}: already judged there`;
  }
  const after =
    judgement.previousCheck === null
      ? 'and no earlier run has judged it'
      : `and after run ${judgement.previousCheck.runId} read /metricz at ${isoSeconds(judgement.previousCheck.readAtMs)}`;
  return (
    `${started}, outside every ${DEPLOY_ENVIRONMENT} deployment ${after}: an unexplained restart ` +
    `(a crash, an OOM kill, a host reboot or a manual restart; see infra/README.md, "Relay restarted outside a deploy")`
  );
}

function createApiClient(apiUrl, token) {
  const headers = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'relay-monitor-restart-check',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  return async function getJson(pathAndQuery) {
    const response = await fetch(`${apiUrl}${pathAndQuery}`, { headers });
    // The path only, never the body: an error body can echo request details back.
    if (!response.ok) throw new Error(`GitHub API ${pathAndQuery.split('?')[0]} answered ${response.status}`);
    return response.json();
  };
}

async function collectDeployWindows(getJson, repository, startedAtMs, nowMs) {
  const deployments = await getJson(
    `/repos/${repository}/deployments?environment=${DEPLOY_ENVIRONMENT}&per_page=${DEPLOYMENTS_PAGE_SIZE}`,
  );
  if (!Array.isArray(deployments)) throw new Error('deployments response is not a list');
  const windows = [];
  for (const deployment of deployments) {
    const createdAtMs = parseTimestamp(deployment.created_at, `deployment ${deployment.id} created_at`);
    // Created after the start (plus slack) cannot contain it. Created longer before it than the
    // longest window (plus slack) cannot either, so its statuses are never fetched.
    if (createdAtMs > startedAtMs + WINDOW_SLACK_BEFORE_MS) continue;
    if (createdAtMs < startedAtMs - MAX_DEPLOY_WINDOW_MS - WINDOW_SLACK_AFTER_MS) continue;
    if (!Number.isSafeInteger(deployment.id)) throw new Error('deployment id is not an integer');
    const statuses = await getJson(`/repos/${repository}/deployments/${deployment.id}/statuses?per_page=100`);
    if (!Array.isArray(statuses)) throw new Error(`deployment ${deployment.id} statuses response is not a list`);
    // `inactive` is set when a later deployment supersedes this one, long after its job ended, so it
    // would stretch the window over time no deploy was running.
    const activeStatuses = statuses.filter((status) => status.state !== 'inactive');
    const terminal = activeStatuses.some((status) => TERMINAL_DEPLOYMENT_STATES.has(status.state));
    const lastStatusMs = activeStatuses.reduce(
      (latestMs, status) => Math.max(latestMs, parseTimestamp(status.created_at, `deployment ${deployment.id} status`)),
      createdAtMs,
    );
    windows.push({
      id: deployment.id,
      ref: typeof deployment.ref === 'string' ? deployment.ref : 'unknown ref',
      startMs: createdAtMs,
      // Capped, so a job that hung for hours, or never posted a final status, stops explaining
      // restarts once a real deploy would long have finished.
      endMs: Math.min(terminal ? lastStatusMs : nowMs, createdAtMs + MAX_DEPLOY_WINDOW_MS),
      terminal,
    });
  }
  return windows;
}

async function findPreviousCheck(getJson, repository, currentRunId) {
  const runsResponse = await getJson(
    `/repos/${repository}/actions/workflows/${MONITOR_WORKFLOW_FILE}/runs?status=completed&per_page=${PREVIOUS_RUNS_PAGE_SIZE}`,
  );
  const runs = runsResponse?.workflow_runs;
  if (!Array.isArray(runs)) throw new Error('workflow runs response has no workflow_runs list');
  for (const run of runs) {
    if (!Number.isSafeInteger(run.id)) throw new Error('workflow run id is not an integer');
    if (String(run.id) === currentRunId) continue;
    const jobsResponse = await getJson(`/repos/${repository}/actions/runs/${run.id}/jobs`);
    const jobs = jobsResponse?.jobs;
    if (!Array.isArray(jobs)) throw new Error(`run ${run.id} jobs response has no jobs list`);
    // Skipped means that run never read an uptime, so it judged nothing.
    const judgingJob = jobs.find((job) =>
      (job.steps ?? []).some(
        (step) =>
          step.name === RESTART_CHECK_STEP_NAME && (step.conclusion === 'success' || step.conclusion === 'failure'),
      ),
    );
    if (judgingJob === undefined) continue;
    // A process started before that run read /metricz is the one it judged. With no step start,
    // fall back to the run's own start: it is earlier, so it can only report a restart twice, never
    // pass one that nobody reported.
    const metriczStep = judgingJob.steps.find((step) => step.name === METRICZ_STEP_NAME);
    const readAtMs =
      typeof metriczStep?.started_at === 'string'
        ? parseTimestamp(metriczStep.started_at, `run ${run.id} ${METRICZ_STEP_NAME} started_at`)
        : parseTimestamp(run.run_started_at, `run ${run.id} run_started_at`);
    return { runId: run.id, readAtMs };
  }
  return null;
}

function writeOutputs(outputPath, outputs) {
  if (!outputPath) return;
  appendFileSync(outputPath, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(''));
}

function writeSummary(line) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) appendFileSync(summaryPath, `Restart check: ${line}\n`);
}

async function main() {
  const inGitHubActions = process.env.GITHUB_ACTIONS === 'true';
  const startedAtSeconds = Number(process.env.STARTED_AT);
  const repository = process.env.GITHUB_REPOSITORY ?? '';
  const apiUrl = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
  try {
    if (!Number.isSafeInteger(startedAtSeconds) || startedAtSeconds <= 0) {
      throw new Error('STARTED_AT must be the process start in whole epoch seconds');
    }
    if (!REPOSITORY_PATTERN.test(repository)) throw new Error('GITHUB_REPOSITORY must be owner/name');
    const startedAtMs = startedAtSeconds * 1000;
    const getJson = createApiClient(apiUrl, process.env.GITHUB_TOKEN);
    const deployWindows = await collectDeployWindows(getJson, repository, startedAtMs, Date.now());
    const previousCheck = await findPreviousCheck(getJson, repository, process.env.GITHUB_RUN_ID ?? '');
    const judgement = judgeRestart({ startedAtMs, deployWindows, previousCheck });
    const line = describeJudgement(startedAtMs, judgement);
    writeSummary(line);
    if (judgement.verdict !== 'unexplained') {
      console.log(`restart check: OK, ${line}`);
      return 0;
    }
    writeOutputs(process.env.GITHUB_OUTPUT, { unexplained_restart: 'true', verdict: line });
    console.log(inGitHubActions ? `::error title=Relay restarted outside a deploy::${line}` : `restart check: FAILED, ${line}`);
    return 1;
  } catch (error) {
    const line = `could not decide: ${error instanceof Error ? error.message : String(error)}`;
    writeSummary(line);
    console.error(`restart check: ${line}`);
    return 1;
  }
}

if (isEntrypoint(import.meta.url)) {
  process.exitCode = await main();
}
