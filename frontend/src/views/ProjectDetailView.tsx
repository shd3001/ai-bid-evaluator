/** 项目详情：投标人、材料回执、该项目的运行。 */
import { useState } from "react";
import { useSession, useToast } from "../app/session";
import { ApiError, type Run } from "../api/client";
import {
  Button,
  CopyId,
  DocumentStatusFlag,
  EmptyState,
  ErrorNotice,
  Panel,
  RunStatusChip,
  Skeleton,
} from "../components/core";
import { Labeled } from "../components/layout";
import { useAsync } from "../utils/useAsync";
import { formatRelative, RUN_TYPE_LABEL } from "../utils/format";
import { DOCUMENT_ROLE_LABEL } from "../utils/format";
import { href } from "../utils/router";
import { receiptsFor } from "../utils/uploads";

export function ProjectDetailView({ projectId }: { projectId: string }) {
  const { api, mode } = useSession();
  const { push } = useToast();
  const [bidderName, setBidderName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createdBidders, setCreatedBidders] = useState<Array<{ bidder_id: string; name: string }>>([]);
  const [receiptTick, setReceiptTick] = useState(0);

  const runs = useAsync(() => api.listRuns({ project_id: projectId, limit: 20 }), [api, projectId]);
  const receipts = receiptsFor(projectId);

  const createBidder = async (): Promise<void> => {
    const trimmed = bidderName.trim();
    if (!trimmed) return;
    setCreating(true);
    try {
      const created = await api.createBidder(projectId, trimmed);
      setCreatedBidders((list) => [...list, { bidder_id: created.bidder_id, name: created.name }]);
      setBidderName("");
      push({ tone: "success", message: `投标人已登记：${created.name}`, detail: `bidder_id ${created.bidder_id}` });
    } catch (error) {
      push({
        tone: "danger",
        message: error instanceof ApiError ? error.message : "登记投标人失败",
        detail: error instanceof ApiError ? `code ${error.code} · request_id ${error.requestId}` : undefined,
      });
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="view view--project">
      <header className="view__head">
        <div>
          <p className="micro muted">项目</p>
          <h1 className="view__title">项目详情</h1>
          <CopyId value={projectId} label="project_id" />
        </div>
        <div className="view__actions">
          <a className="btn btn--primary" href={href(`/projects/${projectId}/upload`)}>
            交材料
          </a>
          <a className="btn btn--default" href={href(`/runs/new`, { project_id: projectId })}>
            发起评审
          </a>
        </div>
      </header>

      <div className="grid grid--aside">
        <Panel eyebrow="材料" title="已提交材料" description="后端没有「列出项目材料」的接口，下面是本机上传回执；状态以服务器返回为准。">
          {receipts.length === 0 ? (
            <EmptyState
              title="本机还没有这个项目的上传回执"
              hint="如果你是刚打开这台机器，或换了浏览器，请到上传页重新上传，或直接用已知的 document_id 发起运行。"
              action={
                <a className="btn btn--default" href={href(`/projects/${projectId}/upload`)}>
                  去上传
                </a>
              }
            />
          ) : (
            <ul className="receipt-list" key={receiptTick}>
              {receipts.map((receipt) => (
                <li key={receipt.documentId} className="receipt">
                  <div className="receipt__main">
                    <span className="receipt__name" title={receipt.fileName}>
                      {receipt.fileName}
                    </span>
                    <span className="micro muted">
                      {DOCUMENT_ROLE_LABEL[receipt.role]} · {formatRelative(receipt.at)}
                      {receipt.bidderId ? ` · bidder ${receipt.bidderId}` : ""}
                    </span>
                  </div>
                  <CopyId value={receipt.documentId} label="document_id" />
                  <a className="link" href={href(`/documents/${receipt.documentId}`)}>
                    看解析
                  </a>
                </li>
              ))}
            </ul>
          )}
          <div className="panel__inline-actions">
            <Button size="sm" variant="ghost" onClick={() => setReceiptTick((value) => value + 1)}>
              重新读取回执
            </Button>
          </div>
        </Panel>

        <Panel
          eyebrow="投标人"
          title="登记投标人"
          description="只有 role = bid 的材料必须带 bidder_id；先在这里登记，再上传投标文件。"
        >
          <form
            className="form"
            onSubmit={(event) => {
              event.preventDefault();
              void createBidder();
            }}
          >
            <Labeled label="投标人名称" required hint="例如：某某科技有限公司">
              <input
                className="input"
                value={bidderName}
                onChange={(event) => setBidderName(event.target.value)}
                placeholder="输入投标人名称"
                maxLength={200}
                required
              />
            </Labeled>
            <div className="form__actions">
              <Button type="submit" variant="primary" busy={creating} disabled={mode === "demo" || !bidderName.trim()}>
                登记
              </Button>
            </div>
          </form>

          {createdBidders.length > 0 ? (
            <ul className="receipt-list">
              {createdBidders.map((bidder) => (
                <li key={bidder.bidder_id} className="receipt">
                  <div className="receipt__main">
                    <span className="receipt__name">{bidder.name}</span>
                  </div>
                  <CopyId value={bidder.bidder_id} label="bidder_id" />
                </li>
              ))}
            </ul>
          ) : (
            <p className="micro muted">
              后端没有"列出投标人"的接口，所以这里只显示本次会话中新建的投标人；请在登记后立刻复制 bidder_id。
            </p>
          )}
        </Panel>
      </div>

      <Panel
        eyebrow="运行"
        title="这个项目的运行"
        actions={
          <Button size="sm" variant="ghost" onClick={() => runs.reload()} busy={runs.loading}>
            刷新
          </Button>
        }
      >
        {runs.error ? <ErrorNotice error={runs.error} onRetry={runs.reload} /> : null}
        {!runs.error && runs.loading && !runs.data ? <Skeleton rows={3} /> : null}
        {runs.data && runs.data.items.length === 0 ? (
          <EmptyState
            title="这个项目还没有运行"
            hint="上传材料后点击「发起评审」。"
            action={
              <a className="btn btn--primary" href={href(`/runs/new`, { project_id: projectId })}>
                发起评审
              </a>
            }
          />
        ) : null}
        <ul className="runlist">
          {(runs.data?.items ?? []).map((run: Run) => (
            <li key={run.run_id}>
              <a className="runlist__item" href={href(`/runs/${run.run_id}`)}>
                <RunStatusChip run={run} />
                <span className="runlist__type">{RUN_TYPE_LABEL[run.type] ?? run.type}</span>
                <span className="runlist__id mono">{run.run_id}</span>
                <span className="micro muted">
                  版本 {run.revision ?? 1} · {formatRelative(run.created_at)}
                </span>
                {run.result_stale ? <DocumentStatusFlag status="needs_review" /> : null}
              </a>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
