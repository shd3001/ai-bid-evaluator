/**
 * 离线演示数据源。
 *
 * 夹具由 `scripts/export_frontend_fixtures.py` 在本地 fake 模型/搜索、无网络条件下，
 * 通过真实 HTTP 接口导出后原样落盘（见 `frontend/src/demo/fixtures/README.md`）。
 * 这里只做「路径 → 夹具」的映射与分页切片，**不重算任何业务字段**：
 * 分值、资格、排名、报告版本与 stale 全部照抄夹具里后端给出的值。
 */
import type { DemoResolver } from "./client";

/* ------------------------------------------------------------------ */
/* 夹具结构（只声明本文件用到的字段，其余原样透传）                     */
/* ------------------------------------------------------------------ */

interface IndexRow {
  [key: string]: unknown;
}

interface IndexFile {
  generated_at?: string;
  source?: string;
  notice?: string;
  projects?: IndexRow[];
  bidders?: IndexRow[];
  documents?: IndexRow[];
  runs?: IndexRow[];
  reports?: IndexRow[];
  companies?: IndexRow[];
  gaps?: unknown[];
  statistics?: Record<string, unknown>;
}

interface RunFile {
  run?: IndexRow;
  events?: IndexRow[];
  results?: unknown;
  reviews?: IndexRow[];
  reports?: IndexRow[];
  report_details?: Record<string, unknown>;
}

interface DocumentFile {
  document?: IndexRow;
  chunks?: IndexRow[];
}

/* ------------------------------------------------------------------ */
/* 读取夹具                                                            */
/* ------------------------------------------------------------------ */

