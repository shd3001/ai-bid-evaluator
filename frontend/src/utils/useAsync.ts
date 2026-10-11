/** 极简异步加载：给不进轮询的接口（详情、结果、报告、分页列表）用。 */
import { useCallback, useEffect, useRef, useState } from "react";

export interface AsyncResult<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
  reload: () => void;
}

/** 载入函数可以返回 null：表示"当前没有可加载的目标"，此时不进入 loading。 */
export function useAsync<T>(load: (() => Promise<T> | null) | null, deps: unknown[]): AsyncResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(load !== null);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    const load = loadRef.current;
    if (!load) {
      setLoading(false);
      return;
    }
    let disposed = false;
    setLoading(true);
    void Promise.resolve()
      .then(() => load())
      .then((value) => {
        if (disposed) return;
        setData(value);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (disposed) return;
        setError(cause instanceof Error ? cause : new Error(String(cause)));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { data, loading, error, reload };
}
