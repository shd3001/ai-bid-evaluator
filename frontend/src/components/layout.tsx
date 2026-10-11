/** 分页与标签页：游标原样透传，前端不拼接、不猜总数。 */
import type { ReactNode } from "react";
import { cx } from "../utils/cx";
import { Button } from "./core";

export function Pagination({
  nextCursor,
  hasPrevious,
  onNext,
  onPrevious,
  count,
  loading,
  noun = "条",
}: {
  nextCursor: string | null | undefined;
  hasPrevious: boolean;
  onNext: () => void;
  onPrevious: () => void;
  count: number;
  loading?: boolean;
  noun?: string;
}) {
  return (
    <nav className="pager" aria-label="分页">
      <span className="pager__count micro muted">
        本页 <span className="ledger-num">{count}</span> {noun}
        {nextCursor ? "（还有下一页）" : "（已到末页）"}
      </span>
      <span className="pager__actions">
        <Button size="sm" variant="ghost" disabled={!hasPrevious || loading} onClick={onPrevious}>
          上一页
        </Button>
        <Button size="sm" variant="ghost" disabled={!nextCursor || loading} onClick={onNext}>
          下一页
        </Button>
      </span>
    </nav>
  );
}

export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: Array<{ id: T; label: string; badge?: ReactNode }>;
  active: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="tabs" role="tablist" aria-label="视图切换">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={tab.id === active}
          className={cx("tab", tab.id === active && "tab--active")}
          onClick={() => onChange(tab.id)}
        >
          <span>{tab.label}</span>
          {tab.badge !== undefined ? <span className="tab__badge ledger-num">{tab.badge}</span> : null}
        </button>
      ))}
    </div>
  );
}

/** 键值明细行：值可以是任意节点（比如数值 + 榫头）。 */
export function DetailList({
  items,
  columns = 1,
}: {
  items: Array<{ label: string; value: ReactNode; wide?: boolean }>;
  columns?: 1 | 2;
}) {
  return (
    <dl className={cx("details", columns === 2 && "details--2")}>
      {items.map((item) => (
        <div className={cx("details__row", item.wide && "details__row--wide")} key={item.label}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Labeled({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: ReactNode;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span className="field__label">
        {label}
        {required ? <span className="field__req" aria-hidden="true">*</span> : null}
      </span>
      {children}
      {hint ? <span className="field__hint micro muted">{hint}</span> : null}
    </label>
  );
}
