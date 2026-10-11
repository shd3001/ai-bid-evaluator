/**
 * 后端契约的唯一出口。
 *
 * 约束（见 docs/DESIGN.md §9）：本文件不做任何业务计算——分值、资格、排名、版本、stale
 * 全部来自后端；这里只负责拼请求、原样回传、错误映射、分页游标透传与幂等键。
 */
import type { components, operations } from "./schema";

export type Schema = components["schemas"];
export type Run = Schema["RunResponse"];
export type RunCreate = Schema["RunCreate"];
export type Project = Schema["ProjectResponse"];
export type Bidder = Schema["BidderResponse"];
export type DocumentResponse = Schema["DocumentResponse"];
export type DocumentChunk = Schema["DocumentChunk"];
export type EvidenceRef = Schema["EvidenceRef"];
export type EventResponse = Schema["EventResponse"];
export type EvaluationResponse = Schema["EvaluationResponse"];
export type ReviewItem = Schema["ReviewItem"];
export type ReviewDecision = Schema["ReviewDecision"];
export type ReviewResponse = Schema["ReviewResponse"];
export type ReportResponse = Schema["ReportResponse"];
export type CompanyProfile = Schema["CompanyProfile"];
export type ErrorResponse = Schema["ErrorResponse"];
export type QualificationCheck = Schema["QualificationCheck"];
export type QualificationResult = Schema["QualificationResult"];
export type ScoreItem = Schema["ScoreItem"];
export type ScoreResult = Schema["ScoreResult"];
export type OpportunityAssessment = Schema["OpportunityAssessment"];
export type OpportunityRequest = Schema["OpportunityRequest"];
export type TenderNotice = Schema["TenderNotice"];
export type VersionRequest = Schema["VersionRequest"];

export type ExportFormat = "json" | "markdown" | "html";
export type DocRole = DocumentResponse["role"];

/** 分页查询：limit 默认 20，最大 100；cursor 必须原样回传。 */
export interface PageQuery {
  limit?: number;
  cursor?: string | null;
  /** 具体列表接口会附加自己的筛选键（如 runs 的 project_id/type/status）。 */
  [key: string]: string | number | null | undefined;
}

export interface Page<T> {
  items: T[];
  next_cursor?: string | null;
}

export interface RunListQuery extends PageQuery {
  project_id?: string | null;
  type?: string | null;
  status?: string | null;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: Schema["ErrorBody"],
  ) {
    super(body.message);
    this.name = "ApiError";
  }

  get code(): string {
    return this.body.code;
  }
  get requestId(): string {
    return this.body.request_id;
  }
  /** 幂等键冲突 / 版本冲突 / 状态冲突：前端应刷新最新状态而不是自动覆盖。 */
  get isConflict(): boolean {
    return this.status === 409;
  }
  get isNotFound(): boolean {
    return this.status === 404;
  }
}

/** 网络层失败（后端未启动、连接被拒绝、断网）。 */
export class TransportError extends Error {
  constructor(readonly cause: unknown) {
    super("无法连接到后端接口。请确认后端已在 127.0.0.1:8000 启动，或切换到离线演示数据。");
    this.name = "TransportError";
  }
}

export interface ClientOptions {
  /** 默认同源：开发期由 Vite 代理 /api 到后端，避免 CORS 配置漂移。 */
  baseUrl?: string;
  /** 超时（毫秒），默认 30 秒。 */
  timeoutMs?: number;
  /** 离线演示数据源：设置后所有读请求走本地夹具，写请求抛 DemoReadOnlyError。 */
  demo?: DemoResolver;
}

export class DemoReadOnlyError extends Error {
  constructor(action: string) {
    super(`离线演示数据为只读：${action} 需要真实后端。`);
    this.name = "DemoReadOnlyError";
  }
}

/**
 * 演示解析器：接收路径、查询与 HTTP 方法，返回与真实接口同形状的数据，找不到返回 undefined。
 *
 * 为什么需要 method：`/runs/{id}/reviews` 同一路径上既有 GET（列复核项）又有 POST（提交复核），
 * 只按路径分派会把只读的 GET 误判成写操作（真实发生过的 bug）。
 */
export type DemoResolver = (path: string, query: URLSearchParams, method: "GET" | "POST") => unknown;

