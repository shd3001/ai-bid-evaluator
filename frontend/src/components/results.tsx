/**
 * 后端结果的"结构化视图"层。
 *
 * EvaluationResponse.data 在 OpenAPI 里是自由形状的 object（后端 §4 明确数值规则由后端计算）。
 * 因此这里只做**形状识别 + 原样渲染**：识别出哪些键是资格结果 / 评分结果 / 机会评估 / 公告候选，
 * 找不到就原样把 JSON 交给用户看，绝不尝试在前端拼装或换算任何数值。
 */
import { useMemo, useState } from "react";
import { groupDecimal } from "../utils/format";
import type {
  OpportunityAssessment,
  QualificationResult,
  ScoreResult,
  TenderNotice,
} from "../api/client";
import { AssessmentBadge, Button, Disclosure, EmptyState, VerdictBadge } from "./core";
import { EvidenceTenon } from "./evidence";
import { QualificationBoard, ScoreLedger } from "./scores";

const PAGE = 5;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasKeys(value: unknown, keys: string[]): boolean {
  return isRecord(value) && keys.some((key) => key in value);
}

function detectList(data: Record<string, unknown>, keys: string[], guard: (item: unknown) => boolean): unknown[] | null {
  for (const key of keys) {
    const value = data[key];
    if (Array.isArray(value)) return value.filter(guard);
  }
  const nested = data["results"];
  if (Array.isArray(nested) && nested.length > 0 && isRecord(nested[0])) {
    for (const key of keys) {
      const value = nested[0][key];
      if (Array.isArray(value)) return value.filter(guard);
    }
  }
  return null;
}

/** 只是首批展示的切片；展开按钮自己管理数量，这里不参与状态。 */
function showMore<T>(items: T[], shown: number): T[] {
  return items.slice(0, shown);
}

/** 公告候选的公共识别规则：与 ResultView 内部保持一致，供机会雷达等视图复用。 */
export function detectNotices(data: Record<string, unknown>): TenderNotice[] {
  return (detectList(data, ["notices", "candidates"], (item) => hasKeys(item, ["notice_id", "url"])) ??
    []) as unknown as TenderNotice[];
}

