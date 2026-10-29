/** 发起评审：提交 POST /runs（必须带幂等键）。 */
import { useState } from "react";
import { useSession, useToast } from "../app/session";
import { ApiError, type Run, type RunCreate } from "../api/client";
import { Button, CopyId, ErrorNotice, Panel, StatusFlag } from "../components/core";
import { Labeled } from "../components/layout";
import { prepareRunSubmission, clearRunSubmission } from "../utils/runSubmission";
import { href, navigate, useQuery } from "../utils/router";
import { receiptsFor } from "../utils/uploads";

export function RunCreateView() {
  const { api } = useSession();
  const query = useQuery();
  const { push } = useToast();

  const projectIdFromQuery = query.get("project_id") ?? "";
  const [runType, setRunType] = useState<RunCreate["type"]>("bid_evaluation");
  const [projectId, setProjectId] = useState(projectIdFromQuery);
  const [selected, setSelected] = useState<string[]>([]);
  const [companyId, setCompanyId] = useState("");
  const [queries, setQueries] = useState("");
  const [regions, setRegions] = useState("");
  const [minBudget, setMinBudget] = useState("");
  const [maxBudget, setMaxBudget] = useState("");
  const [maxCandidates, setMaxCandidates] = useState("5");
  const [extraIds, setExtraIds] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const receipts = receiptsFor(projectId.trim());
  const extraList = extraIds
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  const documentIds = Array.from(new Set([...selected, ...extraList]));

  const buildBody = (): RunCreate => {
    const body: RunCreate = {
      type: runType,
      project_id: projectId.trim(),
      document_ids: documentIds,
    };
    if (runType === "opportunity_discovery") {
      if (companyId.trim()) body.company_id = companyId.trim();
      body.options = {
        queries: queries
          .split(/[\n,;]+/)
          .map((item) => item.trim())
          .filter(Boolean),
        regions: regions
          .split(/[\s,;]+/)
          .map((item) => item.trim())
          .filter(Boolean),
        min_budget: minBudget.trim() || null,
        max_budget: maxBudget.trim() || null,
        max_candidates: Number(maxCandidates) || 5,
      };
    }
    return body;
  };

  const submit = async (): Promise<void> => {
    const body = buildBody();
    setSubmitting(true);
    setError(null);
    // 幂等键绑定"这次内容"：内容没变时网络重试复用同一个键，内容变了自动换键。
    const scope = `runs.create.${body.project_id}`;
    try {
      const submission = await prepareRunSubmission(api, scope, body);
      const run: Run = await api.createRun(submission.body, submission.key);
      clearRunSubmission(scope);
      push({
        tone: "success",
        message: "运行已提交",
        detail: `run_id ${run.run_id} · 状态 ${run.status ?? "pending"}（API 不自动启动 worker，需要 worker 进程在跑）`,
      });
      navigate(`/runs/${run.run_id}`);
    } catch (cause) {
      setError(cause);
      if (cause instanceof ApiError && cause.isConflict) {
        clearRunSubmission(scope);
        push({
          tone: "danger",
          message: "提交与已有运行冲突（409）",
          detail: "请求被拒绝，未覆盖已有结果。请核对内容；再次提交时会读取最新企业版本并使用新键。",
        });
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="view view--runcreate">
      <header className="view__head">
        <div>
          <p className="micro muted">第三步</p>
          <h1 className="view__title">发起评审</h1>
          <p className="view__lead muted">
            提交只做两件事：指定用哪些材料、以及要不要附加机会筛选条件。规则、分值、资格都在后端跑。
          </p>
        </div>
      </header>

      <div className="grid grid--aside">
        <Panel eyebrow="提交" title="运行参数">
          <form
            className="form"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <fieldset className="fieldset">
              <legend className="field__label">运行类型</legend>
              <div className="roles">
                <label className={`role ${runType === "bid_evaluation" ? "role--active" : ""}`}>
                  <input
                    type="radio"
                    name="runtype"
                    checked={runType === "bid_evaluation"}
                    onChange={() => setRunType("bid_evaluation")}
                  />
                  <span className="role__label">投标评审</span>
                  <span className="role__hint micro muted">
                    对投标文件逐条核对资格、逐项评分，并生成待复核项。
                  </span>
                </label>
                <label className={`role ${runType === "opportunity_discovery" ? "role--active" : ""}`}>
                  <input
                    type="radio"
                    name="runtype"
                    checked={runType === "opportunity_discovery"}
                    onChange={() => setRunType("opportunity_discovery")}
                  />
                  <span className="role__label">机会发现</span>
                  <span className="role__hint micro muted">
                    按关键词/地区/预算筛选公告候选，逐条给出依据。
                  </span>
                </label>
              </div>
            </fieldset>

            <Labeled label="project_id" required hint={projectIdFromQuery ? '当前项目已固定；如需切换，请返回项目台选择其他项目。' : '要评审的项目。可从项目页复制。'}>
              <input
                className="input mono"
                value={projectId}
                readOnly={Boolean(projectIdFromQuery)}
                onChange={(event) => setProjectId(event.target.value)}
                placeholder="project_id"
                required
              />
            </Labeled>

            <Labeled
              label="参与运行的材料（document_ids）"
              hint="请勾选或填写本次材料；后端不会自动挑选。只有复用已确认企业画像的机会任务可以不选材料。"
            >
              {receipts.length > 0 ? (
                <ul className="pick-list">
                  {receipts.map((receipt) => (
                    <li key={receipt.documentId}>
                      <label className="pick">
                        <input
                          type="checkbox"
                          checked={selected.includes(receipt.documentId)}
                          onChange={(event) =>
                            setSelected((current) =>
                              event.target.checked
                                ? [...current, receipt.documentId]
                                : current.filter((id) => id !== receipt.documentId),
                            )
                          }
                        />
                        <span className="pick__name">{receipt.fileName}</span>
                        <span className="pick__id mono micro">{receipt.documentId}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="micro muted">本机没有该项目的上传回执，可直接粘贴 document_id。</p>
              )}
              <textarea
                className="input input--area mono"
                rows={2}
                value={extraIds}
                onChange={(event) => setExtraIds(event.target.value)}
                placeholder="也可以直接粘贴一个或多个 document_id，用空格或逗号分隔"
              />
            </Labeled>

            {runType === "opportunity_discovery" ? (
              <fieldset className="fieldset">
                <legend className="field__label">机会筛选条件（可留空）</legend>
                <Labeled label="关键词" hint="每行一个，或逗号分隔">
                  <textarea
                    className="input input--area"
                    rows={3}
                    value={queries}
                    onChange={(event) => setQueries(event.target.value)}
                    placeholder={"智慧园区\n数据中心"}
                  />
                </Labeled>
                <Labeled label="地区">
                  <input
                    className="input"
                    value={regions}
                    onChange={(event) => setRegions(event.target.value)}
                    placeholder="例如：上海 江苏"
                  />
                </Labeled>
                <div className="row gap">
                  <Labeled label="预算下限">
                    <input
                      className="input ledger-num"
                      value={minBudget}
                      onChange={(event) => setMinBudget(event.target.value)}
                      placeholder="十进制字符串，如 1000000.00"
                    />
                  </Labeled>
                  <Labeled label="预算上限">
                    <input
                      className="input ledger-num"
                      value={maxBudget}
                      onChange={(event) => setMaxBudget(event.target.value)}
                      placeholder="十进制字符串"
                    />
                  </Labeled>
                  <Labeled label="候选上限" hint="1–100">
                    <input
                      className="input ledger-num"
                      type="number"
                      min={1}
                      max={100}
                      value={maxCandidates}
                      onChange={(event) => setMaxCandidates(event.target.value)}
                    />
                  </Labeled>
                </div>
                <Labeled label="company_id（可选）" hint="带上企业画像时，机会评估会参考企业资质。">
                  <input
                    className="input mono"
                    value={companyId}
                    onChange={(event) => setCompanyId(event.target.value)}
                    placeholder="company_id"
                  />
                </Labeled>
              </fieldset>
            ) : null}

            <div className="form__actions">
              <Button type="submit" variant="primary" busy={submitting} disabled={!projectId.trim()}>
                提交运行
              </Button>
            </div>
            {error ? <ErrorNotice error={error} onRetry={() => setError(null)} retryLabel="清除提示" compact /> : null}
          </form>
        </Panel>

        <div className="stack-6">
          <Panel eyebrow="将提交" title="请求预览" tone="quiet">
            <pre className="raw-json">{JSON.stringify(buildBody(), null, 2)}</pre>
            <p className="micro muted">
              请求会带一个 Idempotency-Key：同一次提交重试复用同一个键；内容改变会自动换新键。
            </p>
          </Panel>
          <Panel eyebrow="提醒" title="两个常见坑" tone="quiet">
            <ul className="bullets">
              <li>API 不会自动启动 worker：提交后状态可能长时间停在 pending，需要有 worker 进程在跑。</li>
              <li>复核与改分会让旧报告 stale；报告是否可导出由后端判定（未确认或已过期会返回 409）。</li>
            </ul>
            <div className="row gap">
              <a className="btn btn--ghost btn--sm" href={href("/about")}>
                看离线与运行说明
              </a>
            </div>
          </Panel>
          {projectId.trim() ? <CopyId value={projectId.trim()} label="project_id" /> : null}
          {runType === "opportunity_discovery" && companyId.trim() ? (
            <CopyId value={companyId.trim()} label="company_id" />
          ) : null}
          <StatusFlag tone="pending">提交后进入进度页，自动刷新 2 秒 / 后台 10 秒</StatusFlag>
        </div>
      </div>
    </div>
  );
}
