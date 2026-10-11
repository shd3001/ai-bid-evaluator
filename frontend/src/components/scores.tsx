/**
 * 分数与资格展示。
 * 硬约束：这里的数值全部原样来自后端（十进制字符串），前端只做分组与对齐，绝不重算、绝不排名。
 */
import { cx } from "../utils/cx";
import { groupDecimal, hasEvidence, scoreText } from "../utils/format";
import type { QualificationCheck, QualificationResult, ScoreItem, ScoreResult } from "../api/client";
import { CheckBadge, Disclosure, EmptyState, StatusFlag, VerdictBadge } from "./core";
import { EvidenceTenon } from "./evidence";

export function RuleRow({ check }: { check: QualificationCheck }) {
  return (
    <li className={cx("rule", check.mandatory === false && "rule--optional")}>
      <div className="rule__head">
        <span className="rule__id mono">{check.rule_id}</span>
        <CheckBadge status={check.status} />
        {check.mandatory === false ? <span className="rule__tag micro">非强制</span> : null}
      </div>
      {check.reason ? <p className="rule__reason">{check.reason}</p> : null}
      <div className="rule__foot">
        <EvidenceTenon
          refs={check.evidence}
          label={`判定依据 · ${check.rule_id}`}
          needsReview={(check.status ?? "") === "needs_review"}
          compact
        />
      </div>
    </li>
  );
}

export function QualificationBoard({ result }: { result: QualificationResult }) {
  const checks = result.checks ?? [];
  const mandatory = checks.filter((check) => check.mandatory !== false);
  const optional = checks.filter((check) => check.mandatory === false);
  return (
    <article className="qual">
      <header className="qual__head">
        <div>
          <h3 className="qual__name">{result.bidder_name || result.bidder_id}</h3>
          <p className="micro muted mono">{result.bidder_id}</p>
        </div>
        <div className="qual__verdict">
          <VerdictBadge tone={normVerdict(result.status)} label={verdictText(result.status)} />
          {mandatory.length > 0 ? (
            <span className="micro muted ledger-num">
              {mandatory.filter((check) => check.status === "passed").length}/{mandatory.length} 项强制条件通过
            </span>
          ) : null}
        </div>
      </header>

      {mandatory.length > 0 ? (
        <ul className="rule-list">
          {mandatory.map((check) => (
            <RuleRow key={`m-${check.rule_id}`} check={check} />
          ))}
        </ul>
      ) : (
        <EmptyState title="后端未返回强制条件明细" hint="资格结论以上方状态为准，不要用缺明细推断通过。" />
      )}

      {optional.length > 0 ? (
        <Disclosure summary="非强制条件" count={optional.length}>
          <ul className="rule-list">
            {optional.map((check) => (
              <RuleRow key={`o-${check.rule_id}`} check={check} />
            ))}
          </ul>
        </Disclosure>
      ) : null}

      {result.reasons && result.reasons.length > 0 ? (
        <ul className="reasons">
          {result.reasons.map((reason, index) => (
            <li key={index}>{reason}</li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}

export function ScoreLedger({ result }: { result: ScoreResult }) {
  const items = result.items ?? [];
  const referenceOnly = result.reference_only === true;
  const invalid = result.valid === false;
  return (
    <article className="ledger">
      <header className="ledger__head">
        <div>
          <h3 className="ledger__title">{result.bidder_id}</h3>
          <p className="micro muted">逐条规则得分 · 数值由后端给出</p>
        </div>
        <div className="ledger__total">
          <span className="ledger__total-label micro">合计</span>
          <span className="ledger__total-value ledger-num">
            {scoreText(result.total_score)} / {groupDecimal(result.max_total_score ?? null)}
          </span>
        </div>
      </header>

      {referenceOnly ? (
        <StatusFlag tone="review">参考评分：资格未通过，不得进入有效推荐集合</StatusFlag>
      ) : null}
      {invalid ? <StatusFlag tone="fail">评分结果被后端标为无效（valid = false）</StatusFlag> : null}

      {items.length > 0 ? (
        <table className="score-table">
          <caption className="sr-only">逐条评分明细</caption>
          <thead>
            <tr>
              <th scope="col">规则</th>
              <th scope="col" className="score-table__num">
                得分
              </th>
              <th scope="col" className="score-table__num">
                满分
              </th>
              <th scope="col">证据</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item: ScoreItem) => (
              <tr key={item.rule_id}>
                <td>
                  <span className="mono">{item.rule_id}</span>
                  {item.inputs && Object.keys(item.inputs).length > 0 ? (
                    <Disclosure summary="计算输入" defaultOpen={false}>
                      <pre className="inputs">{JSON.stringify(item.inputs, null, 2)}</pre>
                    </Disclosure>
                  ) : null}
                </td>
                <td className="score-table__num ledger-num">{groupDecimal(item.score)}</td>
                <td className="score-table__num ledger-num">{groupDecimal(item.max_score)}</td>
                <td>
                  <EvidenceTenon refs={item.evidence} label={`评分依据 · ${item.rule_id}`} compact />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <EmptyState
          title="没有逐条评分明细"
          hint={
            (result.items ?? []).some((item) => hasEvidence({ evidence: item.evidence }))
              ? "合计分仍由后端给出。"
              : "后端没有给出明细，也不要在前端自行折算。"
          }
        />
      )}

      {result.errors && result.errors.length > 0 ? (
        <ul className="reasons reasons--fail">
          {result.errors.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}

function normVerdict(status: string | null | undefined): "passed" | "failed" | "needs_review" {
  if (status === "passed" || status === "suitable") return "passed";
  if (status === "failed" || status === "unsuitable") return "failed";
  return "needs_review";
}

function verdictText(status: string | null | undefined): string | undefined {
  if (status === "passed") return "资格通过";
  if (status === "failed") return "资格不通过";
  if (status === "needs_review") return "资格待复核";
  return undefined;
}
