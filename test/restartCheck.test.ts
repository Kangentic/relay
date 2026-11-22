/**
 * Coverage for scripts/deploy/restart-check.mjs, the monitor's check that a relay process start was
 * a deploy and not a crash, and for its wiring into .github/workflows/monitor.yml.
 *
 * Before it, monitor.yml asserted only `uptimeSeconds > 0`, so a relay that crashed and was brought
 * back by `restart: unless-stopped` passed every run. The cases pin what that check now relies on:
 *
 * 1. A crash-restart loop (a process up 40 s, the last deploy days ago) fails, and writes the
 *    output monitor.yml files its issue from. This is the case that used to pass silently.
 * 2. A start inside a deployment passes, including a rollback (a failed deployment, which still
 *    recreated the container) and a deployment still running.
 * 3. A crash between two deployments fails: neither the earlier deploy nor a later one that skipped
 *    its restart explains it, and an `inactive` status set when a later deployment superseded the
 *    earlier one does not stretch the earlier window over the crash.
 * 4. A start an earlier run already judged passes, so one restart is reported once and not on every
 *    run until the next deploy. A run whose check was skipped judged nothing, and the current run
 *    never counts as its own predecessor.
 * 5. An API failure fails closed without the restart output, and the token never reaches the log.
 * 6. The workflow wiring: the token scopes, the step name a later run looks the verdict up by, the
 *    step order, and the outputs the issue step reads. Drift there disables the check silently.
 *    The issue step's own script is run against a stub client too, since it only runs on a failure.
 *
 * Driven through its CLI against a stub GitHub API, like test/originLegStalls.test.ts and for the
 * same reason (`scripts/` is outside the tsconfig `include`). The child is spawned asynchronously,
 * since a synchronous exec would block the stub server it has to talk to.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const REPOSITORY_ROOT = path.join(import.meta.dirname, '..');
const SCRIPT_PATH = path.join(REPOSITORY_ROOT, 'scripts', 'deploy', 'restart-check.mjs');
const WORKFLOW_PATH = path.join(REPOSITORY_ROOT, '.github', 'workflows', 'monitor.yml');
const REPOSITORY = 'example/relay';
const CURRENT_RUN_ID = 999;
const TOKEN = 'test-token-never-logged';

interface StubResponse {
  readonly status: number;
  readonly body: unknown;
}

interface DeploymentFixture {
  readonly id: number;
  readonly ref: string;
  readonly createdAt: string;
  readonly statuses: ReadonlyArray<{ readonly state: string; readonly createdAt: string }>;
}

interface RunFixture {
  readonly id: number;
  readonly startedAt: string;
  /** The Restart check step's conclusion in that run, or null when the run had no such step. */
  readonly restartCheck: 'success' | 'failure' | 'skipped' | null;
}

interface CheckResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly outputs: string;
  readonly summary: string;
  readonly requests: ReadonlyArray<{ readonly url: string; readonly authorization: string | undefined }>;
}

