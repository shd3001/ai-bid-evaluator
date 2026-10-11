import type { components } from "../api/schema";

type Run = components["schemas"]["RunResponse"];
type DocumentResponse = components["schemas"]["DocumentResponse"];
type Notice = components["schemas"]["TenderNotice"];

export type Verdict = "passed" | "failed" | "needs_review";

/* ---------- 时间：后端给带时区 ISO 8601，这里只做本地化展示，不改数值 ---------- */

const dateTime = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const dateOnly = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });

export function parseTime(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function formatDateTime(value: string | null | undefined): string {
  const parsed = parseTime(value);
  return parsed ? dateTime.format(parsed) : "—";
}

export function formatDate(value: string | null | undefined): string {
  const parsed = parseTime(value);
  return parsed ? dateOnly.format(parsed) : "—";
}

/** 相对时间；超过 7 天回落到绝对时间。 */
export function formatRelative(value: string | null | undefined, now: Date = new Date()): string {
  const parsed = parseTime(value);
  if (!parsed) return "—";
  const seconds = Math.round((now.getTime() - parsed.getTime()) / 1000);
  if (seconds < 0) return `还有 ${humanDuration(-seconds)}`;
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  if (seconds < 7 * 86400) return `${Math.floor(seconds / 86400)} 天前`;
  return dateTime.format(parsed);
}

export function humanDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} 秒`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)} 小时`;
  return `${(seconds / 86400).toFixed(1)} 天`;
}

/* ---------- 数值：后端给十进制字符串，原样分组显示，绝不重算 ---------- */

