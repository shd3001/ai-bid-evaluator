/** 应用上下文：会话、模式、路由跳转与提示。 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { ApiClient, type DemoResolver } from "../api/client";
import type { AppMode } from "../api/mode";

export interface Session {
  mode: AppMode;
  api: ApiClient;
  /** 后端不可达的原因，用于顶栏说明。 */
  healthReason: string;
}

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({
  mode,
  healthReason,
  demo,
  children,
}: {
  mode: AppMode;
  healthReason: string;
  demo?: DemoResolver;
  children: ReactNode;
}) {
  const api = useMemo(
    () => new ApiClient(mode === "demo" ? { demo, timeoutMs: 8000 } : {}),
    [mode, demo],
  );
  const value = useMemo<Session>(() => ({ mode, api, healthReason }), [mode, api, healthReason]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession 必须在 SessionProvider 内使用");
  return value;
}

/* ---------------- 轻提示 ---------------- */

export interface Toast {
  id: number;
  tone: "info" | "success" | "danger";
  message: string;
  detail?: string;
}

const ToastContext = createContext<{
  toasts: Toast[];
  push: (toast: Omit<Toast, "id">) => void;
  dismiss: (id: number) => void;
} | null>(null);

let toastSeq = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((item) => item.id !== id));
  }, []);

  const push = useCallback(
    (toast: Omit<Toast, "id">) => {
      toastSeq += 1;
      const id = toastSeq;
      setToasts((list) => [...list, { ...toast, id }]);
      if (toast.tone !== "danger") {
        window.setTimeout(() => dismiss(id), 4200);
      }
    },
    [dismiss],
  );

  const value = useMemo(() => ({ toasts, push, dismiss }), [toasts, push, dismiss]);
  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}

export function useToast() {
  const value = useContext(ToastContext);
  if (!value) throw new Error("useToast 必须在 ToastProvider 内使用");
  return value;
}