const INDEX_RAW = import.meta.glob("../demo/fixtures/index.json", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

const RUN_RAW = import.meta.glob("../demo/fixtures/runs/*.json", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

const DOC_RAW = import.meta.glob("../demo/fixtures/documents/*.json", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

function parseAll<T>(modules: Record<string, string>): Map<string, T> {
  const out = new Map<string, T>();
  for (const [path, raw] of Object.entries(modules)) {
    const base = path.split("/").pop() ?? path;
    const name = base.replace(/\.json$/, "");
    try {
      out.set(name, JSON.parse(raw) as T);
    } catch {
      // 单个夹具损坏不应让整个演示模式崩掉：跳过它，缺数据时由上层 404 提示。
    }
  }
  return out;
}

const indexFile = (() => {
  const first = Object.values(INDEX_RAW)[0];
  return first ? (JSON.parse(first) as IndexFile) : ({} as IndexFile);
})();

const runFiles = parseAll<RunFile>(RUN_RAW);
const documentFiles = parseAll<DocumentFile>(DOC_RAW);

/* ------------------------------------------------------------------ */
/* 分页                                                                */
/* ------------------------------------------------------------------ */

function asRows(value: unknown): IndexRow[] {
  return Array.isArray(value) ? (value as IndexRow[]) : [];
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * 稳定游标：`<offset>`（真实后端用的是不透明字符串，前端只当令牌透传）。
 * 夹具数据量小，一次返回全部；limit 生效时按游标切片。
 */
function paginate(rows: IndexRow[], query: URLSearchParams): { items: IndexRow[]; next_cursor: string | null } {
  const rawLimit = Number(query.get("limit"));
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 100) : 20;
  const rawCursor = query.get("cursor");
  const parsed = rawCursor === null ? 0 : Number(rawCursor);
  const offset = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
  const slice = rows.slice(offset, offset + limit);
  const next = offset + slice.length;
  return { items: slice, next_cursor: next < rows.length ? String(next) : null };
}

/* ------------------------------------------------------------------ */
/* 索引                                                                */
/* ------------------------------------------------------------------ */

const projectIndex = asRows(indexFile.projects);
const bidderIndex = asRows(indexFile.bidders);
const documentIndex = new Map<string, IndexRow>(
  asRows(indexFile.documents).map((row) => [textOf(row.document_id), row]),
);
const runIndex = new Map<string, IndexRow>(asRows(indexFile.runs).map((row) => [textOf(row.run_id), row]));
const reportIndex = new Map<string, IndexRow>(
  asRows(indexFile.reports).map((row) => [textOf(row.report_id), row]),
);
const companyIndex = asRows(indexFile.companies);

function runFileOf(runId: string): RunFile | undefined {
  return runFiles.get(runId);
}

function reportOf(reportId: string): IndexRow | null {
  for (const file of runFiles.values()) {
    const details = file.report_details?.[reportId];
    if (details) return details as IndexRow;
    const hit = asRows(file.reports).find((row) => textOf(row.report_id) === reportId);
    if (hit) return hit;
  }
  return reportIndex.get(reportId) ?? null;
}

/** 由真实接口形态的错误体构造 404，交给 client.ts 统一转成 ApiError。 */
function notFound(path: string, message: string): unknown {
  return { error: { code: "demo_missing", message, details: { path }, request_id: "demo" } };
}

/* ------------------------------------------------------------------ */
/* 解析器                                                              */
/* ------------------------------------------------------------------ */

/**
 * 只有"读写同路径"或"仅存在于写操作"的子资源才需要在这里拦下。
 * 注意 `/runs/{id}/reviews` 的 GET 是只读列表，不能一概拦；用 method 区分。
 */
const WRITE_ONLY_SUFFIXES = ["/retry", "/cancel", "/export"];

function isWriteLike(path: string, method: "GET" | "POST"): boolean {
  if (method === "POST") return true;
  const [base] = path.split("?");
  return WRITE_ONLY_SUFFIXES.some((suffix) => base.endsWith(suffix));
}

/**
 * 演示数据只读，没有后端计算。
 * 返回值为与真实接口同形状的数据；找不到返回 undefined（由 client 抛 404）。
 */
function resolve(pathWithQuery: string, query: URLSearchParams, method: "GET" | "POST" = "GET"): unknown {
  const path = pathWithQuery.split("?")[0] ?? pathWithQuery;
  if (!path.startsWith("/api/v1/")) return undefined;
  const segments = path.slice("/api/v1/".length).split("/").filter(Boolean);

  if (isWriteLike(path, method)) {
    return notFound(
      path,
      "离线演示数据是只读的：写操作（重试 / 取消 / 复核 / 导出）需要真实后端。请在 127.0.0.1:8000 启动后端后切回在线模式。",
    );
  }

  // /health/live, /health/ready
  if (segments[0] === "health") {
    if (segments[1] === "live") return { status: "live" };
    if (segments[1] === "ready") return { status: "ready", model_configured: false };
    return undefined;
  }

  // /projects, /projects/{id}, /projects/{id}/bidders
  if (segments[0] === "projects") {
    if (segments.length === 1) return paginate(projectIndex, query);
    const projectId = segments[1];
    if (segments.length === 3 && segments[2] === "bidders") {
      return paginate(
        bidderIndex.filter((row) => textOf(row.project_id) === projectId),
        query,
      );
    }
    const hit = projectIndex.find((row) => textOf(row.project_id) === projectId);
    return hit ?? undefined;
  }

  // /documents/{id}, /documents/{id}/chunks
  if (segments[0] === "documents") {
    const documentId = segments[1];
    if (!documentId) return undefined;
    const file = documentFiles.get(documentId);
    if (segments.length === 3 && segments[2] === "chunks") {
      const rows = asRows(file?.chunks);
      return paginate(rows, query);
    }
    if (segments.length === 2) {
      // 详情以 GET 原样响应为准（索引行缺少 document_hash 等字段）。
      return file?.document ?? documentIndex.get(documentId) ?? undefined;
    }
    return undefined;
  }

  // /runs, /runs/{id} 及其子资源
  if (segments[0] === "runs") {
    if (segments.length === 1) {
      let rows = asRows(indexFile.runs);
      const projectId = query.get("project_id");
      const type = query.get("type");
      const status = query.get("status");
      if (projectId) rows = rows.filter((row) => textOf(row.project_id) === projectId);
      if (type) rows = rows.filter((row) => textOf(row.type) === type);
      if (status) rows = rows.filter((row) => textOf(row.status) === status);
      return paginate(rows, query);
    }

    const runId = segments[1];
    if (!runId) return undefined;
    const file = runFileOf(runId);
    const row = file?.run ?? runIndex.get(runId);

    if (segments.length === 2) return row ?? undefined;

    const sub = segments[2];
    if (sub === "events") {
      const afterSeq = Number(query.get("after_seq") ?? "0");
      const from = Number.isFinite(afterSeq) ? afterSeq : 0;
      const rows = asRows(file?.events).filter((event) => Number(event.seq ?? 0) > from);
      return paginate(rows, query);
    }
    if (sub === "results") return file?.results ?? undefined;
    if (sub === "reviews") return paginate(asRows(file?.reviews), query);
    if (sub === "reports") return paginate(asRows(file?.reports), query);
    return undefined;
  }

  // /reports/{id}
  if (segments[0] === "reports") {
    const reportId = segments[1];
    if (!reportId) return undefined;
    if (segments.length === 2) return reportOf(reportId) ?? undefined;
    return undefined;
  }

  // /companies, /companies/{id}
  if (segments[0] === "companies") {
    if (segments.length === 1) return paginate(companyIndex, query);
    const companyId = segments[1];
    const hit = companyIndex.find((row) => textOf(row.company_id) === companyId);
    return hit ?? undefined;
  }

  return undefined;
}

/** 演示模式下的元信息，供 About / 演示横幅展示（不参与业务判断）。 */
export const DEMO_META = {
  generatedAt: textOf(indexFile.generated_at),
  source: textOf(indexFile.source),
  notice: textOf(indexFile.notice),
  gaps: Array.isArray(indexFile.gaps) ? indexFile.gaps : [],
  statistics: indexFile.statistics ?? {},
} as const;

/** 建好演示解析器。数据已随构建内联，无需异步请求。 */
export async function createDemoClient(): Promise<DemoResolver> {
  return resolve;
}
