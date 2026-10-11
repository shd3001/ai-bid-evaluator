import type { ApiClient, RunCreate } from "../api/client";
import { clearIdempotencyKey, idempotencyKey } from "./idempotency";

interface Submission {
  input: string;
  body: RunCreate;
  key: string;
}

const memory = new Map<string, Submission>();
const storageKey = (scope: string) => `review-desk.submission.${scope}`;

/** Freeze the version and key before POST; ambiguous network failures replay this exact request. */
export async function prepareRunSubmission(api: Pick<ApiClient, "getCompany">, scope: string, draft: RunCreate): Promise<Submission> {
  const input = JSON.stringify(draft);
  let saved = memory.get(scope);
  if (!saved) {
    try {
      const raw = sessionStorage.getItem(storageKey(scope));
      if (raw) saved = JSON.parse(raw) as Submission;
    } catch { /* In-memory retries still work when storage is unavailable. */ }
  }
  if (saved?.input === input && saved.body && saved.key) return saved;

  const body = structuredClone(draft);
  if (body.company_id) body.company_revision = (await api.getCompany(body.company_id)).revision;
  const submission = { input, body, key: idempotencyKey(scope, body) };
  memory.set(scope, submission);
  try { sessionStorage.setItem(storageKey(scope), JSON.stringify(submission)); } catch { /* memory fallback */ }
  return submission;
}

/** Clear only after success or a definitive rejection, never after an ambiguous transport failure. */
export function clearRunSubmission(scope: string): void {
  memory.delete(scope);
  try { sessionStorage.removeItem(storageKey(scope)); } catch { /* storage unavailable */ }
  clearIdempotencyKey(scope);
}
