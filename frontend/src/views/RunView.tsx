/** 进度页：轮询运行状态、步骤账、事件流与安全动作（重试/取消）。 */
import { useMemo, useState } from "react";
import { useSession, useToast } from "../app/session";
import { ApiError, type Run } from "../api/client";
import {
  Button,
  CopyId,
  Disclosure,
  EmptyState,
  ErrorNotice,
  Panel,
  RunStatusChip,
  Skeleton,
  StatusFlag,
  describeError,
} from "../components/core";
import { EvidenceTenonRow } from "../components/evidence";
import { usePolling, FOREGROUND_MS } from "../utils/usePolling";
import {
  RUN_TYPE_LABEL,
  formatDateTime,
  formatRelative,
  isPollingStop,
  stepLabel,
  stepProgress,
} from "../utils/format";
import { href, navigate } from "../utils/router";
import { clearIdempotencyKey, idempotencyKey } from "../utils/idempotency";

export function RunView({ runId }: { runId: string }) {
  const { api } = useSession();
  const { push } = useToast();
  const [acting, setActing] = useState<"retry" | "cancel" | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);

  const [stopPolling, setStopPolling] = useState(false);
  const polling = usePolling<Run>(() => api.getRun(runId), { enabled: true, stop: stopPolling });
  const current = polling.data;

  // 进入终态或待复核后停止自动轮询（计划 §4.1）。
  if (current && isPollingStop(current) && !stopPolling) setStopPolling(true);

  const progress = useMemo(() => (current ? stepProgress(current) : null), [current]);

  const act = async (kind: "retry" | "cancel"): Promise<void> => {
    if (!current) return;
    const version = current.revision ?? 1;
    setActing(kind);
    setActionError(null);
    const scope = `run.${kind}.${runId}.${version}`;
    const key = idempotencyKey(scope, { runId, kind, version });
    try {
      const updated = kind === "retry" ? await api.retryRun(runId, version, key) : await api.cancelRun(runId, version, key);
      clearIdempotencyKey(scope);
      push({
        tone: "success",
        message: kind === "retry" ? "已请求重试" : "已请求取消",
        detail: `状态 ${updated.status ?? "pending"} · 版本 ${updated.revision ?? version}`,
      });
      setStopPolling(false);
      polling.refresh();
    } catch (cause) {
      setActionError(cause);
      if (cause instanceof ApiError && cause.isConflict) {
        push({
          tone: "danger",
          message: "版本冲突（409）",
          detail: "运行版本已变化：已为你刷新最新状态，请确认后再操作。",
        });
        polling.refresh();
      }
    } finally {
      setActing(null);
    }
  };

  if (!current && polling.loading) {
    return (
      <div className="view view--run">
        <Skeleton rows={5} label="正在读取运行状态" />
      </div>
    );
  }

  if (!current) {
    return (
      <div className="view view--run">
        <Panel eyebrow="运行" title={`找不到运行 ${runId}`}>
          {polling.error ? <ErrorNotice error={polling.error} onRetry={polling.refresh} /> : null}
          <div className="row gap">
            <a className="btn btn--default" href={href("/projects")}>
              回项目台
            </a>
          </div>
        </Panel>
      </div>
    );
  }

  const state = current.status ?? "pending";
  const steps = current.known_steps ?? [];
  const done = new Set(current.completed_steps ?? []);
  const stale = current.result_stale === true;
  const canRetry = state === "failed" || state === "cancelled";
  const canCancel = state === "pending" || state === "running";
  const awaitingReview = state === "awaiting_review";

  return (
    <div className="view view--run">
      <header className="view__head view__head--run">
        <div>
          <p className="micro muted">{RUN_TYPE_LABEL[current.type] ?? current.type}</p>
          <h1 className="view__title">
            评审进度
            <RunStatusChip run={current} />
          </h1>
          <div className="runmeta">
            <CopyId value={current.run_id} label="run_id" />
            <CopyId value={current.project_id} label="project_id" />
          </div>
        </div>
        <div className="view__actions">
          <Button size="sm" variant="ghost" onClick={polling.refresh} busy={polling.loading}>
            立即刷新
          </Button>
          {awaitingReview ? (
            <a className="btn btn--primary" href={href(`/runs/${runId}/review`)}>
              去人工复核（{current.review_count ?? 0}）
            </a>
          ) : null}
          {state === "succeeded" ? (
            <a className="btn btn--primary" href={href(`/runs/${runId}/report`)}>
              看报告
            </a>
          ) : null}
          {canRetry ? (
            <Button variant="default" busy={acting === "retry"} onClick={() => void act("retry")}>
              以版本 {current.revision ?? 1} 重试
            </Button>
          ) : null}
          {canCancel ? (
            <Button variant="danger" busy={acting === "cancel"} onClick={() => void act("cancel")}>
              请求取消
            </Button>
          ) : null}
        </div>
      </header>

      <p className="sr-only" aria-live="polite" role="status">
        当前状态：{state}
        {current.current_step ? `，正在执行 ${stepLabel(current.current_step)}` : ""}
        {polling.failures > 0 ? `，连接抖动，已失败 ${polling.failures} 次` : ""}
      </p>

      {polling.failures > 0 ? (
        <StatusFlag tone="review">
          连接抖动：已连续 {polling.failures} 次读取失败，界面保留上一次成功的数据（
          {formatRelative(polling.lastUpdatedAt ? new Date(polling.lastUpdatedAt).toISOString() : null)}）。
          退避后会自动重试。
        </StatusFlag>
      ) : null}

      {stale ? (
        <StatusFlag tone="review">
          结果已过期（result_stale）：材料或评分在上次报告之后发生了变化。旧报告不可导出，请重新运行或重新确认。
        </StatusFlag>
      ) : null}

      {current.cancel_requested ? <StatusFlag tone="pending">已请求取消：后端会在安全边界停止。</StatusFlag> : null}

      {current.error ? (
        <div className="notice notice--compact" role="alert">
          <p className="notice__title">运行失败</p>
          <pre className="raw-json">{JSON.stringify(current.error, null, 2)}</pre>
        </div>
      ) : null}

      {actionError ? <ErrorNotice error={actionError} onRetry={() => setActionError(null)} retryLabel="清除" /> : null}

      <div className="grid grid--aside">
        <Panel
          eyebrow="步骤"
          title="执行账"
          description={
            progress?.ratio === null || progress?.ratio === undefined
              ? "后端未给出总步骤数：只显示已知的已完成步骤，不估算百分比。"
              : `已完成 ${progress.done} / 共 ${progress.total} 步（比例取自后端给出的步骤清单）。`
          }
        >
          <ol className="steplist">
            {steps.length === 0 ? (
              <li className="steplist__empty">
                <EmptyState title="后端还没有给出步骤清单" hint="运行刚提交时这是正常的：pending 状态下还没有 known_steps。" />
              </li>
            ) : null}
            {steps.map((step) => {
              const isDone = done.has(step);
              const isCurrent = step === (current.current_step ?? "");
              return (
                <li
                  key={step}
                  className={`step ${isDone ? "step--done" : ""} ${isCurrent ? "step--current" : ""}`}
                  aria-current={isCurrent ? "step" : undefined}
                >
                  <span className="step__mark" aria-hidden="true">
                    {isDone ? "✓" : isCurrent ? "▸" : "·"}
                  </span>
                  <span className="step__label">{stepLabel(step)}</span>
                  <span className="step__state micro muted">
                    {isDone ? "已完成" : isCurrent ? "进行中" : "未开始"}
                  </span>
                </li>
              );
            })}
          </ol>
          {(current.completed_steps ?? []).filter((step) => !steps.includes(step)).length > 0 ? (
            <p className="micro muted">
              另有已完成步骤未出现在 known_steps 中：
              {(current.completed_steps ?? [])
                .filter((step) => !steps.includes(step))
                .map((step) => stepLabel(step))
                .join("、")}
            </p>
          ) : null}
          <p className="micro muted">
            前台每 {FOREGROUND_MS / 1000} 秒读取一次；切到后台降为 10 秒；进入成功/失败/取消/待复核后停止自动刷新。
          </p>
        </Panel>

        <div className="stack-6">
          <Panel eyebrow="运行信息" title="状态与版本">
            <dl className="details">
              <div className="details__row">
                <dt>当前步骤</dt>
                <dd>{current.current_step ? stepLabel(current.current_step) : "—"}</dd>
              </div>
              <div className="details__row">
                <dt>版本 revision</dt>
                <dd className="ledger-num">{current.revision ?? 1}</dd>
              </div>
              <div className="details__row">
                <dt>待复核项</dt>
                <dd className="ledger-num">{current.review_count ?? 0}</dd>
              </div>
              <div className="details__row">
                <dt>创建时间</dt>
                <dd>{formatDateTime(current.created_at)}</dd>
              </div>
              <div className="details__row">
                <dt>最后更新</dt>
                <dd>{formatDateTime(current.updated_at)}</dd>
              </div>
              <div className="details__row">
                <dt>结果过期</dt>
                <dd>{stale ? "是（由后端标记）" : "否"}</dd>
              </div>
            </dl>
            <p className="micro muted">
              复核与重试都要带当时的 revision；版本冲突（409）时先刷新再操作，不要覆盖别人的决定。
            </p>
          </Panel>

          <Panel
            eyebrow="链路"
            title="下一步"
            tone="quiet"
          >
            <ul className="bullets">
              <li>awaiting_review：去复核页逐条确认，确认后运行会继续。</li>
              <li>succeeded：看报告，确认后才能导出（json / markdown / html）。</li>
              <li>failed：可带当前 revision 重试；cancelled 之后如需继续也应重新发起。</li>
            </ul>
            <div className="row gap">
              <a className="btn btn--ghost btn--sm" href={href(`/runs/${runId}/review`)}>
                复核页
              </a>
              <a className="btn btn--ghost btn--sm" href={href(`/runs/${runId}/report`)}>
                报告页
              </a>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  navigate(`/runs/${runId}`);
                }}
              >
                固定链接
              </Button>
            </div>
          </Panel>
        </div>
      </div>

      <ResultBrief runId={runId} enabled={state === "succeeded" || awaitingReview} />
    </div>
  );
}

