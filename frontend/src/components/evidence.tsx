/**
 * 证据榫：本设计的签名元素。
 * 一条结论旁边伸出的小榫头，钉住它来自哪份材料的哪一处原文。
 * 三态：有证据（实线）/ 证据不足（虚线，需人工核对）/ 缺证据（断口）。
 * 点击后右侧开证据抽屉，按 chunk_id 定位并高亮。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { cx } from "../utils/cx";
import { evidenceLocator, quotePreview } from "../utils/format";
import type { ApiClient, DocumentChunk, EvidenceRef } from "../api/client";
import { Button, ErrorNotice, Skeleton } from "./core";

export interface EvidenceFocus {
  ref: EvidenceRef;
  label?: string;
  needsReview?: boolean;
}

interface EvidenceContextValue {
  focus: EvidenceFocus | null;
  setFocus: (focus: EvidenceFocus | null) => void;
}

const EvidenceContext = createContext<EvidenceContextValue | null>(null);

export function EvidenceProvider({ children }: { children: ReactNode }) {
  const [focus, setFocus] = useState<EvidenceFocus | null>(null);
  const value = useMemo(() => ({ focus, setFocus }), [focus]);
  return <EvidenceContext.Provider value={value}>{children}</EvidenceContext.Provider>;
}

export function useEvidenceFocus(): EvidenceContextValue {
  const value = useContext(EvidenceContext);
  if (!value) throw new Error("useEvidenceFocus 必须在 EvidenceProvider 内使用");
  return value;
}

export function EvidenceTenon({
  refs,
  label,
  needsReview = false,
  compact = false,
}: {
  refs: EvidenceRef[] | null | undefined;
  label?: string;
  /** 后端把该项标为需要人工核对时，榫头画成虚线并显示提示。 */
  needsReview?: boolean;
  compact?: boolean;
}) {
  const { setFocus } = useEvidenceFocus();
  const list = refs ?? [];
  const first = list[0];

  if (!first) {
    return (
      <span
        className={cx("tenon", "tenon--missing", compact && "tenon--compact")}
        title="后端未给出证据引用：该结论无法回溯到原文，不能直接采信。"
        data-state="missing"
      >
        <span className="tenon__tongue" aria-hidden="true" />
        <span className="tenon__glyph" aria-hidden="true">
          ⌁
        </span>
        <span className="tenon__text">缺证据</span>
      </span>
    );
  }

  const locator = evidenceLocator(first);
  const more = list.length > 1 ? `+${list.length - 1}` : null;

  return (
    <button
      type="button"
      className={cx("tenon", needsReview && "tenon--weak", compact && "tenon--compact")}
      data-state={needsReview ? "weak" : "ok"}
      onClick={() => setFocus({ ref: first, label })}
      title={`${locator}：${first.quote}`}
      aria-label={`查看证据：${locator}${more ? `，另有 ${list.length - 1} 处` : ""}`}
    >
      <span className="tenon__tongue" aria-hidden="true" />
      <span className="tenon__glyph" aria-hidden="true">
        ⌗
      </span>
      <span className="tenon__locator">{locator}</span>
      <span className="tenon__quote">{quotePreview(first.quote, compact ? 12 : 20)}</span>
      {more ? <span className="tenon__more ledger-num">{more}</span> : null}
      {needsReview ? <span className="tenon__warn micro">待核对</span> : null}
    </button>
  );
}

/** 多引用版：一行小榫头，逐个可点。 */
export function EvidenceTenonRow({ refs }: { refs: EvidenceRef[] | null | undefined }) {
  const { setFocus } = useEvidenceFocus();
  const list = refs ?? [];
  if (list.length === 0) return <EvidenceTenon refs={list} />;
  return (
    <span className="tenon-row">
      {list.map((ref, index) => (
        <button
          type="button"
          key={`${ref.chunk_id}-${index}`}
          className="tenon tenon--slim"
          onClick={() => setFocus({ ref })}
          title={ref.quote}
        >
          <span className="tenon__tongue" aria-hidden="true" />
          <span className="tenon__locator">{evidenceLocator(ref)}</span>
        </button>
      ))}
    </span>
  );
}

