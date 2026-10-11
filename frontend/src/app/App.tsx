/**
 * 应用入口：探测后端 → 建立会话/提示/证据上下文 → 按 hash 路由分派视图。
 *
 * 这里不做任何业务判断：所有分值、资格、报告版本与失效状态都来自后端响应。
 */
import { useEffect, useState } from "react";
import { SessionProvider, ToastProvider, useSession } from "./session";
import { AppErrorBoundary, AppShell } from "./shell";
import { EvidenceDrawer, EvidenceProvider, useEvidenceFocus } from "../components/evidence";
import { ErrorNotice } from "../components/core";
import { probeMode, type ModeProbe } from "../api/mode";
import type { DemoResolver } from "../api/client";
import { createDemoClient } from "../api/demo-source";
import { useRoute } from "../utils/router";
import { AboutView, NotFoundView } from "../views/AboutView";
import { DocumentView } from "../views/DocumentView";
import { OpportunityView } from "../views/OpportunityView";
import { ProjectDetailView } from "../views/ProjectDetailView";
import { ProjectsView } from "../views/ProjectsView";
import { ReportView } from "../views/ReportView";
import { ReviewView } from "../views/ReviewView";
import { RunCreateView } from "../views/RunCreateView";
import { RunView } from "../views/RunView";
import { UploadView } from "../views/UploadView";

export function App({ probe, demo: preset }: { probe: ModeProbe; demo?: DemoResolver }) {
  const [demo, setDemo] = useState<DemoResolver | null>(() => preset ?? null);
  const [demoError, setDemoError] = useState<unknown>(null);

  useEffect(() => {
    if (probe.mode !== "demo" || preset) return;
    let disposed = false;
    createDemoClient()
      .then((value) => {
        if (!disposed) setDemo(() => value);
      })
      .catch((cause: unknown) => {
        if (!disposed) setDemoError(cause);
      });
    return () => {
      disposed = true;
    };
  }, [probe.mode, preset]);

  if (probe.mode === "demo" && demoError) {
    return (
      <div className="boot boot--failed">
        <h1>离线演示数据没能加载</h1>
        <p className="muted">
          界面回落到离线夹具，但夹具本身读取失败。可以改用真实后端（<code className="mono">?demo=0</code>），或检查构建产物里是否包含夹具文件。
        </p>
        <ErrorNotice error={demoError} />
      </div>
    );
  }

  if (probe.mode === "demo" && !demo) {
    return (
      <div className="boot">
        <p className="muted">正在载入离线演示数据…</p>
      </div>
    );
  }

  return (
    <SessionProvider mode={probe.mode} healthReason={probe.health.reason} demo={demo ?? undefined}>
      <ToastProvider>
        <EvidenceProvider>
          <AppErrorBoundary>
            <Shell />
          </AppErrorBoundary>
        </EvidenceProvider>
      </ToastProvider>
    </SessionProvider>
  );
}

function Shell() {
  const route = useRoute();
  const { api, mode } = useSession();
  const { focus } = useEvidenceFocus();

  return (
    <AppShell route={route}>
      <RouteView route={route} />
      {focus ? <EvidenceDrawer api={api} /> : null}
      {mode === "demo" ? (
        <p className="sr-only" role="status">
          当前为离线演示数据，写操作不可用。
        </p>
      ) : null}
    </AppShell>
  );
}

function RouteView({ route }: { route: ReturnType<typeof useRoute> }) {
  const params = route.params;
  switch (route.name) {
    case "projects":
      return <ProjectsView />;
    case "project":
      return params.projectId ? <ProjectDetailView projectId={params.projectId} /> : <NotFoundView />;
    case "upload":
      return params.projectId ? <UploadView projectId={params.projectId} /> : <NotFoundView />;
    case "documents":
      return params.documentId ? <DocumentView documentId={params.documentId} /> : <NotFoundView />;
    case "runNew":
      return <RunCreateView />;
    case "run":
      return params.runId ? <RunView runId={params.runId} /> : <NotFoundView />;
    case "review":
      return params.runId ? <ReviewView runId={params.runId} /> : <NotFoundView />;
    case "report":
      return params.runId ? <ReportView runId={params.runId} /> : <NotFoundView />;
    case "opportunity":
      return <OpportunityView projectId={params.projectId ?? null} />;
    case "about":
      return <AboutView />;
    default:
      return <NotFoundView />;
  }
}

/** main.tsx 用它拿到启动探测结果后渲染 <App probe={...} />。 */
export async function boot(): Promise<ModeProbe> {
  return probeMode();
}
