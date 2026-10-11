/** 材料解析详情：文件身份、诊断、分块原文（证据榫跳转的落点）。 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "../app/session";
import type { DocumentChunk } from "../api/client";
import {
  Button,
  CopyId,
  Disclosure,
  DocumentStatusFlag,
  EmptyState,
  ErrorNotice,
  Panel,
  Skeleton,
  StatusFlag,
} from "../components/core";
import { DetailList, Pagination } from "../components/layout";
import { useAsync } from "../utils/useAsync";
import { DOCUMENT_ROLE_LABEL, evidenceLocator, formatDateTime, shortId } from "../utils/format";
import { href, useQuery } from "../utils/router";

const PAGE_SIZE = 50;
/** 自动续拉上限：足够跨过几百页，同时避免无意义的长轮询。 */
const MAX_AUTO_PAGES = 40;

export function DocumentView({ documentId }: { documentId: string }) {
  const { api } = useSession();
  const query = useQuery();
  const anchor = query.get("chunk");

  const [cursors, setCursors] = useState<string[]>([]);
  const [pageIndex, setPageIndex] = useState(0);
  const [pages, setPages] = useState(1);
  const [autoPaging, setAutoPaging] = useState(Boolean(anchor));
  const highlightRef = useRef<HTMLLIElement | null>(null);

  const doc = useAsync(() => api.getDocument(documentId), [api, documentId]);
  const chunks = useAsync(
    () => api.listChunks(documentId, { limit: PAGE_SIZE, cursor: cursors[pageIndex] ?? null }),
    [api, documentId, pageIndex, cursors],
  );

  const items = useMemo(() => chunks.data?.items ?? [], [chunks.data]);
  const nextCursor = chunks.data?.next_cursor ?? null;
  const found = anchor ? items.some((chunk) => chunk.chunk_id === anchor) : false;

  // 证据榫跳进来时，目标块可能不在第一页——按需继续翻页直到找到或到末页。
  useEffect(() => {
    if (!anchor || found || !autoPaging || chunks.loading) return;
    if (!nextCursor) {
      setAutoPaging(false);
      return;
    }
    if (pages >= MAX_AUTO_PAGES) {
      setAutoPaging(false);
      return;
    }
    setCursors((current) => {
      const copy = [...current];
      copy[pageIndex + 1] = nextCursor;
      return copy;
    });
    setPages((value) => value + 1);
    setPageIndex((value) => value + 1);
  }, [anchor, found, autoPaging, chunks.loading, nextCursor, pages, pageIndex]);

  useEffect(() => {
    if (!anchor || !found) return;
    const node = highlightRef.current;
    if (!node) return;
    node.scrollIntoView({ block: "center", behavior: "smooth" });
    node.focus({ preventScroll: true });
  }, [anchor, found, pageIndex]);

  const detail = doc.data;

  return (
    <div className="view view--document">
      <header className="view__head">
        <div>
          <p className="micro muted">材料</p>
          <h1 className="view__title">解析详情</h1>
          <p className="view__lead muted">
            这里是证据引用的落点：每条结论都能对到下面的某一块原文，按{" "}
            <code className="mono">chunk_id</code> 定位，而不是按文件名。
          </p>
          <CopyId value={documentId} label="document_id" />
        </div>
        {detail ? (
          <div className="view__actions">
            <a className="btn btn--default" href={href(`/projects/${detail.project_id}`)}>
              回项目
            </a>
            <a className="btn btn--default" href={href(`/projects/${detail.project_id}/upload`)}>
              继续交材料
            </a>
          </div>
        ) : null}
      </header>

      <Panel eyebrow="文件" title="材料信息">
        {doc.error ? <ErrorNotice error={doc.error} onRetry={doc.reload} /> : null}
        {!doc.error && doc.loading && !detail ? <Skeleton rows={3} /> : null}
        {detail ? (
          <>
            <div className="flags">
              <DocumentStatusFlag status={detail.status} />
              <StatusFlag tone="seal">{DOCUMENT_ROLE_LABEL[detail.role] ?? detail.role}</StatusFlag>
              {detail.bidder_id ? <StatusFlag tone="pending">投标人 {shortId(detail.bidder_id, 10)}</StatusFlag> : null}
            </div>
            <DetailList
              columns={2}
              items={[
                { label: "document_id", value: <span className="mono">{detail.document_id}</span> },
                { label: "document_hash", value: <span className="mono">{shortId(detail.document_hash, 24)}</span> },
                { label: "格式 / 解析器", value: `${detail.format} · ${detail.parser}` },
                { label: "分块数", value: <span className="ledger-num">{detail.chunk_count}</span> },
                { label: "project_id", value: <span className="mono">{shortId(detail.project_id, 16)}</span> },
                { label: "bidder_id", value: detail.bidder_id ? <span className="mono">{shortId(detail.bidder_id, 16)}</span> : "—" },
              ]}
            />
            {detail.diagnostics && Object.keys(detail.diagnostics).length > 0 ? (
              <Disclosure summary="解析诊断（后端给出）" defaultOpen={detail.status !== "ready"}>
                <pre className="raw-json">{JSON.stringify(detail.diagnostics, null, 2)}</pre>
              </Disclosure>
            ) : null}
          </>
        ) : null}
      </Panel>

      <Panel
        eyebrow="原文"
        title="分块"
        description={`每页最多 ${PAGE_SIZE} 块，游标分页；游标来自后端，界面不自己算。`}
        actions={
          <Button size="sm" variant="ghost" onClick={chunks.reload} busy={chunks.loading}>
            刷新
          </Button>
        }
      >
        {anchor && !found ? (
          <p className="micro muted">
            正在定位 <code className="mono">{shortId(anchor, 12)}</code>…
            {autoPaging ? "（自动继续翻页）" : "（已翻到末页仍未找到该块）"}
          </p>
        ) : null}
        {chunks.error ? <ErrorNotice error={chunks.error} onRetry={chunks.reload} /> : null}
        {!chunks.error && chunks.loading && !chunks.data ? <Skeleton rows={6} label="正在读取分块" /> : null}
        {chunks.data && items.length === 0 ? (
          <EmptyState title="这份材料没有分块" hint="解析可能失败或文件为空；先看上面的解析状态与诊断。" />
        ) : null}

        <ol className="chunks">
          {items.map((chunk) => (
            <ChunkCard
              key={chunk.chunk_id}
              chunk={chunk}
              highlighted={anchor === chunk.chunk_id}
              ref={anchor === chunk.chunk_id ? highlightRef : undefined}
            />
          ))}
        </ol>

        <Pagination
          count={items.length}
          nextCursor={nextCursor}
          hasPrevious={pageIndex > 0}
          loading={chunks.loading}
          noun="块原文"
          onNext={() => {
            if (!nextCursor) return;
            setAutoPaging(false);
            setCursors((current) => {
              const copy = [...current];
              copy[pageIndex + 1] = nextCursor;
              return copy;
            });
            setPages((value) => value + 1);
            setPageIndex((value) => value + 1);
          }}
          onPrevious={() => {
            setAutoPaging(false);
            setPageIndex((value) => Math.max(0, value - 1));
          }}
        />
        <p className="micro muted">
          需要别的页时用上面的分页按钮；证据榫跳转的目标块会在这里高亮（当前锚点：
          {anchor ? <code className="mono">{shortId(anchor, 12)}</code> : "无"}）。
        </p>
      </Panel>
    </div>
  );
}

