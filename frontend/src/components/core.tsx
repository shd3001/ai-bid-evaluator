/** 基础组件：双包边卡片、按钮、徽标、加载与空态。 */
import {
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { cx } from "../utils/cx";
import {
  CHECK_STATUS,
  DOCUMENT_STATUS,
  RUN_STATUS_LABEL,
  assessmentStatus,
  checkStatus,
  type Verdict,
} from "../utils/format";
import type { Run } from "../api/client";

/* ---------------- Panel：外壳 + 内芯 双包边 ---------------- */

export interface PanelProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  eyebrow?: ReactNode;
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  tone?: "default" | "quiet" | "seal";
  as?: "section" | "article" | "div" | "aside";
  bodyClassName?: string;
}

export function Panel({
  eyebrow,
  title,
  description,
  actions,
  footer,
  tone = "default",
  as: Tag = "section",
  className,
  bodyClassName,
  children,
  ...rest
}: PanelProps) {
  const hasHead = Boolean(eyebrow || title || description || actions);
  return (
    <Tag className={cx("panel", `panel--${tone}`, className)} {...rest}>
      <div className="panel__core">
        {hasHead ? (
          <header className="panel__head">
            <div className="panel__heading">
              {eyebrow ? <p className="panel__eyebrow micro">{eyebrow}</p> : null}
              {title ? <h2 className="panel__title">{title}</h2> : null}
              {description ? <p className="panel__desc muted">{description}</p> : null}
            </div>
            {actions ? <div className="panel__actions">{actions}</div> : null}
          </header>
        ) : null}
        <div className={cx("panel__body", bodyClassName)}>{children}</div>
        {footer ? <footer className="panel__foot">{footer}</footer> : null}
      </div>
    </Tag>
  );
}

/* ---------------- Button ---------------- */

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "default" | "ghost" | "danger";
  size?: "md" | "sm";
  busy?: boolean;
}

export function Button({
  variant = "default",
  size = "md",
  busy = false,
  className,
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx("btn", `btn--${variant}`, size === "sm" && "btn--sm", className)}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy ? <span className="spinner" aria-hidden="true" /> : null}
      <span>{children}</span>
    </button>
  );
}

/* ---------------- 结论与状态 ---------------- */

export function VerdictBadge({ tone, label, count }: { tone: Verdict; label?: string; count?: number }) {
  const meta = CHECK_STATUS[tone] ?? CHECK_STATUS.needs_review!;
  return (
    <span className={cx("badge", `badge--${meta.verdict}`)} data-verdict={meta.verdict}>
      <span className="badge__mark" aria-hidden="true" />
      <span className="badge__label">{label ?? meta.label}</span>
      {typeof count === "number" ? <span className="badge__count ledger-num">{count}</span> : null}
    </span>
  );
}

export function AssessmentBadge({ status }: { status: string | null | undefined }) {
  const meta = assessmentStatus({ status });
  return (
    <span className={cx("badge", `badge--${meta.verdict}`)} data-verdict={meta.verdict}>
      <span className="badge__mark" aria-hidden="true" />
      <span className="badge__label">{meta.label}</span>
    </span>
  );
}

export function CheckBadge({ status }: { status: string | null | undefined }) {
  const meta = checkStatus({ status });
  return (
    <span className={cx("badge", "badge--sm", `badge--${meta.verdict}`)} data-verdict={meta.verdict}>
      <span className="badge__mark" aria-hidden="true" />
      <span className="badge__label">{meta.label}</span>
    </span>
  );
}

const RUN_TONE: Record<string, string> = {
  pending: "pending",
  running: "run",
  awaiting_review: "review",
  succeeded: "pass",
  failed: "fail",
  cancelled: "pending",
};

export function RunStatusChip({ run }: { run: Run }) {
  const status = run.status ?? "pending";
  const label = RUN_STATUS_LABEL[status] ?? status;
  return (
    <span className={cx("chip", `chip--${RUN_TONE[status] ?? "pending"}`)} data-status={status}>
      {status === "running" ? (
        <span className="pulse" aria-hidden="true" />
      ) : (
        <span className="chip__dot" aria-hidden="true" />
      )}
      <span className="chip__label">{label}</span>
    </span>
  );
}

/* ---------------- 状态旗标 ---------------- */

