/** 应用的壳：顶栏、阶段带、错误边界、提示。 */
import { Component, useCallback, useEffect, useState, type ErrorInfo, type ReactNode } from "react";
import { cx } from "../utils/cx";
import { href, type RouteMatch } from "../utils/router";
import { useSession, useToast } from "./session";
import { Button, CopyId, StatusFlag } from "../components/core";
import { applyTheme, nextThemeChoice, readThemeChoice, setThemeChoice, THEME_LABEL, type ThemeChoice } from "../utils/theme";

/* ---------------- 错误边界：任何渲染异常都不能把整页变成白屏 ---------------- */

interface BoundaryState {
  error: Error | null;
  info: string | null;
}

export class AppErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  override state: BoundaryState = { error: null, info: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error, info: null };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ error, info: info.componentStack ?? null });
    // eslint-disable-next-line no-console
    console.error("[评审台] 渲染异常", error, info);
  }

  override render(): ReactNode {
    const { error, info } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="crash" id="app-error" role="alert">
        <h1 className="crash__title">界面遇到一个未预期的错误</h1>
        <p className="crash__message">{error.message}</p>
        <p className="muted">
          你的数据在后端没有受影响：这次失败只发生在这个页面的渲染过程里。可以重新载入，或先把这段信息复制下来。
        </p>
        <div className="crash__actions">
          <Button variant="primary" onClick={() => window.location.reload()}>
            重新载入
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              this.setState({ error: null, info: null });
            }}
          >
            返回当前页面
          </Button>
        </div>
        {info ? (
          <details className="crash__detail">
            <summary>组件栈</summary>
            <pre>{info}</pre>
          </details>
        ) : null}
      </div>
    );
  }
}

/* ---------------- 顶栏 ---------------- */

const STEPS: Array<{ step: 1 | 2 | 3 | 4 | 5; label: string; note: string }> = [
  { step: 1, label: "建项目", note: "项目与投标人" },
  { step: 2, label: "交材料", note: "上传与解析" },
  { step: 3, label: "看进度", note: "运行与事件" },
  { step: 4, label: "人工复核", note: "逐条确认" },
  { step: 5, label: "报告", note: "确认与导出" },
];

function stepHref(step: number, route: RouteMatch): string | null {
  const projectId = route.params.projectId ?? null;
  const runId = route.params.runId ?? null;
  if (step === 1) return href("/projects");
  if (step === 2) return projectId ? href(`/projects/${projectId}/upload`) : null;
  if (step === 3) return runId ? href(`/runs/${runId}`) : null;
  if (step === 4) return runId ? href(`/runs/${runId}/review`) : null;
  if (step === 5) return runId ? href(`/runs/${runId}/report`) : null;
  return null;
}