export function ResultView({ data }: { data: Record<string, unknown> }) {
  const qualifications = useMemo(
    () =>
      (detectList(data, ["qualifications", "qualification_results"], (item) => hasKeys(item, ["bidder_id"])) ??
        []) as unknown as QualificationResult[],
    [data],
  );
  const scores = useMemo(
    () =>
      (detectList(data, ["scores", "score_results"], (item) => hasKeys(item, ["total_score", "items"])) ??
        []) as unknown as ScoreResult[],
    [data],
  );
  const assessments = useMemo(
    () =>
      (detectList(data, ["assessments", "candidates"], (item) => hasKeys(item, ["candidate_id"])) ??
        []) as unknown as OpportunityAssessment[],
    [data],
  );
  const notices = useMemo(
    () =>
      (detectList(data, ["notices", "candidates"], (item) => hasKeys(item, ["notice_id", "url"])) ??
        []) as unknown as TenderNotice[],
    [data],
  );

  const [shown, setShown] = useState(PAGE);
  const anything = qualifications.length + scores.length + assessments.length + notices.length > 0;

  return (
    <div className="result-view">
      <dl className="result-index">
        <div>
          <dt className="micro">资格结果</dt>
          <dd className="ledger-num">{qualifications.length}</dd>
        </div>
        <div>
          <dt className="micro">评分结果</dt>
          <dd className="ledger-num">{scores.length}</dd>
        </div>
        <div>
          <dt className="micro">机会评估</dt>
          <dd className="ledger-num">{assessments.length}</dd>
        </div>
        <div>
          <dt className="micro">公告候选</dt>
          <dd className="ledger-num">{notices.length}</dd>
        </div>
      </dl>

      {qualifications.length > 0 ? (
        <section className="result-block">
          <h3 className="result-block__title">资格判定</h3>
          {showMore(qualifications, shown).map((item) => (
            <QualificationBoard key={item.bidder_id} result={item} />
          ))}
        </section>
      ) : null}

      {scores.length > 0 ? (
        <section className="result-block">
          <h3 className="result-block__title">
            评分明细
            <span className="micro muted">（数值来自后端，前端不重算）</span>
          </h3>
          {showMore(scores, shown).map((item) => (
            <ScoreLedger key={item.bidder_id} result={item} />
          ))}
        </section>
      ) : null}

      {assessments.length > 0 ? (
        <section className="result-block">
          <h3 className="result-block__title">机会评估</h3>
          <ul className="assessments">
            {showMore(assessments, shown).map((item) => (
              <li key={item.candidate_id} className="assessment">
                <div className="assessment__head">
                  <span className="mono">{item.candidate_id}</span>
                  <AssessmentBadge status={item.status} />
                  {item.score !== null && item.score !== undefined ? (
                    <span className="ledger-num muted">score {groupDecimal(item.score)}</span>
                  ) : null}
                </div>
                {item.reasons && item.reasons.length > 0 ? (
                  <ul className="reasons">
                    {item.reasons.map((reason, index) => (
                      <li key={index}>{reason}</li>
                    ))}
                  </ul>
                ) : null}
                <EvidenceTenon refs={item.evidence} label="机会判断依据" needsReview={item.status === "needs_review"} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {notices.length > 0 ? (
        <section className="result-block">
          <h3 className="result-block__title">公告候选</h3>
          <NoticeList notices={showMore(notices, shown)} />
        </section>
      ) : null}

      {(qualifications.length > shown ||
        scores.length > shown ||
        assessments.length > shown ||
        notices.length > shown) ? (
        <Button variant="ghost" onClick={() => setShown((value) => value + PAGE * 2)}>
          继续展开
        </Button>
      ) : null}

      {!anything ? (
        <EmptyState
          title="结果里没有识别到已知结构"
          hint="已按原样展示后端返回的数据；如果你预期看到资格或评分，请检查该 run 的类型与是否已完成。"
        />
      ) : null}

      <Disclosure summary="后端原始结果（只读）" count={Object.keys(data).length}>
        <pre className="raw-json">{JSON.stringify(data, null, 2)}</pre>
      </Disclosure>
    </div>
  );
}

export function NoticeList({ notices }: { notices: TenderNotice[] }) {
  return (
    <ul className="notices">
      {notices.map((notice) => (
        <li key={notice.notice_id} className="notice-card">
          <div className="notice-card__head">
            <h4 className="notice-card__title">{notice.title}</h4>
            {notice.notice_type ? <VerdictBadge tone="needs_review" label={`类型：${notice.notice_type}`} /> : null}
          </div>
          <dl className="notice-card__meta">
            {notice.project_number ? (
              <div>
                <dt className="micro">项目编号</dt>
                <dd className="mono">{notice.project_number}</dd>
              </div>
            ) : null}
            {notice.region ? (
              <div>
                <dt className="micro">地区</dt>
                <dd>{notice.region}</dd>
              </div>
            ) : null}
            {notice.deadline ? (
              <div>
                <dt className="micro">截止</dt>
                <dd>{notice.deadline}</dd>
              </div>
            ) : null}
            {notice.budget ? (
              <div>
                <dt className="micro">预算</dt>
                <dd className="ledger-num">{notice.budget}</dd>
              </div>
            ) : null}
            {notice.lot_id ? (
              <div>
                <dt className="micro">标段</dt>
                <dd className="mono">{notice.lot_id}</dd>
              </div>
            ) : null}
          </dl>
          <div className="notice-card__foot">
            <a className="link" href={notice.url} target="_blank" rel="noreferrer noopener">
              打开来源 {notice.providers?.[0] ? `（${notice.providers[0]}）` : ""}
            </a>
            <EvidenceTenon refs={notice.evidence} label={`公告依据 · ${notice.notice_id}`} compact />
          </div>
        </li>
      ))}
    </ul>
  );
}