export function StatusFlag({
  tone,
  children,
  icon,
}: {
  tone: "seal" | "review" | "fail" | "pass" | "pending";
  children: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <span className={cx("flag", `flag--${tone}`)}>
      {icon ? (
        <span className="flag__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span>{children}</span>
    </span>
  );
}

export function DocumentStatusFlag({ status }: { status: string | null | undefined }) {
  const entry = DOCUMENT_STATUS[(status ?? "") as keyof typeof DOCUMENT_STATUS];
  const verdict = entry?.verdict ?? "needs_review";
  const tone = verdict === "passed" ? "pass" : verdict === "failed" ? "fail" : "review";
  return <StatusFlag tone={tone}>{entry?.label ?? status ?? "未知"}</StatusFlag>;
}

/* ---------------- 可复制 ID ---------------- */

export function CopyId({ value, label = "ID", prefix }: { value: string; label?: string; prefix?: string }) {
  const [copied, setCopied] = useState(false);
  const display = prefix ? `${prefix}${value}` : value;
  return (
    <span className="copyid">
      <span className="copyid__label micro">{label}</span>
      <code className="copyid__value mono" title={value}>
        {display}
      </code>
      <button
        type="button"
        className="copyid__btn"
        onClick={() => {
          const clipboard = navigator.clipboard;
          if (!clipboard) return;
          void clipboard
            .writeText(value)
            .then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1400);
            })
            .catch(() => setCopied(false));
        }}
        aria-label={`复制${label}`}
      >
        {copied ? "已复制" : "复制"}
      </button>
    </span>
  );
}

/* ---------------- 空态 / 错误 / 加载 ---------------- */

export function EmptyState({
  title,
  hint,
  action,
  icon = "◍",
}: {
  title: string;
  hint?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty__icon" aria-hidden="true">
        {icon}
      </span>
      <p className="empty__title">{title}</p>
      {hint ? <p className="empty__hint muted">{hint}</p> : null}
      {action ? <div className="empty__action">{action}</div> : null}
    </div>
  );
}

export interface ErrorInfo {
  title: string;
  message: string;
  recovery?: string;
  status?: number;
  requestId?: string;
}

export function describeError(error: unknown): ErrorInfo {
  const anyError = error as {
    name?: string;
    status?: number;
    code?: string;
    requestId?: string;
    message?: string;
  } | null;
  if (!error || !anyError) return { title: "未知错误", message: "没有可显示的错误信息。" };
  if (anyError.name === "TransportError") {
    return {
      title: "连不上后端",
      message: anyError.message ?? "请求未到达后端。",
      recovery:
        "确认后端已在 127.0.0.1:8000 启动（uvicorn ... --port 8000），或在地址后加 ?demo=1 查看离线演示数据。",
    };
  }
  if (anyError.name === "DemoReadOnlyError") {
    return {
      title: "离线演示数据只读",
      message: anyError.message ?? "该操作需要真实后端。",
      recovery: "启动后端后把地址里的 ?demo=1 去掉即可执行写操作。",
    };
  }
  if (typeof anyError.status === "number") {
    const status = anyError.status;
    const recovery =
      status === 404
        ? "刷新列表确认对象是否还存在。"
        : status === 409
          ? "状态或版本已变化：先刷新取到最新版本，再用新的幂等键重新提交；不要直接覆盖。"
          : status === 413
            ? "文件超过上传上限（默认 50 MiB，可由后端 UPLOAD_LIMIT_BYTES 调整）。"
            : status === 415
              ? "该格式不受支持：请改用 DOCX / XLSX / PDF / 文本等可解析格式，旧版 DOC 请先另存为 DOCX。"
              : status === 422
                ? "请求字段不符合接口约束，请检查必填项。"
                : status === 503
                  ? "后端尚未就绪（数据库迁移或模型配置未完成）。"
                  : undefined;
    return {
      title: status === 409 ? "版本或状态冲突" : status === 404 ? "对象不存在" : "请求失败",
      message: anyError.message ?? "后端返回了错误。",
      recovery,
      status,
      requestId: anyError.requestId,
    };
  }
  return { title: "出错了", message: anyError.message ?? String(error) };
}

export function ErrorNotice({
  error,
  onRetry,
  retryLabel = "重试",
  compact = false,
}: {
  error: unknown;
  onRetry?: () => void;
  retryLabel?: string;
  compact?: boolean;
}) {
  const info = describeError(error);
  return (
    <div className={cx("notice", compact && "notice--compact")} role="alert">
      <p className="notice__title">
        {info.title}
        {info.status ? <span className="notice__status mono">HTTP {info.status}</span> : null}
      </p>
      <p className="notice__message">{info.message}</p>
      {info.recovery ? <p className="notice__recovery muted">{info.recovery}</p> : null}
      <div className="notice__foot">
        {info.requestId ? <CopyId value={info.requestId} label="request_id" /> : null}
        {onRetry ? (
          <Button size="sm" variant="ghost" onClick={onRetry}>
            {retryLabel}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function Skeleton({ rows = 3, label = "正在读取" }: { rows?: number; label?: string }) {
  return (
    <div className="skeleton" role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, index) => (
        <span className="skeleton__row" key={index} aria-hidden="true" />
      ))}
    </div>
  );
}

/* ---------------- 折叠区 ---------------- */

export function Disclosure({
  summary,
  children,
  defaultOpen = false,
  count,
}: {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  count?: number;
}) {
  return (
    <details className="disclosure" open={defaultOpen}>
      <summary className="disclosure__summary">
        <span className="disclosure__marker" aria-hidden="true" />
        <span className="disclosure__label">{summary}</span>
        {typeof count === "number" ? <span className="disclosure__count ledger-num">{count}</span> : null}
      </summary>
      <div className="disclosure__body">{children}</div>
    </details>
  );
}
