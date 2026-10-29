import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveProjectFlow, loadRunFlow } from '../src/utils/projectFlow.ts';

const run = (status, extra = {}) => ({ run_id: 'run_a', project_id: 'p1', type: 'bid_evaluation', status, created_at: '2026-10-15T00:00:00Z', ...extra });
const page = (items, next_cursor = null) => ({ items, next_cursor });
function api(runs = []) {
  return { listRuns: async () => page(runs), listReviews: async () => page([]), listReports: async () => page([]) };
}
test('new project opens upload with only project completed', async () => {
  const flow = await resolveProjectFlow(api(), 'p1');
  assert.equal(flow.destination, '/projects/p1/upload');
  assert.deepEqual(flow.completed, [1]);
  assert.deepEqual(flow.available, [1, 2]);
});
for (const status of ['pending', 'running', 'failed', 'cancelled']) {
  test(`${status} opens progress, not report`, async () => {
    const flow = await resolveProjectFlow(api([run(status)]), 'p1');
    assert.equal(flow.destination, '/runs/run_a');
    assert.equal(flow.available.includes(5), false);
  });
}
test('all run pages are searched, newest timestamp wins rather than ID', async () => {
  const client = api();
  client.listRuns = async ({ cursor }) => cursor ? page([run('awaiting_review', { run_id: 'run_a', created_at: '2026-10-16T00:00:00Z' })]) : page([run('running', { run_id: 'run_z' })], 'next');
  const flow = await resolveProjectFlow(client, 'p1');
  assert.equal(flow.destination, '/runs/run_a/review');
  assert.ok(flow.available.includes(3) && flow.available.includes(4));
});
test('equal timestamps use deterministic ID order', async () => {
  const flow = await resolveProjectFlow(api([run('running'), run('running', { run_id: 'run_z' })]), 'p1');
  assert.equal(flow.run.run_id, 'run_z');
});
test('valid report unlocks export and skipped review is explicit', async () => {
  const client = api();
  client.listReports = async ({}, query) => query.cursor ? page([{ report_id: '2', confirmed: true, stale: false }]) : page([{ report_id: '1', confirmed: false, stale: true }], 'next');
  const flow = await loadRunFlow(client, run('succeeded'));
  assert.equal(flow.destination, '/runs/run_a/report?report_id=2');
  assert.equal(flow.reviewLabel, '无需人工复核');
});
test('missing, stale or unconfirmed report cannot unlock export', async () => {
  for (const reports of [[], [{ confirmed: false, stale: false }], [{ confirmed: true, stale: true }]]) {
    const client = api();
    client.listReports = async () => page(reports);
    const flow = await loadRunFlow(client, run('succeeded'));
    assert.equal(flow.phase, 3);
    assert.ok(flow.notice);
  }
});
test('stale run overrides a seemingly valid report', async () => {
  const client = api();
  client.listReports = async () => page([{ confirmed: true, stale: false }]);
  assert.equal((await loadRunFlow(client, run('succeeded', { result_stale: true }))).phase, 3);
});
test('review history remains reachable while processing resumes', async () => {
  const client = api();
  client.listReviews = async () => page([{ kind: 'history' }]);
  const flow = await loadRunFlow(client, run('running'));
  assert.equal(flow.phase, 3);
  assert.ok(flow.available.includes(4));
  assert.equal(flow.notice, '复核已提交，继续运行');
});
test('query errors are propagated rather than interpreted as a new project', async () => {
  const client = api();
  client.listRuns = async () => { throw new Error('offline'); };
  await assert.rejects(resolveProjectFlow(client, 'p1'), /offline/);
});
test('resume targets newest valid report even when older versions appear first', async () => {
  const client = api();
  client.listReports = async () => page([
    { report_id: '1', revision: 1, confirmed: false, stale: true },
    { report_id: '2', revision: 2, confirmed: true, stale: false },
    { report_id: '3', revision: 3, confirmed: true, stale: false },
  ]);
  const flow = await loadRunFlow(client, run('succeeded'));
  assert.equal(flow.reportId, '3');
  assert.equal(flow.destination, '/runs/run_a/report?report_id=3');
});
