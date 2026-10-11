/** 人工复核：逐条决策，必须带当时的 revision 与幂等键。 */
import { useMemo, useState } from "react";
import { useSession, useToast } from "../app/session";
import { ApiError, type ReviewDecision, type ReviewItem } from "../api/client";
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
import { EvidenceTenonRow } from "../components/evidence";
import { Labeled, Pagination, Tabs } from "../components/layout";
import { useAsync } from "../utils/useAsync";
import { REVIEW_DECISION_LABEL, formatDateTime } from "../utils/format";
import { href } from "../utils/router";
import { clearIdempotencyKey, idempotencyKey } from "../utils/idempotency";

type DecisionKind = ReviewDecision["decision"];

const REASON_LIMIT = 2000;

const DECISIONS: Array<{ id: DecisionKind; label: string; hint: string }> = [
  { id: "confirm", label: "确认", hint: "后端给出的结论与证据都成立，直接采纳。" },
  { id: "edit", label: "修改后确认", hint: "在下方的 patch 里写入要覆盖的字段（JSON 对象）。" },
  { id: "reject", label: "拒绝", hint: "该结论不成立；需要说明理由。" },
];

interface DecisionState {
  decision: DecisionKind;
  reason: string;
  patch: string;
  patchError: string | null;
}

export function ReviewView({ runId }: { runId: string }) {
  const { api, mode } = useSession();
  const { push } = useToast();
  const [tab, setTab] = useState<"pending" | "history">("pending");
  const [pageIndex, setPageIndex] = useState(0);
  const [cursors, setCursors] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<Record<string, DecisionState>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [formError, setFormError] = useState<{ id: string; error: unknown } | null>(null);

  const list = useAsync(
    () => api.listReviews(runId, { limit: 20, cursor: cursors[pageIndex] ?? null }),
    [api, runId, pageIndex, cursors],
  );

  const items = list.data?.items ?? [];
  const pending = useMemo(() => items.filter((item) => item.kind === "pending"), [items]);
  const history = useMemo(() => items.filter((item) => item.kind === "history"), [items]);

  const draftFor = (item: ReviewItem): DecisionState =>
    drafts[item.review_id] ?? {
      decision: "confirm",
      reason: "",
      patch: JSON.stringify(item.payload, null, 2),
      patchError: null,
    };

  const updateDraft = (reviewId: string, patch: Partial<DecisionState>): void => {
    setDrafts((current) => {
      const item = items.find((candidate) => candidate.review_id === reviewId);
      const base: DecisionState = current[reviewId] ?? {
        decision: "confirm",
        reason: "",
        patch: item ? JSON.stringify(item.payload, null, 2) : "{}",
        patchError: null,
      };
      return { ...current, [reviewId]: { ...base, ...patch } };
    });
  };

  const submit = async (item: ReviewItem): Promise<void> => {
    const draft = draftFor(item);
    const reason = draft.reason.trim();
    if (!reason) {
      setFormError({ id: item.review_id, error: new Error("复核必须写明理由（reason 最长 2000 字）。") });
      return;
    }
    let parsedPatch: Record<string, unknown> | undefined;
    if (draft.decision === "edit") {
      try {
        const parsed: unknown = JSON.parse(draft.patch);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("patch 必须是一个 JSON 对象。");
        }
        parsedPatch = parsed as Record<string, unknown>;
      } catch (cause) {
        updateDraft(item.review_id, { patchError: cause instanceof Error ? cause.message : String(cause) });
        setFormError({ id: item.review_id, error: cause });
        return;
      }
    }

    const body: ReviewDecision = {
      decision: draft.decision,
      target_id: item.target_id,
      reason,
      expected_version: item.revision,
      ...(parsedPatch ? { patch: parsedPatch } : {}),
    };

    setBusyId(item.review_id);
    setFormError(null);
    const scope = `review.${runId}.${item.review_id}`;
    const key = idempotencyKey(scope, body);
    try {
      const response = await api.applyReview(runId, body, key);
      clearIdempotencyKey(scope);
      push({
        tone: "success",
        message: `已提交复核：${REVIEW_DECISION_LABEL[response.decision] ?? response.decision}`,
        detail: `review_id ${response.review_id} · 运行版本 ${response.run.revision ?? "?"}`,
      });
      list.reload();
    } catch (cause) {
      setFormError({ id: item.review_id, error: cause });
      if (cause instanceof ApiError && cause.isConflict) {
        push({
          tone: "danger",
          message: "复核冲突（409）",
          detail: "expected_version 已过期：已刷新列表，请基于最新 revision 重新提交（幂等键已更换）。",
        });
        list.reload();
      }
    } finally {
      setBusyId(null);
    }
  };

  const visible = tab === "pending" ? pending : history;

  return (
    <div className="view view--review">
      <header className="view__head">
        <div>
          <p className="micro muted">第四步</p>
          <h1 className="view__title">人工复核</h1>
          <p className="view__lead muted">
            复核是"人对后端结论的裁决"：确认、修改后确认或拒绝，并写明理由。提交必须带当次 revision，冲突时后端会拒绝而不是覆盖。
          </p>
          <CopyId value={runId} label="run_id" />
        </div>
        <div className="view__actions">
          <a className="btn btn--default" href={href(`/runs/${runId}`)}>
            回进度页
          </a>
          <a className="btn btn--primary" href={href(`/runs/${runId}/report`)}>
            看报告
          </a>
        </div>
      </header>

      <Panel
        eyebrow="队列"
        title="待复核与历史"
        description="后端把待复核项与历史记录都放在同一个列表里，用 kind 区分。"
        actions={
          <Button size="sm" variant="ghost" onClick={list.reload} busy={list.loading}>
            刷新
          </Button>
        }
      >
        <Tabs
          tabs={[
            { id: "pending", label: "待复核", badge: pending.length },
            { id: "history", label: "历史", badge: history.length },
          ]}
          active={tab}
          onChange={setTab}
        />

        {list.error ? <ErrorNotice error={list.error} onRetry={list.reload} /> : null}
        {!list.error && list.loading && !list.data ? <Skeleton rows={4} /> : null}
        {list.data && items.length === 0 ? (
          <EmptyState
            title="这个运行目前没有复核项"
            hint="待复核项出现在运行进入 awaiting_review 之后；如果运行还在 running，请回到进度页等待。"
            action={
              <a className="btn btn--default" href={href(`/runs/${runId}`)}>
                回进度页
              </a>
            }
          />
        ) : null}

        <div className="review-list">
          {visible.map((item) => {
            const draft = draftFor(item);
            const isPending = item.kind === "pending";
            return (
              <article className={`review ${isPending ? "" : "review--history"}`} key={item.review_id}>
                <header className="review__head">
                  <div>
                    <h3 className="review__title">
                      <span className="mono">{item.target_id}</span>
                      <StatusFlag tone={isPending ? "review" : "pass"}>{isPending ? "待复核" : "已处理"}</StatusFlag>
                    </h3>
                    <p className="micro muted">
                      review_id {item.review_id} · 目标 revision{" "}
                      <span className="ledger-num">{item.revision}</span>
                    </p>
                  </div>
                  <CopyId value={item.target_id} label="target_id" />
                </header>

                <Disclosure summary="后端给出的内容（payload）" defaultOpen>
                  <ReviewPayload payload={item.payload} />
                </Disclosure>

                {isPending ? (
                  <form
                    className="review__form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void submit(item);
                    }}
                  >
                    <fieldset className="fieldset">
                      <legend className="field__label">决定</legend>
                      <div className="decisions">
                        {DECISIONS.map((option) => (
                          <label
                            key={option.id}
                            className={`decision ${draft.decision === option.id ? "decision--active" : ""}`}
                          >
                            <input
                              type="radio"
                              name={`decision-${item.review_id}`}
                              checked={draft.decision === option.id}
                              onChange={() => updateDraft(item.review_id, { decision: option.id })}
                            />
                            <span className="decision__label">{option.label}</span>
                            <span className="decision__hint micro muted">{option.hint}</span>
                          </label>
                        ))}
                      </div>
                    </fieldset>

                    {draft.decision === "edit" ? (
                      <Labeled
                        label="patch（JSON 对象）"
                        required
                        hint="只写你要覆盖的字段。前端不做合并、不做校验以外的事情，最终以服务端校验为准。"
                      >
                        <textarea
                          className="input input--area mono"
                          rows={6}
                          value={draft.patch}
                          onChange={(event) => updateDraft(item.review_id, { patch: event.target.value, patchError: null })}
                          spellCheck={false}
                        />
                        {draft.patchError ? <span className="field__error">{draft.patchError}</span> : null}
                      </Labeled>
                    ) : null}

                    <Labeled label="理由 reason" required hint={`必填，最多 ${REASON_LIMIT} 字；会写进复核历史。`}>
                      <textarea
                        className="input input--area"
                        rows={3}
                        maxLength={REASON_LIMIT}
                        value={draft.reason}
                        onChange={(event) => updateDraft(item.review_id, { reason: event.target.value })}
                        placeholder="例如：报价表第 3 行与正文不一致，按正文口径确认。"
                        required
                      />
                      <span className="micro muted ledger-num">
                        {draft.reason.length}/{REASON_LIMIT}
                      </span>
                    </Labeled>

                    <div className="review__actions">
                      <Button
                        type="submit"
                        variant="primary"
                        busy={busyId === item.review_id}
                        disabled={mode === "demo"}
                      >
                        以 revision {item.revision} 提交
                      </Button>
                      <span className="micro muted">expected_version = {item.revision}</span>
                    </div>
                    {formError?.id === item.review_id ? (
                      <ErrorNotice error={formError.error} onRetry={() => setFormError(null)} retryLabel="清除" compact />
                    ) : null}
                  </form>
                ) : (
                  <p className="micro muted">历史记录只读：它是当时那次决定的留存，不能被改写。</p>
                )}
              </article>
            );
          })}
        </div>

        <Pagination
          count={items.length}
          nextCursor={list.data?.next_cursor ?? null}
          hasPrevious={pageIndex > 0}
          loading={list.loading}
          noun="条复核记录"
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

