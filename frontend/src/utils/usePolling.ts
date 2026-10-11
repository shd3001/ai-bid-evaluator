/**
 * 轮询：前台 2 秒、后台标签页 10 秒（见计划 §4.1）。
 * 进入 pending/running 之外的任一状态（succeeded / failed / cancelled / awaiting_review）即停止自动轮询。
 * 连续失败做指数退避（最多 15 秒一次），不清空界面上已有的内容，只提示连接抖动。
 */
import { useCallback, useEffect, useRef, useState } from "react";

export const FOREGROUND_MS = 2000;
export const BACKGROUND_MS = 10_000;
const BACKOFF_BASE_MS = 3000;
const BACKOFF_MAX_MS = 15_000;
const BACKOFF_AFTER_FAILURES = 2;

export interface PollingResult<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
  /** 连续失败次数：>0 时界面显示"连接抖动，正在重试"。 */
  failures: number;
  lastUpdatedAt: number | null;
  refresh: () => void;
}

export function usePolling<T>(
  load: () => Promise<T> | null,
  options: { enabled?: boolean; stop?: boolean } = {},
): PollingResult<T> {
  const { enabled = true, stop = false } = options;
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<Error | null>(null);
  const [failures, setFailures] = useState(0);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [nonce, setNonce] = useState(0);

  const loadRef = useRef(load);
  loadRef.current = load;
  const failureRef = useRef(0);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    let disposed = false;
    let timer: number | undefined;
    let running = false;

    const scheduleNext = (delay: number): void => {
      if (disposed || stop) return;
      timer = window.setTimeout(() => {
        void run();
      }, delay);
    };

    const run = async (): Promise<void> => {
      if (disposed || running) return;
      running = true;
      try {
        const value = await loadRef.current();
        if (disposed) return;
        setData(value);
        setError(null);
        failureRef.current = 0;
        setFailures(0);
        setLastUpdatedAt(Date.now());
      } catch (cause) {
        if (disposed) return;
        setError(cause instanceof Error ? cause : new Error(String(cause)));
        failureRef.current += 1;
        setFailures(failureRef.current);
      } finally {
        running = false;
        if (!disposed) setLoading(false);
        if (disposed || stop) return;
        const hidden = document.visibilityState === "hidden";
        const base = hidden ? BACKGROUND_MS : FOREGROUND_MS;
        const delay =
          failureRef.current >= BACKOFF_AFTER_FAILURES
            ? Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * failureRef.current)
            : base;
        scheduleNext(delay);
      }
    };

    void run();

    const onVisibility = (): void => {
      // 回到前台立即补一次，避免后台 10 秒间隔让用户干等。
      if (document.visibilityState === "visible" && !disposed && !stop) {
        window.clearTimeout(timer);
        void run();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      disposed = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, stop, nonce]);

  return { data, loading, error, failures, lastUpdatedAt, refresh };
}
