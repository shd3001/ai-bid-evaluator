/**
 * 运行模式：优先连接真实后端；后端不可达时回落到离线夹具（只读）。
 *
 * 离线夹具不是"假后端"：它是用后端自己的响应导出的（见 frontend/src/demo/fixtures/README.md），
 * 因此页面渲染路径与连真实后端时完全一致；区别只在于写操作会被拒绝。
 */

export type AppMode = "live" | "demo";

export interface ModeProbe {
  mode: AppMode;
  /** 真实后端就绪状态；demo 模式下也表示探测结果。 */
  health: { ok: boolean; reason: string };
}

const PROBE_TIMEOUT_MS = 1500;

/** URL 上强制指定模式：`#/...?demo=1` 强制演示，`?demo=0` 强制真实后端。 */
export function forcedMode(): AppMode | null {
  const hash = window.location.hash;
  const query = hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : window.location.search.replace(/^\?/, "");
  const params = new URLSearchParams(query);
  const demo = params.get("demo");
  if (demo === "1" || demo === "true") return "demo";
  if (demo === "0" || demo === "false") return "live";
  return null;
}

export async function probeMode(baseUrl = ""): Promise<ModeProbe> {
  const forced = forcedMode();
  if (forced === "demo") {
    return { mode: "demo", health: { ok: false, reason: "已按 URL 参数强制使用离线演示数据" } };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}/api/v1/health/ready`, { signal: controller.signal });
    const body = await response.text();
    if (response.ok) {
      try {
        const health: unknown = JSON.parse(body);
        if (health && typeof health === "object" && "status" in health && health.status === "ready") {
          return { mode: "live", health: { ok: true, reason: "后端就绪" } };
        }
      } catch { /* Static hosts may return index.html with HTTP 200. */ }
      return { mode: forced === "live" ? "live" : "demo", health: { ok: false, reason: "接口未返回有效的后端就绪状态" } };
    }
    if (forced === "live") return { mode: "live", health: { ok: false, reason: body || `HTTP ${response.status}` } };
    return { mode: "demo", health: { ok: false, reason: body || `就绪检查返回 HTTP ${response.status}` } };
  } catch {
    if (forced === "live") return { mode: "live", health: { ok: false, reason: "后端不可达" } };
    return { mode: "demo", health: { ok: false, reason: "后端不可达（127.0.0.1:8000）" } };
  } finally {
    clearTimeout(timer);
  }
}
