/** 拼接类名：假值（false/null/undefined/0/""）自动跳过，所以可以安全地写 `cond && "class"`。 */
export function cx(...parts: unknown[]): string {
  return parts.filter(Boolean).join(" ");
}

export function shortHash(value: string, head = 8): string {
  if (!value) return "";
  const compact = value.replace(/^sha256[:-]/i, "");
  return compact.length <= head ? compact : compact.slice(0, head);
}
