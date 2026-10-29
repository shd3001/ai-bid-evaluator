/** 项目台：列项目、建项目、进项目。 */
import { useEffect, useRef, useState } from "react";
import { useSession, useToast } from "../app/session";
import {
  ApiError,
  type Project,
  type Run,
} from "../api/client";
import { Button, CopyId, EmptyState, ErrorNotice, Panel, RunStatusChip, Skeleton } from "../components/core";
import { Labeled, Pagination } from "../components/layout";
import { useAsync } from "../utils/useAsync";
import { formatRelative } from "../utils/format";
import { href, navigate } from "../utils/router";
import { rememberProject, resolveProjectFlow } from '../utils/projectFlow';

const PROJECT_LIMIT = 20;

export function ProjectsView() {
  const { api, mode } = useSession();
  const { push } = useToast();
  const [pageIndex, setPageIndex] = useState(0);
  const [cursors, setCursors] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const submitting = useRef(false);
  const [entering, setEntering] = useState<string | null>(null);
  const entryLock = useRef(false);
  const [entryError, setEntryError] = useState<{ id: string; error: unknown } | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const enterProject = async (project: Project): Promise<void> => {
    if (entryLock.current) return;
    entryLock.current = true;
    const origin = window.location.hash;
    setEntering(project.project_id);
    setEntryError(null);
    rememberProject(project);
    try {
      const flow = await resolveProjectFlow(api, project.project_id);
      if (mounted.current && window.location.hash === origin) navigate(flow.destination);
    } catch (error) {
      if (mounted.current) setEntryError({ id: project.project_id, error });
    } finally {
      entryLock.current = false;
      if (mounted.current) setEntering(null);
    }
  };

  const list = useAsync(
    () => api.listProjects({ limit: PROJECT_LIMIT, cursor: cursors[pageIndex] ?? null }),
    [api, pageIndex, cursors],
  );
  const runs = useAsync(() => api.listRuns({ limit: 5 }), [api]);

  const submit = async (): Promise<void> => {
    const trimmed = name.trim();
    if (!trimmed || submitting.current || mode === 'demo') return;
    submitting.current = true;
    setSaving(true);
    try {
      const created = await api.createProject(trimmed);
      rememberProject(created);
      push({ tone: "success", message: '项目已创建，请上传材料', detail: created.name });
      navigate(`/projects/${encodeURIComponent(created.project_id)}/upload`);
    } catch (error) {
      push({
        tone: "danger",
        message: error instanceof ApiError ? error.message : "创建项目失败",
        detail: error instanceof ApiError ? `code ${error.code} · request_id ${error.requestId}` : undefined,
      });
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  };

  return (
    <div className="view view--projects">
      <header className="view__head">
        <div>
          <p className="micro muted">第一步</p>
          <h1 className="view__title">项目台</h1>
          <p className="view__lead muted">
            创建项目后上传材料，继续运行解析、人工复核与报告导出。已有项目可从当前进度继续。
          </p>
        </div>
      </header>

      <div className="grid grid--aside">
        <Panel
          eyebrow="新建"
          title="新建评审项目"
          description="填写项目名称，创建成功后将自动进入「上传与解析」，继续提交招标公告、招标文件和投标材料。"
          as="section"
        >
          <form
            className="form"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <Labeled label="项目名称" required hint="例如：2026 年园区智能化改造（一期）">
              <input
                className="input"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="输入项目名称"
                maxLength={200}
                required
              />
            </Labeled>
            <div className="form__actions">
              <Button type="submit" variant="primary" busy={saving} disabled={mode === "demo" || !name.trim()}>
                创建项目
              </Button>
              {mode === "demo" ? <span className="micro muted">离线演示模式下不可写入</span> : null}
            </div>
          </form>
        </Panel>

        <Panel
          eyebrow="最近"
          title="最近运行"
          description="pending / running 之外的运行不会继续自动刷新。"
          actions={
            <Button size="sm" variant="ghost" onClick={() => runs.reload()} busy={runs.loading}>
              刷新
            </Button>
          }
        >
          {runs.error ? <ErrorNotice error={runs.error} onRetry={runs.reload} compact /> : null}
          {!runs.error && runs.loading && !runs.data ? <Skeleton rows={2} /> : null}
          {runs.data && runs.data.items.length === 0 ? (
            <EmptyState title="还没有运行记录" hint="提交材料后在项目详情里发起评审。" />
          ) : null}
          <ul className="runlist">
            {(runs.data?.items ?? []).map((run: Run) => (
              <li key={run.run_id}>
                <a className="runlist__item" href={href(`/runs/${run.run_id}`)}>
                  <RunStatusChip run={run} />
                  <span className="runlist__id mono">{run.run_id}</span>
                  <span className="micro muted">{formatRelative(run.created_at)}</span>
                </a>
              </li>
            ))}
          </ul>
        </Panel>
      </div>

      <Panel
        eyebrow="全部"
        title="项目"
        description="每页 20 条，游标由后端给出；不显示伪造的总数。"
        actions={
          <Button size="sm" variant="ghost" onClick={() => list.reload()} busy={list.loading}>
            刷新
          </Button>
        }
      >
        {list.error ? <ErrorNotice error={list.error} onRetry={list.reload} /> : null}
        {!list.error && list.loading && !list.data ? <Skeleton rows={4} /> : null}
        {list.data && list.data.items.length === 0 ? (
          <EmptyState title="还没有项目" hint="先在左侧创建一个项目，然后上传材料。" />
        ) : null}
        <ul className="card-list">
          {(list.data?.items ?? []).map((project: Project) => (
            <li key={project.project_id}>
              <div className="project-card">
                <a className="project-card__name" href={href(`/projects/${encodeURIComponent(project.project_id)}`)} onClick={() => rememberProject(project)}>{project.name}</a>
                <span className="project-card__meta micro muted">
                  材料与运行都挂在这个项目下
                </span>
                <CopyId value={project.project_id} label="project_id" />
                <Button variant="primary" size="sm" busy={entering === project.project_id} disabled={entering !== null} onClick={() => void enterProject(project)}>进入项目</Button>
              </div>
              {entryError?.id === project.project_id ? <ErrorNotice error={entryError.error} onRetry={() => void enterProject(project)} compact /> : null}
            </li>
          ))}
        </ul>
        <Pagination
          count={list.data?.items.length ?? 0}
          nextCursor={list.data?.next_cursor ?? null}
          hasPrevious={pageIndex > 0}
          loading={list.loading}
          noun="个项目"
          onNext={() => {
            const next = list.data?.next_cursor;
            if (!next) return;
            setCursors((current) => {
              const copy = [...current];
              copy[pageIndex + 1] = next;
              return copy;
            });
            setPageIndex((value) => value + 1);
          }}
          onPrevious={() => setPageIndex((value) => Math.max(0, value - 1))}
        />
      </Panel>
    </div>
  );
}
