/** 报告：列出运行的报告版本，查看详情，导出 json / markdown / html。 */
import { useMemo, useState } from "react";
import { useSession, useToast } from "../app/session";
import { ApiError, type ReportResponse } from "../api/client";
import {
  Button,
  CopyId,
  Disclosure,
  EmptyState,
  ErrorNotice,
  Panel,
  Skeleton,
  StatusFlag,
} from "../components/core";
import { DetailList } from "../components/layout";
import { useAsync } from "../utils/useAsync";
import { shortId } from "../utils/format";
import { href, useQuery } from "../utils/router";
import { useJourney, refreshJourney } from '../app/journey';

type ExportFormat = "json" | "markdown" | "html";

const FORMATS: Array<{ id: ExportFormat; label: string; hint: string }> = [
  { id: "json", label: "JSON", hint: "结构化原始数据，交给其他系统。" },
  { id: "markdown", label: "Markdown", hint: "纯文本，便于贴进评审记录。" },
  { id: "html", label: "HTML", hint: "在新标签页打开，可直接打印存档。" },
];

export function ReportView({ runId }: { runId: string }) {
  const { api, mode } = useSession();
  const { push } = useToast();
  const query = useQuery();
  const journey = useJourney();
  const [selected, setSelected] = useState<string | null>(null);
  const [format, setFormat] = useState<ExportFormat>("json");
  const [exporting, setExporting] = useState(false);
  const [exportText, setExportText] = useState<{ reportId: string; format: ExportFormat; text: string } | null>(null);
  const [exportError, setExportError] = useState<unknown>(null);

  const list = useAsync(() => api.listReports(runId, { limit: 20 }), [api, runId]);
  const reports = list.data?.items ?? [];
  const activeId = selected ?? query.get('report_id') ?? journey.flow?.reportId ?? null;
  const detail = useAsync(() => (activeId === null ? null : api.getReport(activeId)), [api, activeId]);

  const report: ReportResponse | null = detail.data ?? null;
  const blocked = useMemo(() => {
    if (!report) return null;
    if (report.run_id !== runId) return '报告不属于当前运行，请重新选择。';
    if (report.stale) return "报告已过期（stale=true）：材料或评分在报告生成后发生了变化，后端会拒绝导出。";
    if (!report.confirmed) return "报告尚未确认：先完成人工复核，再导出。";
    return null;
  }, [report, runId]);

  const doExport = async (): Promise<void> => {
    if (!activeId || blocked) return;
    setExporting(true);
    setExportError(null);
    try {
      const text = await api.exportReport(String(activeId), format);
      if (format === "html") {
        const blob = new Blob([text], { type: "text/html;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        window.open(url, "_blank", "noopener,noreferrer");
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
        push({ tone: "success", message: "已在新标签页打开 HTML 报告", detail: "浏览器打开的是一份本地临时副本。" });
      } else {
        setExportText({ reportId: String(activeId), format, text });
        push({ tone: "success", message: `已取回 ${format} 导出内容`, detail: "内容原样来自后端，未在浏览器里改动。" });
      }
    } catch (cause) {
      setExportError(cause);
      if (cause instanceof ApiError && cause.status === 409) {
        push({
          tone: "danger",
          message: "后端拒绝导出（409）",
          detail: "只有「已确认且未过期」的报告可以下载；刷新后重试。",
        });
        detail.reload();
        list.reload();
        refreshJourney();
      }
    } finally {
      setExporting(false);
    }
  };

  const copy = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      push({ tone: "info", message: "已复制到剪贴板" });
    } catch {
      push({ tone: "danger", message: "复制失败", detail: "浏览器未授权剪贴板访问，请手动选择文本。" });
    }
  };

  return (
    <div className="view view--report">
      <header className="view__head">
        <div>
          <p className="micro muted">第五步</p>
          <h1 className="view__title">报告</h1>
          <p className="view__lead muted">
            报告是某个 revision 的快照。材料变化或复核改分之后，后端会把旧报告标成 stale 并拒绝导出——界面只如实转述这个判断。
          </p>
          <CopyId value={runId} label="run_id" />
        </div>
        <div className="view__actions">
          <a className="btn btn--default" href={href(`/runs/${runId}`)}>
            回进度页
          </a>
          <a className="btn btn--default" href={href(`/runs/${runId}/review`)}>
            人工复核
          </a>
          <a className="btn btn--default" href={href(`/runs/${runId}/conclusion`)}>
            结论评审卷
          </a>
        </div>
      </header>

      <Panel
        eyebrow="版本"
        title="报告清单"
        description="同一个运行可以有多份报告；每份对应一个 revision。"
        actions={
          <Button size="sm" variant="ghost" onClick={() => { list.reload(); refreshJourney(); }} busy={list.loading}>
            刷新
          </Button>
        }
      >
        {list.error ? <ErrorNotice error={list.error} onRetry={list.reload} /> : null}
        {!list.error && list.loading && !list.data ? <Skeleton rows={3} /> : null}
        {list.data && reports.length === 0 ? (
          <EmptyState
            title="还没有报告"
            hint="报告在运行成功并完成必要复核后由后端生成。先回到进度页确认运行状态。"
            action={
              <a className="btn btn--default" href={href(`/runs/${runId}`)}>
                回进度页
              </a>
            }
          />
        ) : null}

        <ul className="report-list">
          {reports.map((item) => (
            <li key={String(item.report_id)}>
              <button
                type="button"
                className={`report-pick ${String(activeId) === String(item.report_id) ? "report-pick--active" : ""}`}
                onClick={() => {
                  setSelected(String(item.report_id));
                  setExportText(null);
                  setExportError(null);
                }}
              >
                <span className="report-pick__id mono">report #{String(item.report_id)}</span>
                <span className="report-pick__meta micro muted">
                  revision <span className="ledger-num">{item.revision}</span> · run{" "}
                  <span className="mono">{shortId(item.run_id, 12)}</span>
                </span>
                <span className="report-pick__flags">
                  {item.confirmed ? (
                    <StatusFlag tone="pass">已确认</StatusFlag>
                  ) : (
                    <StatusFlag tone="review">未确认</StatusFlag>
                  )}
                  {item.stale ? <StatusFlag tone="fail">已过期</StatusFlag> : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </Panel>

      {activeId !== null ? (
        <Panel
          eyebrow="详情"
          title={`报告 #${String(activeId)}`}
          description="data 字段是自由形状，这里按后端给的结构如实展开。"
          actions={
            <Button size="sm" variant="ghost" onClick={detail.reload} busy={detail.loading}>
              重新加载
            </Button>
          }
        >
          {detail.error ? <ErrorNotice error={detail.error} onRetry={detail.reload} /> : null}
          {!detail.error && detail.loading && !report ? <Skeleton rows={4} /> : null}

          {report ? (
            <>
              <div className="flags">
                {report.confirmed ? (
                  <StatusFlag tone="pass">已确认（confirmed）</StatusFlag>
                ) : (
                  <StatusFlag tone="review">未确认（confirmed=false）</StatusFlag>
                )}
                {report.stale ? (
                  <StatusFlag tone="fail">已过期（stale=true）</StatusFlag>
                ) : (
                  <StatusFlag tone="seal">内容有效（stale=false）</StatusFlag>
                )}
              </div>

              <DetailList
                columns={2}
                items={[
                  { label: "report_id", value: <span className="mono">{String(report.report_id)}</span> },
                  { label: "run_id", value: <span className="mono">{shortId(report.run_id, 16)}</span> },
                  { label: "revision", value: <span className="ledger-num">{report.revision}</span> },
                ]}
              />

              {blocked ? <ErrorNotice error={new Error(blocked)} /> : null}

              <section className="export">
                <h3 className="section__title">导出</h3>
                <div className="formats" role="radiogroup" aria-label="导出格式">
                  {FORMATS.map((option) => (
                    <label
                      key={option.id}
                      className={`format ${format === option.id ? "format--active" : ""}`}
                    >
                      <input
                        type="radio"
                        name="export-format"
                        checked={format === option.id}
                        onChange={() => setFormat(option.id)}
                      />
                      <span className="format__label">{option.label}</span>
                      <span className="format__hint micro muted">{option.hint}</span>
                    </label>
                  ))}
                </div>
                <Button variant="primary" busy={exporting} disabled={Boolean(blocked) || mode === "demo"} onClick={() => void doExport()}>
                  导出 {format}
                </Button>
                {mode === "demo" ? <p className="micro muted">离线演示模式不会真的导出：导出属于写操作范围。</p> : null}
                {exportError ? <ErrorNotice error={exportError} onRetry={() => setExportError(null)} retryLabel="清除" compact /> : null}
              </section>

              {exportText && exportText.reportId === String(activeId) ? (
                <section className="export-result">
                  <div className="export-result__head">
                    <h3 className="section__title">已取回 {exportText.format}</h3>
                    <Button size="sm" onClick={() => void copy(exportText.text)}>
                      复制全文
                    </Button>
                  </div>
                  <pre className="raw-json">{exportText.text}</pre>
                </section>
              ) : null}

              <Disclosure summary="报告数据（后端原样）">
                <pre className="raw-json">{JSON.stringify(report.data, null, 2)}</pre>
              </Disclosure>
            </>
          ) : null}
        </Panel>
      ) : null}
    </div>
  );
}
