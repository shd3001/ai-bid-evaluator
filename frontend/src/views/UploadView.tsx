/** 交材料：上传 + 角色 + 投标人，并对超限做后端权威提示。 */
import { useMemo, useRef, useState } from "react";
import { useSession, useToast } from "../app/session";
import { type DocRole } from "../api/client";
import {
  Button,
  CopyId,
  ErrorNotice,
  Panel,
  StatusFlag,
} from "../components/core";
import { Labeled } from "../components/layout";
import { DOCUMENT_ROLE_LABEL } from "../utils/format";
import { href } from "../utils/router";
import { rememberReceipt, receiptsFor } from "../utils/uploads";

/** 后端默认上限 50 MiB（UPLOAD_LIMIT_BYTES 可调）；这里只用来提前提醒，判定以后端 413 为准。 */
const SOFT_LIMIT_BYTES = 50 * 1024 * 1024;

const ROLES: DocRole[] = ["announcement", "tender", "bid", "profile"];

const ROLE_HINT: Record<DocRole, string> = {
  announcement: "招标公告：用于机会筛选与公告比对。",
  tender: "招标文件：评审规则与资格条件的来源。",
  bid: "投标文件：必须绑定一个 bidder_id，否则会被 422 拒绝。",
  profile: "企业画像材料：营业执照、资质、业绩等。",
};

const ACCEPT = ".docx,.xlsx,.xlsm,.pdf,.txt,.md,.csv,.json,.html,.htm";

