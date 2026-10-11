/**
 * 幂等键：每个逻辑提交/复核/重试/取消请求一个键。
 * 网络重试必须复用同一键与同一内容（同键不同内容后端返回 409）。
 * 键与内容的指纹一起存 sessionStorage：内容变了就换新键，避免误撞 409。
 */

const PREFIX = "review-desk.idem.";

export function newIdempotencyKey(): string {
  const random = crypto.getRandomValues(new Uint8Array(16));
  const hex = Array.from(random, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `rd_${Date.now().toString(36)}_${hex}`;
}

/** 内容指纹：稳定序列化，仅用于判断"内容是否变了"。 */
export function fingerprint(value: unknown): string {
  const stable = JSON.stringify(sortKeys(value));
  let hash = 2166136261;
  for (let index = 0; index < stable.length; index += 1) {
    hash ^= stable.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, sortKeys(item)]),
    );
  }
  return value;
}

interface IdempotencyRecord {
  key: string;
  fingerprint: string;
}

/** 取（或创建）某个逻辑操作的幂等键；内容变化时自动换新键。 */
export function idempotencyKey(scope: string, content: unknown): string {
  const storageKey = `${PREFIX}${scope}`;
  const print = fingerprint(content);
  try {
    const raw = sessionStorage.getItem(storageKey);
    if (raw) {
      const record = JSON.parse(raw) as IdempotencyRecord;
      if (record.fingerprint === print && record.key) return record.key;
    }
  } catch {
    /* 存储不可用时退化为一次性键 */
  }
  const key = newIdempotencyKey();
  try {
    sessionStorage.setItem(storageKey, JSON.stringify({ key, fingerprint: print } satisfies IdempotencyRecord));
  } catch {
    /* 忽略存储失败 */
  }
  return key;
}

/** 操作成功后清理，避免下一次提交复用旧键。 */
export function clearIdempotencyKey(scope: string): void {
  try {
    sessionStorage.removeItem(`${PREFIX}${scope}`);
  } catch {
    /* 忽略 */
  }
}