function ChunkCard({
  chunk,
  highlighted,
  ref,
}: {
  chunk: DocumentChunk;
  highlighted: boolean;
  ref?: React.Ref<HTMLLIElement>;
}) {
  const locator = evidenceLocator({
    chunk_id: chunk.chunk_id,
    page: chunk.page ?? null,
    sheet: chunk.sheet ?? null,
    row_start: chunk.row_start ?? null,
    row_end: chunk.row_end ?? null,
  });
  return (
    <li
      ref={ref}
      tabIndex={-1}
      id={`chunk-${chunk.chunk_id}`}
      data-chunk-id={chunk.chunk_id}
      className={`chunk ${highlighted ? "chunk--target" : ""}`}
    >
      <header className="chunk__head">
        <span className="chunk__locator">{locator}</span>
        <span className="chunk__id mono">{chunk.chunk_id}</span>
        {chunk.quality === "needs_review" ? <StatusFlag tone="review">解析质量待核对</StatusFlag> : null}
      </header>
      <p className="chunk__text">{chunk.text}</p>
      <footer className="chunk__foot micro muted">
        文档 {shortId(chunk.document_id, 10)} · 哈希 {shortId(chunk.document_hash, 10)}
        {chunk.column_start !== undefined && chunk.column_start !== null
          ? ` · 列 ${chunk.column_start}–${chunk.column_end ?? "?"}`
          : ""}
      </footer>
    </li>
  );
}

/** 供其它视图复用的时间戳说明（避免各处自己解释时间）。 */
export function updatedAt(timestamp: string | null | undefined): string {
  return timestamp ? formatDateTime(timestamp) : "—";
}