export function PhaseRail({ route }: { route: RouteMatch }) {
  const active = route.phase ?? 0;
  return (
    <nav className="phaserail" aria-label="评审流程">
      <ol className="phaserail__list">
        {STEPS.map((item) => {
          const target = stepHref(item.step, route);
          const state = item.step === active ? "current" : item.step < active ? "done" : "todo";
          const body = (
            <>
              <span className="phase__num ledger-num">{item.step}</span>
              <span className="phase__label">{item.label}</span>
              <span className="phase__note micro">{item.note}</span>
            </>
          );
          return (
            <li key={item.step} className={cx("phase", `phase--${state}`)} aria-current={state === "current" ? "step" : undefined}>
              {target ? (
                <a className="phase__link" href={target}>
                  {body}
                </a>
              ) : (
                <span className="phase__link phase__link--inert" title="先进入一个运行（run）才能到这里">
                  {body}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/**
 * 主题切换：三态按钮（跟随系统 → 浅色 → 深色）。
 * 选择写在 localStorage，不由后端参与——它不影响任何业务结论。
 */
export function ThemeToggle() {
  const [choice, setChoice] = useState<ThemeChoice>(() => readThemeChoice());

  // 跟随系统时，系统在会话中途切深浅也要跟上
  useEffect(() => {
    applyTheme(choice);
    if (choice !== "system") return;
    const media = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;
    if (!media) return;
    const onChange = () => applyTheme("system");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [choice]);

  // 注意：不要把 setThemeChoice 放进 setState 更新函数里——StrictMode 会重复调用更新函数，
  // 而写 localStorage / 改 document 属性是副作用。
  const cycle = useCallback(() => {
    const next = nextThemeChoice(choice);
    setThemeChoice(next);
    setChoice(next);
  }, [choice]);

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={cycle}
      aria-label={`主题：${THEME_LABEL[choice]}（点击切换）`}
      title={`主题：${THEME_LABEL[choice]}（点击切换：跟随系统 → 浅色 → 深色）`}
    >
      <span aria-hidden="true" className="theme-toggle__mark">
        {choice === "dark" ? "◐" : choice === "light" ? "○" : "◑"}
      </span>
      <span className="theme-toggle__label">{THEME_LABEL[choice]}</span>
    </button>
  );
}

/** 主题文案见 `src/utils/theme.ts` 的 THEME_LABEL，这里不再保留本地的兜底包装。 */

export function TopBar({ route }: { route: RouteMatch }) {
  const session = useSession();
  const demoToggle = session.mode === "demo" ? { demo: "0" } : { demo: "1" };
  return (
    <header className="topbar">
      <div className="topbar__inner">
        <a className="brand" href={href("/projects")}>
          <span className="brand__seal" aria-hidden="true">
            印
          </span>
          <span className="brand__text">
            <span className="brand__name">评审台</span>
            <span className="brand__sub micro">招投标辅助评审 · 证据可回溯</span>
          </span>
        </a>

        <nav className="topnav" aria-label="主导航">
          <a className={cx("topnav__link", route.name === "projects" && "is-active")} href={href("/projects")}>
            项目台
          </a>
          <a className={cx("topnav__link", route.name === "opportunity" && "is-active")} href={href("/opportunity")}>
            机会筛选
          </a>
          <a className={cx("topnav__link", route.name === "about" && "is-active")} href={href("/about")}>
            关于
          </a>
        </nav>

        <div className="topbar__state">
          <ConnectionBadge />
          <a className="mode-toggle" href={href(route.path, demoToggle)} title="切换真实后端 / 离线演示数据">
            {session.mode === "demo" ? "离线演示" : "真实后端"}
          </a>
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}

export function ConnectionBadge() {
  const session = useSession();
  if (session.mode === "demo") {
    return (
      <StatusFlag tone="review" icon="◇">
        离线演示数据（只读）
      </StatusFlag>
    );
  }
  return (
    <StatusFlag tone="pass" icon="●">
      后端就绪
    </StatusFlag>
  );
}

/* ---------------- 提示区 ---------------- */

export function ToastHub() {
  const { toasts, dismiss } = useToast();
  if (toasts.length === 0) return null;
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={cx("toast", `toast--${toast.tone}`)} role="status">
          <div className="toast__body">
            <p className="toast__message">{toast.message}</p>
            {toast.detail ? <p className="toast__detail micro">{toast.detail}</p> : null}
          </div>
          <button type="button" className="toast__close" onClick={() => dismiss(toast.id)} aria-label="关闭提示">
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

/* ---------------- 页面骨架 ---------------- */

export function AppShell({
  route,
  children,
  aside,
}: {
  route: RouteMatch;
  children: ReactNode;
  aside?: ReactNode;
}) {
  const session = useSession();
  return (
    <div className="shell" data-mode={session.mode}>
      <a className="skip-link" href="#main">
        跳到主要内容
      </a>
      <TopBar route={route} />
      {session.mode === "demo" ? (
        <div className="strip">
          <span className="strip__mark" aria-hidden="true">
            ◇
          </span>
          <span>
            后端不可达（{session.healthReason}）。当前展示的是<b>离线夹具</b>：内容取自后端真实响应，但
            <b>写操作已禁用</b>。
          </span>
          <CopyId value="127.0.0.1:8000" label="后端地址" />
        </div>
      ) : null}
      <PhaseRail route={route} />
      <div className={cx("page", aside && "page--split")} id="main">
        <main className="page__main">{children}</main>
        {aside ? <div className="page__aside">{aside}</div> : null}
      </div>
      <footer className="footer">
        <p>
          本界面只做展示与提交：<b>分值计算、资格判定、报告版本与失效判断全部由后端给出</b>。任何结论都可以点开
          <span className="tenon tenon--inline" aria-hidden="true">
            <span className="tenon__tongue" />
            ⌗ 证据榫
          </span>
          回到原文。
        </p>
      </footer>
      <ToastHub />
    </div>
  );
}