export function UploadView({ projectId }: { projectId: string }) {
  const { api, mode } = useSession();
  const { push } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [role, setRole] = useState<DocRole>("bid");
  const [file, setFile] = useState<File | null>(null);
  const [bidderId, setBidderId] = useState("");
  const [bidderName, setBidderName] = useState("");
  const [registering, setRegistering] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [tick, setTick] = useState(0);

  const receipts = useMemo(() => receiptsFor(projectId), [projectId, tick]);
  const tooBig = file !== null && file.size > SOFT_LIMIT_BYTES;
  const needsBidder = role === "bid";

  const registerBidder = async (): Promise<void> => {
    const trimmed = bidderName.trim();
    if (!trimmed) return;
    setRegistering(true);
    try {
      const created = await api.createBidder(projectId, trimmed);
      setBidderId(created.bidder_id);
      setBidderName("");
      push({ tone: "success", message: `已登记并填入 bidder_id：${created.name}` });
    } catch (cause) {
      setError(cause);
    } finally {
      setRegistering(false);
    }
  };

  const submit = async (): Promise<void> => {
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const document = await api.uploadDocument({
        projectId,
        role,
        file,
        bidderId: needsBidder ? bidderId.trim() || null : null,
      });
      rememberReceipt({
        documentId: document.document_id,
        projectId,
        fileName: file.name,
        role,
        bidderId: document.bidder_id ?? null,
        at: new Date().toISOString(),
      });
      setTick((value) => value + 1);
      push({
        tone: "success",
        message: `已提交：${file.name}`,
        detail: `document_id ${document.document_id} · 解析状态 ${document.status}`,
      });
      setFile(null);
      if (inputRef.current) inputRef.current.value = "";
    } catch (cause) {
      setError(cause);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="view view--upload">
      <header className="view__head">
        <div>
          <p className="micro muted">第二步</p>
          <h1 className="view__title">交材料</h1>
          <p className="view__lead muted">
            材料按角色提交。上传成功不等于可用：解析结果（ready / needs_review / failed）由后端给出，需要核对的材料必须先处理。
          </p>
          <CopyId value={projectId} label="project_id" />
        </div>
        <div className="view__actions">
          <a className="btn btn--default" href={href(`/projects/${projectId}`)}>
            回项目
          </a>
          <a className="btn btn--primary" href={href("/runs/new", { project_id: projectId })}>
            下一步：发起评审
          </a>
        </div>
      </header>

      <div className="grid grid--aside">
        <Panel eyebrow="上传" title="提交一份材料">
          <form
            className="form"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <fieldset className="fieldset">
              <legend className="field__label">材料角色</legend>
              <div className="roles">
                {ROLES.map((item) => (
                  <label key={item} className={`role ${role === item ? "role--active" : ""}`}>
                    <input
                      type="radio"
                      name="role"
                      value={item}
                      checked={role === item}
                      onChange={() => setRole(item)}
                    />
                    <span className="role__label">{DOCUMENT_ROLE_LABEL[item]}</span>
                    <span className="role__hint micro muted">{ROLE_HINT[item]}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            {needsBidder ? (
              <div className="bidder-picker">
                <Labeled
                  label="投标人 bidder_id"
                  required
                  hint="投标文件必须绑定投标人。可以从项目页登记后复制，也可以在这里现场登记。"
                >
                  <input
                    className="input mono"
                    value={bidderId}
                    onChange={(event) => setBidderId(event.target.value)}
                    placeholder="粘贴 bidder_id"
                    required
                  />
                </Labeled>
                <div className="inline-register">
                  <input
                    className="input"
                    value={bidderName}
                    aria-label="现场登记的投标人名称"
                    onChange={(event) => setBidderName(event.target.value)}
                    placeholder="或输入投标人名称现场登记"
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    busy={registering}
                    disabled={mode === "demo" || !bidderName.trim()}
                    onClick={() => void registerBidder()}
                  >
                    登记并填入
                  </Button>
                </div>
              </div>
            ) : null}

            <Labeled
              label="文件"
              required
              hint={`默认上限 50 MiB。可解析格式：DOCX / XLSX / PDF / 文本；旧版 DOC 会被拒绝（415）。`}
            >
              <input
                ref={inputRef}
                className="input input--file"
                type="file"
                accept={ACCEPT}
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                required
              />
            </Labeled>

            {file ? (
              <p className="file-note micro muted">
                {file.name} · {(file.size / 1024 / 1024).toFixed(2)} MiB
                {tooBig ? "（超过默认上限，后端会以 413 拒绝）" : ""}
              </p>
            ) : null}
            {tooBig ? <StatusFlag tone="review">文件超过默认 50 MiB：仍可提交，最终判定以后端为准</StatusFlag> : null}

            <div className="form__actions">
              <Button
                type="submit"
                variant="primary"
                busy={uploading}
                disabled={mode === "demo" || !file || (needsBidder && !bidderId.trim())}
              >
                上传
              </Button>
              {mode === "demo" ? <span className="micro muted">离线演示模式下不可写入</span> : null}
            </div>
            {error ? <ErrorNotice error={error} onRetry={() => setError(null)} retryLabel="清除提示" compact /> : null}
          </form>
        </Panel>

        <Panel
          eyebrow="本机回执"
          title="这个项目本次提交的"
          description="后端没有「列出项目材料」的接口；下面只是本机记录，用于找回 document_id。"
          actions={
            <Button size="sm" variant="ghost" onClick={() => setTick((value) => value + 1)}>
              刷新
            </Button>
          }
        >
          {receipts.length === 0 ? (
            <p className="muted">还没有上传记录。</p>
          ) : (
            <ul className="receipt-list">
              {receipts.map((receipt) => (
                <li key={receipt.documentId} className="receipt">
                  <div className="receipt__main">
                    <span className="receipt__name">{receipt.fileName}</span>
                    <span className="micro muted">{DOCUMENT_ROLE_LABEL[receipt.role]}</span>
                  </div>
                  <CopyId value={receipt.documentId} label="document_id" />
                  <a className="link" href={href(`/documents/${receipt.documentId}`)}>
                    看解析
                  </a>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel eyebrow="提示" title="材料与报告的关系" tone="quiet">
        <ul className="bullets">
          <li>替换材料或改分会让已有报告过期：界面上的 stale 标记与 confirmed 状态都由后端返回，这里不会自行推断。</li>
          <li>文档角色决定它参与哪一步：公告用于机会筛选，招标文件提供规则，投标文件提供证据，企业画像材料补充主体信息。</li>
          <li>上传成功后请复制 document_id：运行创建时需要它来指定参与本次评审的材料。</li>
        </ul>
      </Panel>
    </div>
  );
}
