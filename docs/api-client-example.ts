import type { components, operations } from "./api-types";

type Run = components["schemas"]["RunResponse"];
type CreateRun = operations["runs_create"]["requestBody"]["content"]["application/json"];
type Review = components["schemas"]["ReviewDecision"];
type ReviewResponse = components["schemas"]["ReviewResponse"];
type ErrorResponse = components["schemas"]["ErrorResponse"];
type Document = components["schemas"]["DocumentResponse"];

/** Minimal typed browser client; business decisions stay on the server. */
export class BidApi {
  constructor(private readonly baseUrl = "http://127.0.0.1:8000") {}

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const response = await fetch(this.baseUrl + path, options);
    const body: unknown = await response.json();
    if (!response.ok) {
      const error = body as ErrorResponse;
      throw new BidApiError(response.status, error.error);
    }
    return body as T;
  }

  createRun(body: CreateRun, idempotencyKey: string): Promise<Run> {
    return this.request<Run>("/api/v1/runs", {
      method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(body),
    });
  }

  getRun(runId: string): Promise<Run> {
    return this.request<Run>(`/api/v1/runs/${encodeURIComponent(runId)}`);
  }

  reviewRun(runId: string, body: Review, idempotencyKey: string): Promise<ReviewResponse> {
    return this.request<ReviewResponse>(`/api/v1/runs/${encodeURIComponent(runId)}/reviews`, {
      method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(body),
    });
  }

  upload(projectId: string, role: Document["role"], file: File, bidderId?: string): Promise<Document> {
    const form = new FormData();
    form.set("project_id", projectId);
    form.set("role", role);
    form.set("file", file);
    if (bidderId) form.set("bidder_id", bidderId);
    return this.request<Document>("/api/v1/documents", { method: "POST", body: form });
  }
}

export class BidApiError extends Error {
  constructor(readonly status: number, readonly details: ErrorResponse["error"]) {
    super(details.message);
  }
}

// These wire types come directly from OpenAPI and compile with strict checks.
export const syntheticRunRequest: CreateRun = {
  type: "opportunity_discovery", project_id: "project_example", document_ids: ["doc_example"],
  options: { regions: ["江苏"], min_budget: "1000000", max_candidates: 5 },
};
