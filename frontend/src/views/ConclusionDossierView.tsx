/**
 * 结论评审卷（dossier）——「已确认的结论」这一屏。
 *
 * 设计来源：`<project>/.design-studio/lock.json` 冻结的 variant `a-dossier`（卷宗 · 纸质档案），
 * 样式全部落位在 `styles/dossier.css` 的 --dz-* 变量上，本文件不出现任何裸色值。
 *
 * 业务硬约束（与 api/client.ts 一致，见 docs/DESIGN.md §9）：
 * 1) 本文件不做任何业务计算——分值、资格、排名、版本、stale、待决项全部来自后端；
 * 2) 台账只呈现「哪个键装着哪类东西」，认不出来就退回原文折叠，不补造引用或数字；
 * 3) 三态（通过 / 待复核 / 不通过）只在后端给出 status 时才着色，缺失一律按待复核呈现；
 * 4) 复核提交必须带 reason 与 expected_version，冲突由后端 409 决定，前端不覆盖。
 */
import { useMemo, useState } from "react";
import { useSession, useToast } from "../app/session";
import {
  ApiError,
  type EvaluationResponse,
  type EvidenceRef,
  type Project,
  type QualificationResult,
  type ReviewDecision,
  type ReviewItem,
  type Run,
  type ScoreItem,
  type ScoreResult,
} from "../api/client";
import { useEvidenceFocus } from "../components/evidence";
import { useAsync } from "../utils/useAsync";
import {
  REVIEW_DECISION_LABEL,
  RUN_TYPE_LABEL,
  evidenceLocator,
  formatDateTime,
  groupDecimal,
  runStatusLabel,
  shortId,
  stepLabel,
} from "../utils/format";
import { href } from "../utils/router";
import { clearIdempotencyKey, idempotencyKey } from "../utils/idempotency";
import "../styles/dossier.css";

type Tone = "pass" | "review" | "fail";
type DecisionKind = Extract<ReviewDecision["decision"], "confirm" | "reject">;

const REASON_LIMIT = 2000;
const QUOTE_LIMIT = 6;

/* ────────────────────────── 形状识别（只认键，不做业务判断） ── */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasKeys(value: unknown, keys: string[]): boolean {
  return isRecord(value) && keys.some((key) => key in value);
}

function pickList<T>(data: Record<string, unknown>, keys: string[], guard: (item: unknown) => boolean): T[] {
  for (const key of keys) {
    const value = data[key];
    if (Array.isArray(value)) return value.filter(guard) as T[];
  }
  return [];
}

/** 后端给的分值都是字符串；只判断「是不是一个可显示的数」。 */
function isNumericText(value: string | null | undefined): boolean {
  if (typeof value !== "string" || value.trim() === "") return false;
  const parsed = Number(value);
  return Number.isFinite(parsed);
}

/**
 * 待决项里是否提到这个 rule_id。
 * 只用于高亮，不参与任何判断；payload 结构不保证，所以整体兜住异常。
 */
function payloadMentions(item: ReviewItem | null, needle: string): boolean {
  if (!item || !needle) return false;
  try {
    return JSON.stringify(item.payload ?? {}).includes(needle);
  } catch {
    return false;
  }
}