const IMPOSSIBLE: DemoResolver = () => undefined;

export class ApiClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly demo: DemoResolver;

  constructor(options: ClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "").replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.demo = options.demo ?? IMPOSSIBLE;
  }

  get isDemo(): boolean {
    return this.demo !== IMPOSSIBLE;
  }

  /* ---------------- 传输层 ---------------- */

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    init: { query?: URLSearchParams; body?: unknown; idempotencyKey?: string; form?: FormData } = {},
  ): Promise<T> {
    const query = init.query?.toString() ?? "";
    if (this.demo !== IMPOSSIBLE) {
      if (method === "POST") throw new DemoReadOnlyError(path);
      const demoValue = this.demo(query ? `${path}?${query}` : path, init.query ?? new URLSearchParams(), method);
      if (demoValue === undefined) {
        throw new ApiError(404, {
          code: "demo_missing",
          message: `离线演示数据里没有 ${path}。请先在联网/有后端的条件下重新生成夹具。`,
          request_id: "demo",
        });
      }
      return demoValue as T;
    }

    const url = `${this.baseUrl}${path}${query ? `?${query}` : ""}`;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (init.idempotencyKey) headers["Idempotency-Key"] = init.idempotencyKey;
    if (init.body !== undefined) headers["Content-Type"] = "application/json";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: init.form ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
        signal: controller.signal,
      });
    } catch (cause) {
      throw new TransportError(cause);
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }
    if (!response.ok) {
      const errorBody = (payload as ErrorResponse | null)?.error;
      throw new ApiError(response.status, {
        code: errorBody?.code ?? "unknown_error",
        message: errorBody?.message ?? `请求失败（HTTP ${response.status}）。`,
        details: errorBody?.details,
        request_id: errorBody?.request_id ?? response.headers.get("X-Request-ID") ?? "",
      });
    }
    return payload as T;
  }

  /**
   * 导出接口返回的是文件流（json/markdown/html），单独走一条路径。
   *
   * 演示模式下也走 demo 解析器（而不是直接抛错）：导出虽然用 GET，但它会取走报告全文，
   * 属于"读之外的动作"，由 demo 源统一给出"演示数据不支持导出"的说明。
   */
  async exportReport(reportId: string, format: ExportFormat): Promise<string> {
    if (this.demo !== IMPOSSIBLE) {
      const value = this.demo(
        `/api/v1/reports/${reportId}/export?format=${format}`,
        new URLSearchParams({ format }),
        "GET",
      );
      if (typeof value !== "string") throw new DemoReadOnlyError("导出报告");
      return value;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/api/v1/reports/${encodeURIComponent(reportId)}/export?format=${format}`, {
        signal: controller.signal,
        headers: { Accept: "text/plain, application/json, text/html;q=0.9, */*" },
      });
      const text = await response.text();
      if (!response.ok) {
        let body: Schema["ErrorBody"] = {
          code: "export_failed",
          message: text || `导出失败（HTTP ${response.status}）。`,
          request_id: response.headers.get("X-Request-ID") ?? "",
        };
        try {
          const parsed = JSON.parse(text) as ErrorResponse;
          if (parsed.error) body = parsed.error;
        } catch {
          /* 非 JSON 错误体，保留原始文本 */
        }
        throw new ApiError(response.status, body);
      }
      return text;
    } catch (cause) {
      if (cause instanceof ApiError) throw cause;
      throw new TransportError(cause);
    } finally {
      clearTimeout(timer);
    }
  }

  /* ---------------- 读接口 ---------------- */

  healthLive(): Promise<Schema["HealthResponse"]> {
    return this.request("GET", "/api/v1/health/live");
  }

  healthReady(): Promise<Schema["HealthResponse"]> {
    return this.request("GET", "/api/v1/health/ready");
  }

  listProjects(query: PageQuery = {}): Promise<Page<Project>> {
    return this.request("GET", "/api/v1/projects", { query: pageQuery(query) });
  }

  createProject(name: string): Promise<Project> {
    return this.request("POST", "/api/v1/projects", { body: { name } });
  }

  createBidder(projectId: string, name: string): Promise<Bidder> {
    return this.request("POST", `/api/v1/projects/${encodeURIComponent(projectId)}/bidders`, { body: { name } });
  }

  getDocument(documentId: string): Promise<DocumentResponse> {
    return this.request("GET", `/api/v1/documents/${encodeURIComponent(documentId)}`);
  }

  listChunks(documentId: string, query: PageQuery = {}): Promise<Page<DocumentChunk>> {
    return this.request("GET", `/api/v1/documents/${encodeURIComponent(documentId)}/chunks`, {
      query: pageQuery(query),
    });
  }

  listRuns(query: RunListQuery = {}): Promise<Page<Run>> {
    return this.request("GET", "/api/v1/runs", { query: pageQuery(query) });
  }

  getRun(runId: string): Promise<Run> {
    return this.request("GET", `/api/v1/runs/${encodeURIComponent(runId)}`);
  }

  listEvents(runId: string, afterSeq = 0, query: PageQuery = {}): Promise<Page<EventResponse>> {
    const params = pageQuery(query);
    params.set("after_seq", String(afterSeq));
    return this.request("GET", `/api/v1/runs/${encodeURIComponent(runId)}/events`, { query: params });
  }

  getResults(runId: string): Promise<EvaluationResponse> {
    return this.request("GET", `/api/v1/runs/${encodeURIComponent(runId)}/results`);
  }

  listReviews(runId: string, query: PageQuery = {}): Promise<Page<ReviewItem>> {
    return this.request("GET", `/api/v1/runs/${encodeURIComponent(runId)}/reviews`, { query: pageQuery(query) });
  }

  listReports(runId: string, query: PageQuery = {}): Promise<Page<ReportResponse>> {
    return this.request("GET", `/api/v1/runs/${encodeURIComponent(runId)}/reports`, { query: pageQuery(query) });
  }

  getReport(reportId: string): Promise<ReportResponse> {
    return this.request("GET", `/api/v1/reports/${encodeURIComponent(reportId)}`);
  }

  listCompanies(query: PageQuery = {}): Promise<Page<CompanyProfile>> {
    return this.request("GET", "/api/v1/companies", { query: pageQuery(query) });
  }

  getCompany(companyId: string): Promise<CompanyProfile> {
    return this.request("GET", `/api/v1/companies/${encodeURIComponent(companyId)}`);
  }

  /* ---------------- 写接口（都必须带 Idempotency-Key） ---------------- */

  uploadDocument(input: {
    projectId: string;
    role: DocRole;
    file: File;
    bidderId?: string | null;
  }): Promise<DocumentResponse> {
    const form = new FormData();
    form.set("project_id", input.projectId);
    form.set("role", input.role);
    form.set("file", input.file);
    if (input.bidderId) form.set("bidder_id", input.bidderId);
    return this.request("POST", "/api/v1/documents", { form });
  }

  createRun(body: RunCreate, idempotencyKey: string): Promise<Run> {
    return this.request("POST", "/api/v1/runs", { body, idempotencyKey });
  }

  retryRun(runId: string, expectedVersion: number, idempotencyKey: string): Promise<Run> {
    const body: VersionRequest = { expected_version: expectedVersion };
    return this.request("POST", `/api/v1/runs/${encodeURIComponent(runId)}/retry`, { body, idempotencyKey });
  }

  cancelRun(runId: string, expectedVersion: number, idempotencyKey: string): Promise<Run> {
    const body: VersionRequest = { expected_version: expectedVersion };
    return this.request("POST", `/api/v1/runs/${encodeURIComponent(runId)}/cancel`, { body, idempotencyKey });
  }

  applyReview(runId: string, body: ReviewDecision, idempotencyKey: string): Promise<ReviewResponse> {
    return this.request("POST", `/api/v1/runs/${encodeURIComponent(runId)}/reviews`, { body, idempotencyKey });
  }
}

export function pageQuery(query: Record<string, string | number | null | undefined>): URLSearchParams {
  const params = new URLSearchParams();
  params.set("limit", String(query.limit ?? 20));
  if (query.cursor) params.set("cursor", String(query.cursor));
  for (const [key, value] of Object.entries(query)) {
    if (key === "limit" || key === "cursor") continue;
    if (value !== null && value !== undefined && value !== "") params.set(key, String(value));
  }
  return params;
}

/** 操作名 → 生成类型请求体，便于在页面里精确取类型。 */
export type RunCreateBody = operations["runs_create"]["requestBody"]["content"]["application/json"];
