import type { ApiClient, Run, Page, Project } from '../api/client';

export type Phase = 1 | 2 | 3 | 4 | 5;
export interface ProjectFlow {
  projectId: string;
  run: Run | null;
  reportId?: string;
  phase: Phase;
  destination: string;
  completed: Phase[];
  available: Phase[];
  reviewLabel: string;
  notice: string;
}
type FlowApi = Pick<ApiClient, 'listRuns' | 'listReviews' | 'listReports'>;

export async function allPages<T>(load: (cursor: string | null) => Promise<Page<T>>): Promise<T[]> {
  const items: T[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = await load(cursor);
    items.push(...page.items);
    cursor = page.next_cursor ?? null;
    if (cursor && seen.has(cursor)) throw new Error('分页游标重复，请刷新后重试');
    if (cursor) seen.add(cursor);
  } while (cursor);
  return items;
}

export function newProjectFlow(projectId: string): ProjectFlow {
  return { projectId, run: null, phase: 2, destination: `/projects/${encodeURIComponent(projectId)}/upload`,
    completed: [1], available: [1, 2], reviewLabel: '逐条确认', notice: '' };
}

export async function resolveProjectFlow(api: FlowApi, projectId: string): Promise<ProjectFlow> {
  const runs = await allPages(cursor => api.listRuns({ project_id: projectId, type: 'bid_evaluation', limit: 100, cursor }));
  const latest = runs.filter(r => r.project_id === projectId && r.type === 'bid_evaluation').sort((a, b) =>
    Date.parse(b.created_at ?? '') - Date.parse(a.created_at ?? '') || b.run_id.localeCompare(a.run_id))[0];
  return latest ? loadRunFlow(api, latest) : newProjectFlow(projectId);
}

export async function loadRunFlow(api: FlowApi, run: Run): Promise<ProjectFlow> {
  const flow = newProjectFlow(run.project_id);
  const base = `/runs/${encodeURIComponent(run.run_id)}`;
  flow.run = run;
  flow.phase = 3;
  flow.destination = base;
  flow.completed = [1, 2];
  flow.available = [1, 2, 3];
  const reviews = await allPages(cursor => api.listReviews(run.run_id, { limit: 100, cursor }));
  const reviewed = reviews.some(r => r.kind === 'history');
  if (reviewed) flow.available.push(4);
  if (run.status === 'awaiting_review') {
    flow.completed.push(3);
    flow.phase = 4;
    flow.destination = `${base}/review`;
    if (!flow.available.includes(4)) flow.available.push(4);
  } else if (run.status === 'succeeded') {
    const reports = await allPages(cursor => api.listReports(run.run_id, { limit: 100, cursor }));
    const report = reports.filter(r => r.confirmed && !r.stale).sort((a, b) => b.revision - a.revision || b.report_id.localeCompare(a.report_id, undefined, { numeric: true }))[0];
    if (!run.result_stale && report) {
      flow.phase = 5;
      flow.reportId = report.report_id;
      flow.destination = `${base}/report?report_id=${encodeURIComponent(report.report_id)}`;
      flow.completed = [1, 2, 3, 4];
      flow.available = [1, 2, 3, 4, 5];
      flow.reviewLabel = reviewed ? '复核已完成' : '无需人工复核';
    } else flow.notice = '报告尚未就绪或已过期，请检查运行状态后刷新。';
  } else if (reviewed && (run.status === 'pending' || run.status === 'running')) {
    flow.notice = '复核已提交，继续运行';
  }
  return flow;
}

// Only names are cached. Workflow decisions always come from API responses.
const projectNames = new Map<string, string>();
export function rememberProject(project: Project): void { projectNames.set(project.project_id, project.name); }
export function cachedProjectName(id: string): string { return projectNames.get(id) ?? id; }
export async function lookupProjectName(api: Pick<ApiClient, 'listProjects'>, id: string): Promise<string> {
  if (projectNames.has(id)) return cachedProjectName(id);
  let cursor: string | null = null;
  const seen = new Set<string>();
  do {
    const page = await api.listProjects({ limit: 100, cursor });
    page.items.forEach(rememberProject);
    if (projectNames.has(id)) return cachedProjectName(id);
    cursor = page.next_cursor ?? null;
    if (cursor && seen.has(cursor)) break;
    if (cursor) seen.add(cursor);
  } while (cursor);
  return id;
}