/** 把 "1234567.50" 显示为 "1,234,567.50"，不改变精度、不做数值运算。 */
export function groupDecimal(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const match = /^(-?)(\d+)(\.\d+)?$/.exec(value.trim());
  if (!match) return value;
  const [, sign = "", intPart = "", frac = ""] = match;
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}${grouped}${frac}`;
}

export function scoreText(value: string | null | undefined, max?: string | null): string {
  const score = groupDecimal(value);
  return max ? `${score} / ${groupDecimal(max)}` : score;
}

/** 进度：只知道已完成/已知步骤时给"3/7"，未知总数时返回 null（不得造百分比）。 */
export function stepProgress(run: Pick<Run, "completed_steps" | "known_steps">): {
  done: number;
  total: number | null;
  ratio: number | null;
} {
  const done = run.completed_steps?.length ?? 0;
  const total = run.known_steps?.length ?? 0;
  if (total <= 0) return { done, total: null, ratio: null };
  return { done, total, ratio: Math.min(1, done / total) };
}

/* ---------- 枚举 → 中文标签（展示层唯一翻译处） ---------- */

export const RUN_STATUS_LABEL: Record<string, string> = {
  pending: "排队中",
  running: "执行中",
  awaiting_review: "等待人工复核",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
  stale: "结果已过期",
};

export function runStatusLabel(run: Pick<Run, "status" | "result_stale">): string {
  if (run.result_stale) return RUN_STATUS_LABEL.stale;
  return RUN_STATUS_LABEL[run.status ?? "pending"];
}

/** 终态 / 等待复核：按契约停止自动轮询。 */
export function isPollingStop(run: Pick<Run, "status">): boolean {
  return ["succeeded", "failed", "cancelled", "awaiting_review"].includes(run.status ?? "pending");
}

export function isTerminal(run: Pick<Run, "status">): boolean {
  return ["succeeded", "failed", "cancelled"].includes(run.status ?? "pending");
}

export const VERDICT_LABEL: Record<Verdict, string> = {
  passed: "通过",
  failed: "不通过",
  needs_review: "待复核",
};

export const CHECK_STATUS: Record<string, { label: string; verdict: Verdict }> = {
  passed: { label: "通过", verdict: "passed" },
  failed: { label: "不通过", verdict: "failed" },
  needs_review: { label: "待复核", verdict: "needs_review" },
};

export const ASSESSMENT_STATUS: Record<string, { label: string; verdict: Verdict | "pending" }> = {
  suitable: { label: "适合投标", verdict: "passed" },
  unsuitable: { label: "不适合投标", verdict: "failed" },
  needs_review: { label: "待复核", verdict: "needs_review" },
};

export const DOCUMENT_ROLE_LABEL: Record<DocumentResponse["role"], string> = {
  announcement: "公告",
  tender: "招标文件",
  bid: "投标文件",
  profile: "企业画像材料",
};

export const DOCUMENT_STATUS: Record<DocumentResponse["status"], { label: string; verdict: Verdict | "pending" }> = {
  ready: { label: "已解析", verdict: "passed" },
  needs_review: { label: "需人工核对", verdict: "needs_review" },
  failed: { label: "解析失败", verdict: "failed" },
};

export const NOTICE_TYPE_LABEL: Record<NonNullable<Notice["notice_type"]>, string> = {
  tender: "招标公告",
  award: "中标/成交",
  correction: "更正公告",
  termination: "终止公告",
  unknown: "类型未知",
};

export const RUN_TYPE_LABEL: Record<string, string> = {
  bid_evaluation: "投标评审",
  opportunity_discovery: "机会发现",
};

export const REVIEW_DECISION_LABEL: Record<string, string> = {
  confirm: "确认",
  edit: "修改后确认",
  reject: "拒绝",
};

/** 只按后端给出的 status 字符串翻译，未知/缺失一律回落到"待复核"。 */
export function checkStatus(check: { status?: string | null }): { label: string; verdict: Verdict } {
  const entry = CHECK_STATUS[check.status ?? "needs_review"];
  return entry ?? CHECK_STATUS.needs_review!;
}

export function assessmentStatus(assessment: {
  status?: string | null;
}): { label: string; verdict: Verdict | "pending" } {
  const entry = ASSESSMENT_STATUS[assessment.status ?? "needs_review"];
  return entry ?? ASSESSMENT_STATUS.needs_review!;
}

/* ---------- 证据定位：按后端的结构化字段展示，不推断、不用文件名 ---------- */

export type EvidenceRef = components["schemas"]["EvidenceRef"];

/** 人类可读的定位符，例如 "第 12 页" / "表3 第5–9行" / "块 ab12cd"。 */
export function evidenceLocator(ref: Pick<EvidenceRef, "page" | "sheet" | "row_start" | "row_end" | "chunk_id">): string {
  if (ref.page !== null && ref.page !== undefined) return `第 ${ref.page} 页`;
  if (ref.sheet) {
    const rows =
      ref.row_start !== null && ref.row_start !== undefined
        ? ref.row_end && ref.row_end !== ref.row_start
          ? ` 第 ${ref.row_start}–${ref.row_end} 行`
          : ` 第 ${ref.row_start} 行`
        : "";
    return `${ref.sheet}${rows}`;
  }
  return `块 ${ref.chunk_id.slice(0, 8)}`;
}

export function shortId(id: string, keep = 8): string {
  if (id.length <= keep + 1) return id;
  return `${id.slice(0, keep)}…`;
}

export function quotePreview(quote: string, length = 22): string {
  const flat = quote.replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length)}…` : flat;
}

/** 空值与空数组的统一判断，用于决定是否渲染"证据不足"缺口。 */
export function hasEvidence(value: { evidence?: EvidenceRef[] } | null | undefined): boolean {
  return Boolean(value?.evidence && value.evidence.length > 0);
}

/** steps 显示中文名，未知步骤原样回显（后端是唯一事实来源）。 */
export const STEP_LABEL: Record<string, string> = {
  ingest: "材料解析",
  extract: "条款抽取",
  assess: "逐项评估",
  profile: "画像提取",
  search: "公告检索",
  screen: "资格粗筛",
  evaluate: "机会评估",
  report: "报告生成",
  score: "评分汇总",
  verify: "证据核对",
};

export function stepLabel(step: string | null | undefined): string {
  if (!step) return "—";
  return STEP_LABEL[step] ?? step;
}