/** payload 是自由形状：这里只做"看得懂"的展示，字段结构完全按后端给的来。 */
export function ReviewPayload({ payload }: { payload: Record<string, unknown> }) {
  const entries = Object.entries(payload).slice(0, 12);
  const evidence = Array.isArray(payload["evidence"])
    ? (payload["evidence"] as Array<Record<string, unknown>>)
    : [];
  return (
    <div className="payload">
      {entries.length === 0 ? <p className="muted">payload 为空。</p> : null}
      <dl className="payload__grid">
        {entries.map(([key, value]) => (
          <div className="payload__cell" key={key}>
            <dt className="micro muted">{key}</dt>
            <dd>
              {typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? (
                <span>{String(value)}</span>
              ) : (
                <code className="mono">{JSON.stringify(value)}</code>
              )}
            </dd>
          </div>
        ))}
      </dl>
      {evidence.length > 0 ? (
        <div className="payload__evidence">
          <p className="micro muted">payload 里带 {evidence.length} 条证据引用</p>
          <EvidenceTenonRow
            refs={evidence.map((ref) => ({
              document_id: String(ref["document_id"] ?? ""),
              document_hash: String(ref["document_hash"] ?? ""),
              chunk_id: String(ref["chunk_id"] ?? ""),
              quote: String(ref["quote"] ?? ""),
              page: (ref["page"] as number | null | undefined) ?? null,
              sheet: (ref["sheet"] as string | null | undefined) ?? null,
              row_start: (ref["row_start"] as number | null | undefined) ?? null,
              row_end: (ref["row_end"] as number | null | undefined) ?? null,
              column_start: null,
              column_end: null,
            }))}
          />
        </div>
      ) : null}
      <Disclosure summary="原始 payload（只读）">
        <pre className="raw-json">{JSON.stringify(payload, null, 2)}</pre>
        <p className="micro muted">提交时间：{formatDateTime(new Date().toISOString())}（界面渲染时间，非业务时间）</p>
      </Disclosure>
    </div>
  );
}
