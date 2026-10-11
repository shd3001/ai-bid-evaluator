/** 机会雷达：发现公告不是本机检索，而是把筛选条件交给后端跑一次机会发现运行。 */
import { useMemo, useState } from "react";
import { useSession, useToast } from "../app/session";
import { ApiError, type RunCreate } from "../api/client";
import {
  Button,
  CopyId,
  Disclosure,
  EmptyState,
  ErrorNotice,
  Panel,
  Skeleton,
  StatusFlag,
} from "../components/core";
import { Labeled } from "../components/layout";
import { NoticeList, ResultView, detectNotices } from "../components/results";
import { useAsync } from "../utils/useAsync";
import { usePolling } from "../utils/usePolling";
import { isPollingStop, RUN_TYPE_LABEL, shortId } from "../utils/format";
import { clearIdempotencyKey, idempotencyKey } from "../utils/idempotency";
import { href, navigate } from "../utils/router";

interface Draft {
  queries: string;
  regions: string;
  minBudget: string;
  maxBudget: string;
  maxCandidates: number;
  companyId: string;
  companyRevision: string;
}

const EMPTY: Draft = {
  queries: "",
  regions: "",
  minBudget: "",
  maxBudget: "",
  maxCandidates: 5,
  companyId: "",
  companyRevision: "",
};

function splitList(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[,，\s\n]+/)
        .map((part) => part.trim())
        .filter(Boolean),
    ),
  );
}