/** 结果摘要：进入 succeeded / awaiting_review 后才拉取，避免无意义的 409/404 噪音。 */
function ResultBrief({ runId, enabled }: { runId: string; enabled: boolean }) {
  const { api } = useSession();
  const results = usePolling(
    async () => {
      try {
        return await api.getResults(runId);
      } catch (error) {
        if (error instanceof ApiError && (error.isNotFound || error.status === 409)) return null;
        throw error;
      }
    },
    { enabled, stop: true },
  );

  if (!enabled) return null;

  return (
    <Panel
      eyebrow="结果"
      title="结果与证据矩阵"
      description="只展示后端给出的结论与引用；分值、资格、stale 判定都不在这里计算。"
      actions={
        <Button size="sm" variant="ghost" onClick={results.refresh} busy={results.loading}>
          刷新
        </Button>
      }
    >
      {results.error ? <ErrorNotice error={results.error} onRetry={results.refresh} compact /> : null}
      {!results.error && results.loading && !results.data ? <Skeleton rows={3} /> : null}
      {!results.error && !results.loading && !results.data ? (
        <p className="muted">{describeError(null).title}：结果尚未生成（后端可能还在跑或该运行类型不产出结果）。</p>
      ) : null}
      {results.data ? (
        <>
          <div className="row gap wrap">
            <StatusFlag tone={results.data.confirmed ? "pass" : "review"}>
              {results.data.confirmed ? "已确认" : "未确认"}
            </StatusFlag>
            <StatusFlag tone={results.data.stale ? "review" : "pass"}>
              {results.data.stale ? "结果已过期" : "结果有效"}
            </StatusFlag>
            <span className="micro muted ledger-num">revision {results.data.revision}</span>
          </div>
          <Disclosure summary="证据矩阵（后端给出的全部引用）" count={results.data.evidence_matrix.length}>
            <EvidenceTenonRow refs={results.data.evidence_matrix} />
          </Disclosure>
        </>
      ) : null}
    </Panel>
  );
}