/** 待决项里后端自己写的说明：按可能的键名找第一段非空文本，找不到就退回通用句。 */
function whyOf(item: ReviewItem): string {
  const payload = item.payload ?? {};
  const candidates = ["summary", "title", "message", "reason", "question", "detail", "description", "note"];
  for (const key of candidates) {
    const value = payload[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return `后端把 ${item.target_id} 交回人工裁决，payload 里没有可读的说明文本。`;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/* ────────────────────────── 呈现映射（不产生新结论） ── */

const QUALIFICATION_TONE: Record<string, Tone> = {
  passed: "pass",
  failed: "fail",
  needs_review: "review",
};

const QUALIFICATION_TEXT: Record<string, string> = {
  passed: "资格通过",
  failed: "资格不通过",
  needs_review: "资格待复核",
};

const CHECK_TONE: Record<string, Tone> = {
  passed: "pass",
  failed: "fail",
  needs_review: "review",
};

const CHECK_TEXT: Record<string, string> = {
  passed: "通过",
  failed: "不通过",
  needs_review: "待复核",
};

/** 从资格结果里找同名检查项的状态；schema 不保证有 rule_id，所以按 unknown 读。 */
function checkStatusOf(qual: QualificationResult | undefined, ruleId: string): string | null {
  const raw: unknown = qual?.checks;
  if (!Array.isArray(raw)) return null;
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const id = entry["rule_id"];
    const status = entry["status"];
    if (typeof id === "string" && id === ruleId && typeof status === "string") return status;
  }
  return null;
}

interface LedgerRow {
  key: string;
  index: string;
  ruleId: string;
  max: string | null;
  value: string | null;
  tone: Tone;
  label: string;
}

function rowsOf(items: ScoreItem[], qual: QualificationResult | undefined, active: ReviewItem | null): LedgerRow[] {
  return items.map((item, position) => {
    const checkStatus = checkStatusOf(qual, item.rule_id);
    let tone: Tone = "review";
    let label = "待复核";

    if (checkStatus && CHECK_TEXT[checkStatus]) {
      tone = CHECK_TONE[checkStatus];
      label = CHECK_TEXT[checkStatus];
    } else if (payloadMentions(active, item.rule_id)) {
      tone = "review";
      label = "待复核";
    } else if (isNumericText(item.score)) {
      tone = "pass";
      label = "通过";
    } else {
      tone = "review";
      label = "未取到分值";
    }

    return {
      key: item.rule_id || `item-${position}`,
      index: String(position + 1).padStart(2, "0"),
      ruleId: item.rule_id || `#${position + 1}`,
      max: item.max_score ?? null,
      value: isNumericText(item.score) ? item.score : null,
      tone,
      label,
    };
  });
}

/* ────────────────────────── 数据装载 ── */

interface Bundle {
  run: Run;
  results: EvaluationResponse;
  reviews: ReviewItem[];
  project: Project | null;
  loadedAt: string;
}

export function ConclusionDossierView({ runId }: { runId: string }) {
  const { api, mode } = useSession();
  const { push } = useToast();
  const { setFocus } = useEvidenceFocus();

  const [bidderId, setBidderId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<unknown>(null);

  const bundle = useAsync<Bundle>(async () => {
    const [run, results, reviews, projects] = await Promise.all([
      api.getRun(runId),
      api.getResults(runId),
      api.listReviews(runId, { limit: 50 }),
      api.listProjects({ limit: 100 }),
    ]);
    return {
      run,
      results,
      reviews: reviews.items,
      project: projects.items.find((item) => item.project_id === run.project_id) ?? null,
      loadedAt: new Date().toISOString(),
    };
  }, [api, runId]);

  const data = bundle.data;
  const results = data?.results ?? null;

  const scores = useMemo(
    () =>
      results
        ? pickList<ScoreResult>(results.data, ["scores", "score_results"], (item) => hasKeys(item, ["total_score", "items"]))
        : [],
    [results],
  );
  const qualifications = useMemo(
    () =>
      results
        ? pickList<QualificationResult>(results.data, ["qualifications", "qualification_results"], (item) =>
            hasKeys(item, ["bidder_id"]),
          )
        : [],
    [results],
  );

  const pending = useMemo(() => (data?.reviews ?? []).filter((item) => item.kind === "pending"), [data]);
  const history = useMemo(() => (data?.reviews ?? []).filter((item) => item.kind === "history"), [data]);

  /** 未选中时落在后端顺序的第一条投标人 / 第一条待决项。 */
  const selected = useMemo(
    () => scores.find((item) => item.bidder_id === bidderId) ?? scores[0] ?? null,
    [scores, bidderId],
  );
  const active = useMemo(
    () => pending.find((item) => item.review_id === selectedId) ?? pending[0] ?? null,
    [pending, selectedId],
  );

  const items = useMemo(() => selected?.items ?? [], [selected]);
  const qual = useMemo(
    () => qualifications.find((item) => item.bidder_id === (selected?.bidder_id ?? "")),
    [qualifications, selected],
  );
  const rows = useMemo(() => rowsOf(items, qual, active), [items, qual, active]);

  const matrix = results?.evidence_matrix ?? [];
  const quotes = matrix.slice(0, QUOTE_LIMIT);
  const quotesHidden = Math.max(0, matrix.length - quotes.length);

  async function decide(item: ReviewItem, decision: DecisionKind): Promise<void> {
    const text = reason.trim();
    if (!text) {
      setFormError(new Error("复核必须写明理由（reason 必填，最长 2000 字）。"));
      return;
    }
    const body: ReviewDecision = {
      decision,
      target_id: item.target_id,
      reason: text,
      expected_version: item.revision,
    };
    const scope = `dossier.${runId}.${item.review_id}.${decision}`;
    const key = idempotencyKey(scope, body);
    setBusy(true);
    setFormError(null);
    try {
      const response = await api.applyReview(runId, body, key);
      clearIdempotencyKey(scope);
      push({
        tone: "success",
        message: `已提交：${REVIEW_DECISION_LABEL[response.decision] ?? response.decision}`,
        detail: `target ${response.target_id} · 运行版本 ${response.run.revision ?? "?"}`,
      });
      setReason("");
      setSelectedId(null);
      bundle.reload();
    } catch (cause) {
      setFormError(cause);
      if (cause instanceof ApiError && cause.isConflict) {
        push({
          tone: "danger",
          message: "复核冲突（409）",
          detail: "expected_version 已过期：已重新拉取最新 revision，请基于新版本再提交。",
        });
        setSelectedId(null);
        bundle.reload();
      }
    } finally {
      setBusy(false);
    }
  }

  const readOnly = mode === "demo";
  const run = data?.run ?? null;
  const typeLabel = run ? RUN_TYPE_LABEL[run.type] ?? run.type : "评审";
  const steps = run && Array.isArray(run.known_steps) ? run.known_steps.filter((step): step is string => typeof step === "string") : [];
  const bidderCount = scores.length || qualifications.length;
  const maxOfItems = selected?.max_total_score ?? null;

  return (
    <div className="dz-page">
      <div className="dz-wrap">
        <header className="dz-cover">
          <div>
            <div className="dz-no">
              case file · 卷宗编号 {run ? shortId(run.run_id, 12) : shortId(runId, 12)}
              {run ? ` · revision ${run.revision}` : ""}
            </div>
            <h1 className="dz-h1">
              {data?.project?.name ?? `${typeLabel}卷`}
              <br />
              辅助评审卷
            </h1>
            <div className="dz-sub">
              {typeLabel} · 资格三态 · 全证据留痕
              {run ? (
                <>
                  {" "}&nbsp;|&nbsp; 复核 {run.review_count ?? 0} 次 &nbsp;|&nbsp; 出具{" "}
                  {formatDateTime(run.created_at)}
                </>
              ) : (
                <> &nbsp;|&nbsp; 正在读取后端卷宗</>
              )}
            </div>
          </div>
          <div className="dz-stamp">{run ? runStatusLabel(run) : "读取中"}</div>
        </header>

        <dl className="dz-meta">
          <div>
            <dt>run_id</dt>
            <dd className="mono">{run?.run_id ?? runId}</dd>
          </div>
          <div>
            <dt>投标人</dt>
            <dd>{bidderCount > 0 ? `${bidderCount} 家` : "—"}</dd>
          </div>
          <div>
            <dt>评分项</dt>
            <dd>
              {items.length > 0 ? `${items.length} 项` : "—"}
              {maxOfItems ? ` · ${groupDecimal(maxOfItems)} 分制` : ""}
            </dd>
          </div>
          <div>
            <dt>检查点</dt>
            <dd>
              {steps.length > 0
                ? steps.map((step, position) => (
                    <span key={step}>
                      {position > 0 ? " → " : ""}
                      {step === run?.current_step ? <b>{stepLabel(step)}</b> : stepLabel(step)}
                    </span>
                  ))
                : stepLabel(run?.current_step)}
            </dd>
          </div>
        </dl>

        {bundle.error ? (
          <div className="dz-empty" style={{ marginTop: 32 }}>
            读不到这个运行的结论
            <span>{messageOf(bundle.error)}</span>
          </div>
        ) : !data || !run ? (
          <div className="dz-empty" style={{ marginTop: 32 }}>
            正在读取后端结论
            <span>loading · run {shortId(runId, 12)}</span>
          </div>
        ) : (
          <div className="dz-body">
            <main className="dz-main">
              <div className="dz-block">
                <h2 className="dz-sec">
                  <span className="dz-idx">01</span>
                  评分台账
                  <span className="dz-rule" />
                </h2>
                <p className="dz-secnote">
                  分值与排名由程序生成，模型不得改写 ID、分值、资格与推荐。▲ 标记表示需要人工复核；缺失的分项显示 —，
                  不做推测。
                </p>

                {scores.length > 1 ? (
                  <div className="dz-bidders" role="tablist" aria-label="投标人">
                    {scores.map((score) => {
                      const bidderQual = qualifications.find((item) => item.bidder_id === score.bidder_id);
                      const isActive = score.bidder_id === selected?.bidder_id;
                      return (
                        <button
                          key={score.bidder_id}
                          type="button"
                          role="tab"
                          aria-selected={isActive}
                          className="dz-bidder"
                          data-active={isActive ? "true" : "false"}
                          onClick={() => {
                            setBidderId(score.bidder_id);
                            setReason("");
                            setFormError(null);
                          }}
                        >
                          {bidderQual?.bidder_name || shortId(score.bidder_id, 10)}
                          <small>{shortId(score.bidder_id, 12)}</small>
                        </button>
                      );
                    })}
                  </div>
                ) : null}

                <p className="dz-hint">
                  <span className="dz-status" data-v={qual ? QUALIFICATION_TONE[qual.status ?? ""] ?? "review" : "review"}>
                    资格 {QUALIFICATION_TEXT[qual?.status ?? ""] ?? "后端未给资格状态"}
                  </span>
                  {qual ? ` · 检查项 ${Array.isArray(qual.checks) ? qual.checks.length : 0} 项` : ""}
                  {selected?.reference_only === true ? " · 参考评分（未进有效集合）" : ""}
                  {selected?.valid === false ? " · 后端标为无效" : ""}
                </p>

                {rows.length > 0 ? (
                  <div className="dz-ledger">
                    {rows.map((row) => (
                      <div className="dz-row" key={row.key} data-v={row.tone}>
                        <span className="n">{row.index}</span>
                        <span className="t">
                          <span className="name">{row.ruleId}</span>
                          <span className="leader" />
                        </span>
                        <span className="w">{row.max ? `满分 ${groupDecimal(row.max)}` : "满分 —"}</span>
                        <span className="v">
                          {row.value !== null ? (
                            <>
                              {groupDecimal(row.value)} <small>分</small>
                            </>
                          ) : (
                            "—"
                          )}
                        </span>
                        <span className="s">{row.label}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="dz-empty">
                    后端结果里没有识别到评分结构
                    <span>no score items · 已按原样收在下方的后端原始结果里</span>
                  </div>
                )}

                {selected ? (
                  <div className="dz-total">
                    <span className="k">后端合计</span>
                    <span className="v">
                      {isNumericText(selected.total_score) ? groupDecimal(selected.total_score) : "—"}
                      {maxOfItems ? <span> / {groupDecimal(maxOfItems)}</span> : null}
                    </span>
                  </div>
                ) : null}
                <p className="dz-totalnote">
                  {rows.filter((row) => row.tone === "review").length} 项待复核 · 合计口径以后端为准
                  {selected?.errors && selected.errors.length > 0 ? ` · ${selected.errors.length} 条后端错误标记` : ""}
                </p>
              </div>

              <div className="dz-block">
                <h2 className="dz-sec">
                  <span className="dz-idx">02</span>
                  待你决定
                  <span className="dz-rule" />
                </h2>
                <p className="dz-secnote">
                  人工检查点确认之后结论才生效。这里只提交裁决与理由，都会写进复核历史（历史 {history.length} 条）。
                </p>

                <div className="dz-todo">
                  <header>
                    <b>复核检查点 · {active?.target_id ?? stepLabel(run.current_step)}</b>
                    <span className="dz-cnt" data-tone={pending.length > 0 ? "review" : "clear"}>
                      {pending.length > 0 ? `${pending.length} 项待处理` : "无待决项"}
                    </span>
                  </header>

                  {pending.length > 0 ? (
                    <ol>
                      {pending.map((item) => {
                        const isActive = item.review_id === active?.review_id;
                        return (
                          <li key={item.review_id} data-active={isActive ? "true" : "false"}>
                            <span className="dz-why">
                              {whyOf(item)}
                              <small>
                                target {item.target_id} · revision {item.revision} · {item.review_id}
                              </small>
                            </span>
                            <button
                              type="button"
                              className="dz-act"
                              aria-pressed={isActive}
                              onClick={() => {
                                setSelectedId(item.review_id);
                                setReason("");
                                setFormError(null);
                              }}
                            >
                              <u>{isActive ? "正在裁决" : "裁决这一项"}</u>
                            </button>
                          </li>
                        );
                      })}
                    </ol>
                  ) : (
                    <div className="dz-empty" style={{ margin: 0, border: 0, background: "transparent" }}>
                      本卷没有待你决定的检查点
                      <span>no pending checkpoints · 结论已由复核确认</span>
                    </div>
                  )}

                  {pending.length > 0 ? (
                    <div className="dz-form">
                      <label className="dz-hint" htmlFor="dz-reason">
                        理由 reason（必填 · 会写进复核历史）
                      </label>
                      <textarea
                        id="dz-reason"
                        className="dz-reason"
                        rows={3}
                        maxLength={REASON_LIMIT}
                        value={reason}
                        disabled={readOnly || !active}
                        onChange={(event) => setReason(event.target.value)}
                        placeholder={
                          active
                            ? `例如：${active.target_id} 的结论与原文一致，按原结论确认。`
                            : "当前没有待复核项"
                        }
                      />
                      {formError ? (
                        <p className="dz-hint" data-tone="error">
                          {messageOf(formError)}
                        </p>
                      ) : null}
                      <div className="dz-actions">
                        <button
                          type="button"
                          className="dz-btn"
                          disabled={readOnly || busy || !active}
                          onClick={() => {
                            if (active) void decide(active, "confirm");
                          }}
                        >
                          {busy ? "提交中…" : "确认"}
                        </button>
                        <button
                          type="button"
                          className="dz-btn ghost"
                          disabled={readOnly || busy || !active}
                          onClick={() => {
                            if (active) void decide(active, "reject");
                          }}
                        >
                          驳回
                        </button>
                      </div>
                      <p className="dz-hint">
                        {readOnly
                          ? "离线演示数据为只读：要真正提交复核，请切到真实后端。"
                          : active
                            ? `expected_version = ${active.revision} · 冲突时后端拒绝而不是覆盖`
                            : "没有待复核项，提交按钮不可用。"}
                      </p>
                    </div>
                  ) : null}
                </div>
              </div>

              <details className="dz-fold">
                <summary>后端原始结果（只读）</summary>
                <pre className="dz-raw">{JSON.stringify(results?.data ?? {}, null, 2)}</pre>
              </details>

              <div className="dz-tools">
                <a href={href(`/runs/${runId}`)}>回进度页</a>
                <a href={href(`/runs/${runId}/review`)}>人工复核台</a>
                <a href={href(`/runs/${runId}/report`)}>评审报告</a>
              </div>
            </main>

            <aside className="dz-rail">
              <h3>证据 · evidence</h3>

              {quotes.length > 0 ? (
                quotes.map((ref: EvidenceRef, index) => (
                  <article className="dz-ev" key={`${ref.document_id}-${ref.chunk_id}-${index}`}>
                    <div className="hd">
                      <span className="id">E-{String(index + 1).padStart(4, "0")}</span>
                      <span className="lock">hash {shortId(ref.document_hash)}</span>
                    </div>
                    <div className="bd">
                      <dl>
                        <dt>文本块</dt>
                        <dd>{ref.chunk_id ? shortId(ref.chunk_id) : "—"}</dd>
                        <dt>定位</dt>
                        <dd>{evidenceLocator(ref) || "后端未给定位"}</dd>
                        <dt>文档</dt>
                        <dd>{shortId(ref.document_id)}</dd>
                      </dl>
                      <blockquote>
                        {ref.quote}
                        <cite>
                          hash {shortId(ref.document_hash)}
                          {evidenceLocator(ref) ? ` · ${evidenceLocator(ref)}` : ""}{" "}
                          <button
                            type="button"
                            className="dz-link"
                            onClick={() => setFocus({ ref, label: `证据 ${index + 1} · ${ref.document_id}` })}
                          >
                            查看原文
                          </button>
                        </cite>
                      </blockquote>
                    </div>
                  </article>
                ))
              ) : (
                <div className="dz-empty">
                  这次运行没有返回证据引用
                  <span>no evidence matrix · 界面上不补造引用</span>
                </div>
              )}

              <div className="dz-chain">
                证据链完整性
                <br />
                引用 {matrix.length} 条 · 展示 {quotes.length} 条
                {quotesHidden > 0 ? `（另 ${quotesHidden} 条见复核台）` : ""}
                <br />
                {matrix.length > 0 && matrix.every((ref) => typeof ref.document_hash === "string" && ref.document_hash !== "") ? (
                  <>
                    全部引用均带文档哈希 <b>✔ 可回溯</b>
                  </>
                ) : (
                  <>存在未带哈希的引用</>
                )}
              </div>
            </aside>
          </div>
        )}

        <footer className="dz-foot">
          <span>
            run {shortId(runId, 12)} · revision {results?.revision ?? "?"}
          </span>
          <span>
            结论须经复核确认方生效 · {readOnly ? "离线演示数据（只读）" : "真实后端"}
            {data ? ` · 载入于 ${formatDateTime(data.loadedAt)}` : ""}
          </span>
        </footer>
      </div>
    </div>
  );
}