export function OpportunityView({ projectId }: { projectId: string | null }) {
  const { api, mode } = useSession();
  const { push } = useToast();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [stop, setStop] = useState(false);

  const companies = useAsync(() => api.listCompanies({ limit: 50 }), [api]);

  const run = usePolling(() => (runId ? api.getRun(runId) : null), { enabled: Boolean(runId), stop });
  const current = run.data;
  if (current && isPollingStop(current) && !stop) setStop(true);

  const ready = Boolean(projectId);
  const companyRevision = draft.companyRevision.trim() && Number.isFinite(Number(draft.companyRevision))
    ? Number(draft.companyRevision)
    : null;
  const options = useMemo(
    () => ({
      queries: splitList(draft.queries),
      regions: splitList(draft.regions),
      min_budget: draft.minBudget.trim() || undefined,
      max_budget: draft.maxBudget.trim() || undefined,
      max_candidates: draft.maxCandidates,
    }),
    [draft],
  );
  /** 请求预览：project_id 未定时用占位符，仅用于展示将要发送的字段。 */
  const preview: RunCreate = useMemo(
    () => ({
      type: "opportunity_discovery",
      project_id: projectId ?? "<project_id>",
      ...(draft.companyId.trim() ? { company_id: draft.companyId.trim() } : {}),
      ...(companyRevision !== null ? { company_revision: companyRevision } : {}),
      options,
    }),
    [draft.companyId, companyRevision, options, projectId],
  );

  const submit = async (): Promise<void> => {
    if (!projectId) return;
    const body: RunCreate = { ...preview, project_id: projectId };
    setSubmitting(true);
    setError(null);
    const scope = `runs.create.opportunity.${projectId}`;
    const key = idempotencyKey(scope, body);
    try {
      const created = await api.createRun(body, key);
      clearIdempotencyKey(scope);
      setRunId(created.run_id);
      setStop(false);
      push({
        tone: "success",
        message: "机会发现运行已创建",
        detail: `run_id ${created.run_id} · 状态 ${created.status ?? "pending"}`,
      });
    } catch (cause) {
      setError(cause);
      if (cause instanceof ApiError) {
        push({ tone: "danger", message: `创建失败（${cause.status}）`, detail: cause.code ?? "见下方详情" });
      }
    } finally {
      setSubmitting(false);
    }
  };

  const results = useAsync(
    () => (runId && current && (current.status === "succeeded" || current.status === "awaiting_review") ? api.getResults(runId) : null),
    [api, runId, current?.status],
  );

  return (
    <div className="view view--opportunity">
      <header className="view__head">
        <div>
          <p className="micro muted">机会发现</p>
          <h1 className="view__title">机会雷达</h1>
          <p className="view__lead muted">
            这里只收集筛选条件，然后把它们交给后端跑一次 <span className="mono">opportunity_discovery</span>{" "}
            运行。候选、评分与是否适合都由后端给出；本页不做检索、不做排序、不做打分。
          </p>
        </div>
        {projectId ? <CopyId value={projectId} label="project_id" /> : null}
      </header>

      {!ready ? (
        <Panel eyebrow="缺少上下文" title="先选一个项目">
          <EmptyState
            title="机会发现需要一个 project_id"
            hint="从项目进入，或先建一个项目——运行必须归属于某个项目。"
            action={
              <a className="btn btn--primary" href={href("/projects")}>
                去项目列表
              </a>
            }
          />
        </Panel>
      ) : (
        <div className="page--split">
          <Panel
            eyebrow="筛选条件"
            title="发起机会发现"
            description="留空表示不限制。预算用十进制字符串，例如 1200000.00。"
          >
            <form
              className="form"
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <Labeled label="检索词 queries" hint="多个词用逗号、空格或换行分隔。">
                <textarea
                  className="input input--area"
                  rows={3}
                  value={draft.queries}
                  onChange={(event) => setDraft({ ...draft, queries: event.target.value })}
                  placeholder="例如：智慧园区 运维 平台"
                />
              </Labeled>
              <Labeled label="地区 regions" hint="同样支持多个值。">
                <input
                  className="input"
                  value={draft.regions}
                  onChange={(event) => setDraft({ ...draft, regions: event.target.value })}
                  placeholder="例如：浙江, 江苏"
                />
              </Labeled>
              <div className="form__row">
                <Labeled label="最低预算 min_budget">
                  <input
                    className="input ledger-num"
                    value={draft.minBudget}
                    onChange={(event) => setDraft({ ...draft, minBudget: event.target.value })}
                    placeholder="0.00"
                    inputMode="decimal"
                  />
                </Labeled>
                <Labeled label="最高预算 max_budget">
                  <input
                    className="input ledger-num"
                    value={draft.maxBudget}
                    onChange={(event) => setDraft({ ...draft, maxBudget: event.target.value })}
                    placeholder="5000000.00"
                    inputMode="decimal"
                  />
                </Labeled>
              </div>
              <Labeled label="候选上限 max_candidates" hint="1–100，默认 5；这是要后端返回的候选数量。">
                <input
                  className="input ledger-num"
                  type="number"
                  min={1}
                  max={100}
                  value={draft.maxCandidates}
                  onChange={(event) =>
                    setDraft({ ...draft, maxCandidates: Math.min(100, Math.max(1, Number(event.target.value) || 1)) })
                  }
                />
              </Labeled>

              <fieldset className="fieldset">
                <legend className="field__label">本企业档案（可选）</legend>
                <p className="micro muted">
                  带上 company_id 与它当时的 revision，后端会据该版本判断适配度；不填则只做公告侧发现。
                </p>
                {companies.error ? <ErrorNotice error={companies.error} onRetry={companies.reload} compact /> : null}
                {companies.loading && !companies.data ? <Skeleton rows={2} /> : null}
                {companies.data && companies.data.items.length === 0 ? (
                  <p className="muted">后端没有返回企业档案；可以手填 ID。</p>
                ) : null}
                <div className="form__row">
                  <Labeled label="company_id">
                    {companies.data && companies.data.items.length > 0 ? (
                      <select
                        className="input"
                        value={draft.companyId}
                        onChange={(event) => {
                          const picked = companies.data?.items.find((item) => item.company_id === event.target.value);
                          setDraft({
                            ...draft,
                            companyId: event.target.value,
                            companyRevision: picked?.revision ? String(picked.revision) : "",
                          });
                        }}
                      >
                        <option value="">（不使用企业档案）</option>
                        {companies.data.items.map((company) => (
                          <option key={company.company_id} value={company.company_id}>
                            {company.name} — {shortId(company.company_id, 10)}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        className="input mono"
                        value={draft.companyId}
                        onChange={(event) => setDraft({ ...draft, companyId: event.target.value })}
                        placeholder="company_id"
                      />
                    )}
                  </Labeled>
                  <Labeled label="company_revision">
                    <input
                      className="input ledger-num"
                      type="number"
                      min={1}
                      value={draft.companyRevision}
                      onChange={(event) => setDraft({ ...draft, companyRevision: event.target.value })}
                      placeholder="例如 3"
                    />
                  </Labeled>
                </div>
              </fieldset>

              {error ? <ErrorNotice error={error} onRetry={() => setError(null)} retryLabel="清除" /> : null}

              <div className="form__actions">
                <Button type="submit" variant="primary" busy={submitting} disabled={mode === "demo"}>
                  发起机会发现
                </Button>
                <Button type="button" variant="ghost" onClick={() => setDraft(EMPTY)}>
                  清空
                </Button>
                {mode === "demo" ? <span className="micro muted">离线演示模式为只读。</span> : null}
              </div>
            </form>
          </Panel>

          <aside className="aside-stack">
            <Panel eyebrow="将要提交" title="请求预览" tone="quiet">
              <pre className="raw-json">{JSON.stringify(preview, null, 2)}</pre>
              <p className="micro muted">
                POST /api/v1/runs 会带上 Idempotency-Key；同键同内容只会创建一次运行。API 不会自动启动 worker——创建后需要 worker 在跑，状态才会推进。
              </p>
            </Panel>

            {runId ? (
              <Panel
                eyebrow="本次运行"
                title="进度"
                actions={
                  <a className="btn btn--default btn--sm" href={href(`/runs/${runId}`)}>
                    打开运行页
                  </a>
                }
              >
                {run.error ? <ErrorNotice error={run.error} onRetry={run.refresh} compact /> : null}
                {current ? (
                  <>
                    <div className="flags">
                      <StatusFlag tone={current.status === "succeeded" ? "pass" : "review"}>
                        {current.status ?? "pending"}
                      </StatusFlag>
                      <StatusFlag tone="pending">{RUN_TYPE_LABEL[current.type] ?? current.type}</StatusFlag>
                      {current.result_stale ? <StatusFlag tone="fail">结果已过期</StatusFlag> : null}
                    </div>
                    <p className="micro muted">
                      run_id <span className="mono">{runId}</span> · 当前步骤 {current.current_step ?? "—"} · revision{" "}
                      <span className="ledger-num">{current.revision ?? "—"}</span>
                    </p>
                  </>
                ) : (
                  <Skeleton rows={2} />
                )}
              </Panel>
            ) : null}
          </aside>
        </div>
      )}

      {runId ? (
        <Panel
          eyebrow="后端候选"
          title="机会候选"
          description="按后端给出的 suitability / score 展示；界面不改写这些值。"
          actions={
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                results.reload();
                navigate(`/runs/${runId}`);
              }}
            >
              去运行页看完整结果
            </Button>
          }
        >
          {results.error ? <ErrorNotice error={results.error} onRetry={results.reload} /> : null}
          {results.loading && !results.data ? <Skeleton rows={4} /> : null}
          {results.data ? (
            <>
              <NoticeList notices={detectNotices(results.data.data as Record<string, unknown>)} />
              <ResultView data={results.data.data as Record<string, unknown>} />
              <Disclosure summary="证据矩阵">
                <pre className="raw-json">{JSON.stringify(results.data.evidence_matrix, null, 2)}</pre>
              </Disclosure>
            </>
          ) : null}
        </Panel>
      ) : null}
    </div>
  );
}