const PAGE_SIZE = 50;

export function EvidenceDrawer({ api }: { api: ApiClient }) {
  const { focus, setFocus } = useEvidenceFocus();
  const [pages, setPages] = useState<DocumentChunk[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const documentId = focus?.ref.document_id ?? null;

  const loadPage = useCallback(
    async (cursor: string | null) => {
      if (!documentId) return;
      setLoading(true);
      try {
        const page = await api.listChunks(documentId, { limit: PAGE_SIZE, cursor });
        setPages((current) => (cursor ? [...current, ...page.items] : page.items));
        setNextCursor(page.next_cursor ?? null);
        setError(null);
      } catch (cause) {
        setError(cause);
      } finally {
        setLoading(false);
      }
    },
    [api, documentId],
  );

  useEffect(() => {
    setPages([]);
    setNextCursor(null);
    setError(null);
    if (documentId) void loadPage(null);
  }, [documentId, loadPage]);

  // 目标块可能在后续分页里：当前页找不到就继续往后拉，最多 600 块。
  useEffect(() => {
    if (!focus || loading) return;
    const found = pages.some((chunk) => chunk.chunk_id === focus.ref.chunk_id);
    if (found || !nextCursor || pages.length >= 600) return;
    void loadPage(nextCursor);
  }, [focus, pages, nextCursor, loading, loadPage]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFocus(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setFocus]);

  const target = focus?.ref.chunk_id;
  useEffect(() => {
    if (!target) return;
    const node = document.querySelector<HTMLElement>(`[data-chunk-id="${CSS.escape(target)}"]`);
    node?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [target, pages.length]);

  if (!focus) return null;
  const ref = focus.ref;

  return (
    <aside className="drawer" aria-label="证据原文">
      <div className="drawer__panel">
        <header className="drawer__head">
          <div>
            <p className="micro muted">{focus.label ?? "证据原文"}</p>
            <h3 className="drawer__title">{evidenceLocator(ref)}</h3>
          </div>
          <Button size="sm" variant="ghost" onClick={() => setFocus(null)} aria-label="关闭证据抽屉（Esc）">
            Esc 关闭
          </Button>
        </header>

        <figure className="quote">
          <blockquote>{ref.quote}</blockquote>
          <figcaption className="micro muted">
            document_id {ref.document_id} · document_hash {ref.document_hash.slice(0, 12)}…
            {ref.chunk_id ? ` · chunk_id ${ref.chunk_id}` : ""}
          </figcaption>
        </figure>

        <div className="drawer__body">
          {error ? <ErrorNotice error={error} onRetry={() => void loadPage(null)} compact /> : null}
          {!error && pages.length === 0 && loading ? <Skeleton rows={4} label="正在读取文档分块" /> : null}
          {!error && pages.length === 0 && !loading ? (
            <p className="muted">这份材料的解析分块暂不可读；结论仍以后端结果为准。</p>
          ) : null}
          {pages.map((chunk) => (
            <article
              key={chunk.chunk_id}
              data-chunk-id={chunk.chunk_id}
              className={cx("chunk", chunk.chunk_id === ref.chunk_id && "chunk--hit")}
            >
              <header className="chunk__head micro">
                <span>{evidenceLocator(chunk)}</span>
                {chunk.quality === "needs_review" ? <span className="chunk__warn">解析质量待核对</span> : null}
              </header>
              <p className="chunk__text">{chunk.text}</p>
            </article>
          ))}
          {nextCursor && pages.length < 600 ? (
            <Button variant="ghost" size="sm" busy={loading} onClick={() => void loadPage(nextCursor)}>
              继续读取后续分块
            </Button>
          ) : null}
        </div>
      </div>
    </aside>
  );
}
