import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useSession } from './session';
import { cachedProjectName, loadRunFlow, lookupProjectName, newProjectFlow, resolveProjectFlow, type ProjectFlow, type Phase } from '../utils/projectFlow';
import { href, navigate, useQuery, type RouteMatch } from '../utils/router';
import { ErrorNotice } from '../components/core';

interface Journey {
  flow: ProjectFlow | null;
  name: string;
  error: Error | null;
  loading: boolean;
  refresh: () => void;
}
const Context = createContext<Journey>({ flow: null, name: '', error: null, loading: false, refresh: () => {} });
export const useJourney = () => useContext(Context);
export function refreshJourney(): void { window.dispatchEvent(new Event('project-flow-changed')); }

export function JourneyProvider({ route, children }: { route: RouteMatch; children: ReactNode }) {
  const { api } = useSession();
  const query = useQuery();
  const projectId = route.params.projectId ?? (route.name === 'runNew' ? query.get('project_id') : null);
  const runId = route.params.runId ?? (projectId ? query.get('run_id') : null);
  const [flow, setFlow] = useState<ProjectFlow | null>(null);
  const [name, setName] = useState(projectId ? cachedProjectName(projectId) : '');
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const refresh = () => setNonce(n => n + 1);
  useEffect(() => {
    window.addEventListener('project-flow-changed', refresh);
    return () => window.removeEventListener('project-flow-changed', refresh);
  }, []);
  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    const load = async () => {
      try {
        let next: ProjectFlow | null = null;
        if (runId) {
          const run = await api.getRun(runId);
          if (projectId && run.project_id !== projectId) throw new Error('运行不属于当前项目，请从项目列表重新进入。');
          next = await loadRunFlow(api, run);
        } else if (projectId) next = route.name === 'runNew' ? newProjectFlow(projectId) : await resolveProjectFlow(api, projectId);
        else if (route.params.documentId) {
          const doc = await api.getDocument(route.params.documentId);
          next = await resolveProjectFlow(api, doc.project_id);
        }
        if (disposed) return;
        setFlow(next);
        setError(null);
        setLoading(false);
        if (next) {
          setName(cachedProjectName(next.projectId));
          void lookupProjectName(api, next.projectId).then(value => { if (!disposed) setName(value); }).catch(() => {});
          if ((route.name === 'review' || route.name === 'report') && !next.available.includes(route.phase as Phase)) {
            navigate(next.destination, { replace: true });
          }
          if (next.run?.status === 'pending' || next.run?.status === 'running') timer = window.setTimeout(() => void load(), document.hidden ? 10000 : 2000);
        }
      } catch (cause) {
        if (disposed) return;
        setError(cause instanceof Error ? cause : new Error(String(cause)));
        setLoading(false);
      }
    };
    void load();
    return () => { disposed = true; window.clearTimeout(timer); };
  }, [api, projectId, runId, route.name, route.params.documentId, nonce]);
  return <Context.Provider value={{ flow, name, error, loading, refresh }}>{children}</Context.Provider>;
}

export function journeyHref(flow: ProjectFlow, step: Phase): string {
  const project = `/projects/${encodeURIComponent(flow.projectId)}`;
  const query = flow.run ? { run_id: flow.run.run_id } : undefined;
  if (step === 1) return href(project, query);
  if (step === 2) return href(`${project}/upload`, query);
  if (!flow.run) return href('/runs/new', { project_id: flow.projectId });
  const run = `/runs/${encodeURIComponent(flow.run.run_id)}`;
  if (step === 5) return href(`${run}/report`, { report_id: flow.reportId });
  return href(step === 4 ? `${run}/review` : run);
}

export function JourneyBreadcrumbs({ route }: { route: RouteMatch }) {
  const { flow, name, error, refresh, loading } = useJourney();
  return <>
    {flow ? <nav className="breadcrumbs" aria-label="面包屑">
      <a href={href('/projects')}>项目台</a><span aria-hidden="true">/</span>
      <a className="breadcrumbs__project" href={journeyHref(flow, 1)} title={name}>{name}</a>
      <span aria-hidden="true">/</span><span aria-current="page">{route.title}</span>
    </nav> : loading && route.name !== 'projects' ? <p className="micro muted" role="status">正在读取项目进度…</p> : null}
    {error ? <ErrorNotice error={error} onRetry={refresh} compact /> : null}
    {flow?.notice ? <p className="journey-notice" role="status">{flow.notice}</p> : null}
  </>;
}
