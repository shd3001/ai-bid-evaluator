/** 项目台：列项目、建项目、进项目。 */
import { useState } from "react";
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
import { href } from "../utils/router";

const PROJECT_LIMIT = 20;

export function ProjectsView() {
  const { api, mode } = useSession();
  const { push } = useToast();
  const [pageIndex, setPageIndex] = useState(0);
  const [cursors, setCursors] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  const list = useAsync(
    () => api.listProjects({ limit: PROJECT_LIMIT, cursor: cursors[pageIndex] ?? null }),
    [api, pageIndex, cursors],
  );
  const runs = useAsync(() => api.listRuns({ limit: 5 }), [api]);

  const submit = async (): Promise<void> => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      const created = await api.createProject(trimmed);
      push({ tone: "success", message: `项目已创建：${created.name}`, detail: `project_id ${created.project_id}` });
      setName("");
      list.reload();
      runs.reload();
    } catch (error) {
      push({
        tone: "danger",
        message: error instanceof ApiError ? error.message : "创建项目失败",
        detail: error instanceof ApiError ? `code ${error.code} · request_id ${error.requestId}` : undefined,
      });
    } finally {
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
            一个项目 = 一次评审的边界：材料、运行、复核与报告都挂在它下面。Project 的 ID 是不透明字符串，界面上只做展示与透传。
          </p>
        </div>
      </header>

      <div className="grid grid--aside">
        <Panel
          eyebrow="新建"
          title="建一个项目"
          description="只需一个名字。材料与投标人在下一步提交。"
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
              <a className="project-card" href={href(`/projects/${project.project_id}`)}>
                <span className="project-card__name">{project.name}</span>
                <span className="project-card__meta micro muted">
                  材料与运行都挂在这个项目下
                </span>
                <CopyId value={project.project_id} label="project_id" />
              </a>
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