const temporaryDirectories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
  while (servers.length > 0) {
    const server = servers.pop();
    if (server !== undefined) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function routesFor(
  deployments: readonly DeploymentFixture[],
  runs: readonly RunFixture[],
): Map<string, StubResponse> {
  const routes = new Map<string, StubResponse>();
  routes.set(`/repos/${REPOSITORY}/deployments`, {
    status: 200,
    body: deployments.map((deployment) => ({
      id: deployment.id,
      ref: deployment.ref,
      environment: 'production',
      created_at: deployment.createdAt,
    })),
  });
  for (const deployment of deployments) {
    routes.set(`/repos/${REPOSITORY}/deployments/${deployment.id}/statuses`, {
      status: 200,
      // Newest first, as the API returns them.
      body: [...deployment.statuses].reverse().map((status) => ({ state: status.state, created_at: status.createdAt })),
    });
  }
  routes.set(`/repos/${REPOSITORY}/actions/workflows/monitor.yml/runs`, {
    status: 200,
    body: { workflow_runs: runs.map((run) => ({ id: run.id, run_started_at: run.startedAt, status: 'completed' })) },
  });
  for (const run of runs) {
    const steps = [{ name: 'Check /metricz', conclusion: 'success' }];
    if (run.restartCheck !== null) steps.push({ name: 'Restart check', conclusion: run.restartCheck });
    routes.set(`/repos/${REPOSITORY}/actions/runs/${run.id}/jobs`, {
      status: 200,
      body: { jobs: [{ name: 'Scheduled health check', steps }] },
    });
  }
  return routes;
}

async function startStubApi(
  routes: ReadonlyMap<string, StubResponse>,
  requests: Array<{ url: string; authorization: string | undefined }>,
): Promise<string> {
  const server = createServer((request, response) => {
    const url = request.url ?? '';
    requests.push({ url, authorization: request.headers.authorization });
    const route = routes.get(url.split('?')[0] ?? '');
    const reply = route ?? { status: 404, body: { message: 'Not Found' } };
    response.writeHead(reply.status, { 'content-type': 'application/json' }).end(JSON.stringify(reply.body));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** The child's environment, without the GITHUB_* of a CI run: it must never write CI's real output file. */
function childEnvironment(overrides: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GITHUB_') && !key.startsWith('RUNNER_')) environment[key] = value;
  }
  return { ...environment, ...overrides };
}

async function runCheck(
  startedAt: string,
  routes: ReadonlyMap<string, StubResponse>,
  startedAtOverride?: string,
): Promise<CheckResult> {
  const requests: Array<{ url: string; authorization: string | undefined }> = [];
  const apiUrl = await startStubApi(routes, requests);
  const directory = mkdtempSync(path.join(os.tmpdir(), 'restart-check-'));
  temporaryDirectories.push(directory);
  const outputPath = path.join(directory, 'output');
  const summaryPath = path.join(directory, 'summary');
  writeFileSync(outputPath, '');
  writeFileSync(summaryPath, '');
  const child = spawn(process.execPath, [SCRIPT_PATH], {
    env: childEnvironment({
      STARTED_AT: startedAtOverride ?? String(Date.parse(startedAt) / 1000),
      GITHUB_REPOSITORY: REPOSITORY,
      GITHUB_API_URL: apiUrl,
      GITHUB_TOKEN: TOKEN,
      GITHUB_RUN_ID: String(CURRENT_RUN_ID),
      GITHUB_OUTPUT: outputPath,
      GITHUB_STEP_SUMMARY: summaryPath,
    }),
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const exitCode = await new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
  return {
    exitCode,
    stdout,
    stderr,
    outputs: readFileSync(outputPath, 'utf8'),
    summary: readFileSync(summaryPath, 'utf8'),
    requests,
  };
}

/** A deploy that ran 02:00:00 to 02:00:25 and recreated the relay at about 02:00:16. */
const DEPLOY_EARLY: DeploymentFixture = {
  id: 101,
  ref: 'v9.9.8',
  createdAt: '2026-11-10T02:00:00Z',
  statuses: [
    { state: 'waiting', createdAt: '2026-11-10T02:00:01Z' },
    { state: 'in_progress', createdAt: '2026-11-10T02:00:05Z' },
    { state: 'success', createdAt: '2026-11-10T02:00:25Z' },
  ],
};

/** A later deploy whose skip gate found nothing to change, so it did not restart the relay. */
const DEPLOY_LATE_SKIPPED_RESTART: DeploymentFixture = {
  id: 102,
  ref: 'v9.9.9',
  createdAt: '2026-11-10T07:00:00Z',
  statuses: [
    { state: 'in_progress', createdAt: '2026-11-10T07:00:04Z' },
    { state: 'success', createdAt: '2026-11-10T07:00:10Z' },
  ],
};

const EARLIER_CHECK: RunFixture = { id: 500, startedAt: '2026-11-10T01:00:00Z', restartCheck: 'success' };

describe('restart-check: a crash-restart loop', () => {
  it('fails a process up 40 seconds when the last deploy was days ago, and writes the issue output', async () => {
    const deployDaysAgo: DeploymentFixture = { ...DEPLOY_EARLY, createdAt: '2026-11-07T02:00:00Z', statuses: [] };
    const result = await runCheck(
      '2026-11-10T09:59:20Z',
      routesFor([deployDaysAgo], [{ id: 501, startedAt: '2026-11-10T04:00:00Z', restartCheck: 'success' }]),
    );
    expect(result.exitCode).toBe(1);
    expect(result.outputs).toContain('unexplained_restart=true\n');
    expect(result.outputs).toMatch(/^verdict=process started 2026-11-10T09:59:20Z, outside every production deployment/m);
    expect(result.outputs).toContain('after run 501 started its check at 2026-11-10T04:00:00Z');
    expect(result.summary).toContain('Restart check: process started 2026-11-10T09:59:20Z');
    // Days older than any deploy job runs, so its statuses are never fetched.
    expect(result.requests.some((request) => request.url.includes('/deployments/101/statuses'))).toBe(false);
    // Only the production environment can explain a restart.
    expect(result.requests.some((request) => request.url.includes('environment=production'))).toBe(true);
  });
});

describe('restart-check: a start a deployment explains', () => {
  it('passes a start inside a deployment window, before its final status', async () => {
    const result = await runCheck('2026-11-10T02:00:16Z', routesFor([DEPLOY_EARLY], [EARLIER_CHECK]));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('inside production deployment 101 (v9.9.8, 2026-11-10T02:00:00Z to 2026-11-10T02:00:25Z)');
    expect(result.outputs).toBe('');
  });

  it('passes a start inside a rollback, whose deployment ended in failure', async () => {
    const rollback: DeploymentFixture = {
      ...DEPLOY_EARLY,
      statuses: [
        { state: 'in_progress', createdAt: '2026-11-10T02:00:05Z' },
        { state: 'failure', createdAt: '2026-11-10T02:03:00Z' },
      ],
    };
    const result = await runCheck('2026-11-10T02:02:40Z', routesFor([rollback], [EARLIER_CHECK]));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('a deploy restart');
  });

  it('passes a start inside a deployment that is still running', async () => {
    const running: DeploymentFixture = {
      ...DEPLOY_EARLY,
      statuses: [{ state: 'in_progress', createdAt: '2026-11-10T02:00:05Z' }],
    };
    const result = await runCheck('2026-11-10T02:00:30Z', routesFor([running], [EARLIER_CHECK]));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('to still running');
  });
});

describe('restart-check: a crash between deployments', () => {
  it('fails a start after one deploy ended and before a later one that skipped its restart', async () => {
    const result = await runCheck(
      '2026-11-10T05:00:00Z',
      routesFor([DEPLOY_LATE_SKIPPED_RESTART, DEPLOY_EARLY], [{ id: 502, startedAt: '2026-11-10T04:00:00Z', restartCheck: 'success' }]),
    );
    expect(result.exitCode).toBe(1);
    expect(result.outputs).toContain('unexplained_restart=true\n');
  });

  it('does not let an inactive status, set when a later deployment superseded it, stretch the window', async () => {
    const superseded: DeploymentFixture = {
      ...DEPLOY_EARLY,
      statuses: [...DEPLOY_EARLY.statuses, { state: 'inactive', createdAt: '2026-11-10T07:00:12Z' }],
    };
    const result = await runCheck(
      '2026-11-10T05:00:00Z',
      routesFor([DEPLOY_LATE_SKIPPED_RESTART, superseded], [{ id: 502, startedAt: '2026-11-10T04:00:00Z', restartCheck: 'success' }]),
    );
    expect(result.exitCode).toBe(1);
  });
});

describe('restart-check: each restart is reported once', () => {
  it('passes a start that an earlier run judged, skipping a later run whose check was skipped', async () => {
    const result = await runCheck(
      '2026-11-10T05:00:00Z',
      routesFor(
        [DEPLOY_EARLY],
        [
          // Newest first. /metricz failed in this one, so its check never ran and judged nothing.
          { id: 504, startedAt: '2026-11-10T09:00:00Z', restartCheck: 'skipped' },
          // This one reported the 05:00 restart and failed.
          { id: 503, startedAt: '2026-11-10T06:00:00Z', restartCheck: 'failure' },
        ],
      ),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('before run 503 started its check at 2026-11-10T06:00:00Z: already judged there');
  });

  it('fails an unexplained start when no earlier run has a check, and never counts the current run', async () => {
    const result = await runCheck(
      '2026-11-10T05:00:00Z',
      routesFor(
        [DEPLOY_EARLY],
        [
          { id: CURRENT_RUN_ID, startedAt: '2026-11-10T09:00:00Z', restartCheck: 'success' },
          // A run from before this step existed.
          { id: 505, startedAt: '2026-11-10T04:30:00Z', restartCheck: null },
        ],
      ),
    );
    expect(result.exitCode).toBe(1);
    expect(result.outputs).toContain('and no earlier run has judged it');
    expect(result.requests.some((request) => request.url.includes(`/actions/runs/${CURRENT_RUN_ID}/jobs`))).toBe(false);
  });
});

describe('restart-check: fails closed', () => {
  it('exits 1 without the restart output when the API fails, and sends but never prints the token', async () => {
    const routes = routesFor([DEPLOY_EARLY], [EARLIER_CHECK]);
    routes.set(`/repos/${REPOSITORY}/deployments`, { status: 500, body: { message: `boom ${TOKEN}` } });
    const result = await runCheck('2026-11-10T05:00:00Z', routes);
    expect(result.exitCode).toBe(1);
    expect(result.outputs).toBe('');
    expect(result.stderr).toContain(`could not decide: GitHub API /repos/${REPOSITORY}/deployments answered 500`);
    expect(result.summary).toContain('Restart check: could not decide');
    expect(result.requests[0]?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(`${result.stdout}${result.stderr}${result.summary}`).not.toContain(TOKEN);
  });

  it('exits 1 without the restart output when STARTED_AT is not an epoch second', async () => {
    const result = await runCheck('2026-11-10T05:00:00Z', routesFor([], []), 'null');
    expect(result.exitCode).toBe(1);
    expect(result.outputs).toBe('');
    expect(result.stderr).toContain('could not decide: STARTED_AT must be');
  });
});

describe('monitor.yml wiring', () => {
  const workflow = readFileSync(WORKFLOW_PATH, 'utf8').replace(/\r\n/g, '\n');
  const script = readFileSync(SCRIPT_PATH, 'utf8');
  // Each step starts at six spaces and a dash; a comment above a step stays with the step before it.
  const steps = workflow.split(/\n(?= {6}- )/).slice(1);
  const stepIndex = (marker: string): number => steps.findIndex((step) => step.includes(marker));

  it('grants the token the scopes the check reads with', () => {
    const permissions = /^permissions:\n((?: {2}\S.*\n)+)/m.exec(workflow)?.[1] ?? '';
    expect(permissions).toContain('  actions: read\n');
    expect(permissions).toContain('  deployments: read\n');
  });

  it('names the step exactly what the script looks its earlier verdicts up by', () => {
    const stepName = /export const RESTART_CHECK_STEP_NAME = '([^']+)';/.exec(script)?.[1];
    expect(stepName).toBeDefined();
    const restartStep = steps[stepIndex('run: node scripts/deploy/restart-check.mjs')] ?? '';
    expect(restartStep).toMatch(new RegExp(`^ {6}- name: ${stepName}\n`));
    expect(restartStep).toContain('        id: restart\n');
    expect(restartStep).toContain("        if: ${{ !cancelled() && steps.metricz.outputs.started_at != '' }}\n");
    expect(restartStep).toContain('          STARTED_AT: ${{ steps.metricz.outputs.started_at }}\n');
  });

  it('records the start in /metricz before any assertion can stop that step', () => {
    const metriczStep = steps[stepIndex('- name: Check /metricz')] ?? '';
    expect(metriczStep).toContain('        id: metricz\n');
    const recordIndex = metriczStep.indexOf('echo "started_at=');
    expect(recordIndex).toBeGreaterThan(-1);
    expect(recordIndex).toBeLessThan(metriczStep.indexOf('if [ "$uptime" -le 0 ]'));
  });

  it('files the restart issue apart from the generic one, and comments when it is already open', async () => {
    // The step's own script, run against a stub client: it only ever runs on a failure, so a broken
    // branch in it would otherwise surface only during the incident it exists to report.
    const issueStep = steps[stepIndex('- name: File an issue on failure')] ?? '';
    const scriptLines = issueStep.split('\n');
    const scriptStart = scriptLines.findIndex((line) => line === '          script: |');
    expect(scriptStart).toBeGreaterThan(-1);
    const body = scriptLines
      .slice(scriptStart + 1)
      .filter((line) => line.startsWith(' '.repeat(12)) || line.trim() === '')
      .map((line) => line.slice(12))
      .join('\n');
    type IssueCall = { readonly method: string; readonly title?: string; readonly issueNumber?: number; readonly body: string };
    type StepScript = (github: unknown, context: unknown, process: unknown) => Promise<void>;
    const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
      ...parameters: string[]
    ) => StepScript;
    const stepScript = new AsyncFunction('github', 'context', 'process', body);
    const runStep = async (
      environment: Readonly<Record<string, string>>,
      openIssues: ReadonlyArray<{ readonly number: number; readonly title: string }>,
    ): Promise<IssueCall[]> => {
      const calls: IssueCall[] = [];
      const github = {
        rest: {
          issues: {
            listForRepo: async (parameters: { readonly labels: string; readonly state: string }) => {
              expect(parameters).toMatchObject({ labels: 'monitoring', state: 'open' });
              return { data: openIssues };
            },
            create: async (parameters: { readonly title: string; readonly body: string }) => {
              calls.push({ method: 'create', title: parameters.title, body: parameters.body });
            },
            createComment: async (parameters: { readonly issue_number: number; readonly body: string }) => {
              calls.push({ method: 'comment', issueNumber: parameters.issue_number, body: parameters.body });
            },
          },
        },
      };
      const context = { serverUrl: 'https://github.example', repo: { owner: 'example', repo: 'relay' }, runId: 42 };
      await stepScript(github, context, { env: environment });
      return calls;
    };
    const healthyOtherwise = { METRICZ_OUTCOME: 'success', PROBE_OUTCOME: 'success', PING_OUTCOME: 'success' };
    const restartOutputs = { UNEXPLAINED_RESTART: 'true', RESTART_VERDICT: 'process started 2026-11-10T05:00:00Z, outside' };

    const restartOnly = await runStep({ ...healthyOtherwise, ...restartOutputs }, []);
    expect(restartOnly).toEqual([
      expect.objectContaining({ method: 'create', title: 'Relay restarted outside a deploy' }),
    ]);
    expect(restartOnly[0]?.body).toContain('process started 2026-11-10T05:00:00Z');
    expect(restartOnly[0]?.body).toContain('https://github.example/example/relay/actions/runs/42');

    const restartWhileOpen = await runStep({ ...healthyOtherwise, ...restartOutputs }, [
      { number: 7, title: 'Relay restarted outside a deploy' },
    ]);
    expect(restartWhileOpen).toEqual([expect.objectContaining({ method: 'comment', issueNumber: 7 })]);

    const probeFailed = await runStep({ ...healthyOtherwise, PROBE_OUTCOME: 'failure' }, []);
    expect(probeFailed).toEqual([expect.objectContaining({ method: 'create', title: 'Relay monitoring check failed' })]);

    const both = await runStep({ ...healthyOtherwise, ...restartOutputs, PROBE_OUTCOME: 'failure' }, [
      { number: 8, title: 'Relay monitoring check failed' },
    ]);
    // The generic issue is filed once while open; the restart is its own issue.
    expect(both).toEqual([expect.objectContaining({ method: 'create', title: 'Relay restarted outside a deploy' })]);

    // A check that could not decide writes no restart output, so it is an ordinary monitor failure.
    const undecided = await runStep(healthyOtherwise, []);
    expect(undecided).toEqual([expect.objectContaining({ method: 'create', title: 'Relay monitoring check failed' })]);
  });

  it('runs after the dead-man ping and before the issue step, which reads its outputs', () => {
    const pingIndex = stepIndex('- name: Ping dead-man URL');
    const restartIndex = stepIndex('- name: Restart check');
    const issueIndex = stepIndex('- name: File an issue on failure');
    expect(pingIndex).toBeGreaterThan(-1);
    expect(restartIndex).toBeGreaterThan(pingIndex);
    expect(issueIndex).toBeGreaterThan(restartIndex);
    const issueStep = steps[issueIndex] ?? '';
    expect(issueStep).toContain('${{ steps.restart.outputs.unexplained_restart }}');
    expect(issueStep).toContain('${{ steps.restart.outputs.verdict }}');
    expect(script).toContain("unexplained_restart: 'true', verdict: line");
  });
});
