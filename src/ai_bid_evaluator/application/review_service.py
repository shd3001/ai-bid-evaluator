from copy import deepcopy
from sqlalchemy import select
from ai_bid_evaluator.domain.run import ReviewDecision, utcnow
from ai_bid_evaluator.domain.exceptions import Conflict, DomainError
from ai_bid_evaluator.infrastructure.orm_models import RunStepRow, ReviewRow, ReportRow, AuditRow, CompanyRow, DocumentRow, DocumentChunkRow
from ai_bid_evaluator.infrastructure.repositories import get_run, state_of, save_state, bump, replay, remember, content_hash, event

EDIT_FIELDS = {"profile": {"name", "industry", "qualifications", "evidence"},
               "extract": {"rules"}, "assess": {"qualifications", "scores", "assessments"},
               "ingest": {"documents"}}


class ReviewService:
    def __init__(self, repository):
        self.repository = repository

    def apply(self, run_id: str, decision: ReviewDecision, idempotency_key: str):
        request, scope = decision.model_dump(mode="json"), f"review:{run_id}"
        with self.repository.db.write() as session:
            cached = replay(session, scope, idempotency_key, request)
            if cached:
                return cached
            row = get_run(session, run_id)
            state = state_of(row)
            if state.revision != decision.expected_version:
                raise Conflict("复核版本冲突")
            if state.status not in {"awaiting_review", "succeeded", "failed"}:
                raise Conflict("当前状态不能提交复核")
            steps = list(session.scalars(select(RunStepRow).where(RunStepRow.run_id == run_id).order_by(RunStepRow.step_id)))
            target = next((s for s in steps if s.name == decision.target_id and not s.data.get("stale")), None)
            if target is None:
                raise DomainError("复核目标不存在或已过期")
            before = deepcopy(target.data["output"])
            after = deepcopy(before)
            if decision.decision != "edit" and decision.patch:
                raise DomainError("确认/拒绝不能夹带修改")
            if decision.decision == "edit":
                if not decision.patch or set(decision.patch) - EDIT_FIELDS.get(target.name, set()):
                    raise DomainError("复核修改字段不合法")
                after.update(decision.patch)
            if decision.decision != "reject":
                after["confirmed"] = True
                if target.name == "extract":
                    from ai_bid_evaluator.domain.evaluation import EvaluationRule
                    def confirm_rule(raw):
                        raw = dict(raw)
                        raw["confirmed"] = True
                        raw["children"] = [confirm_rule(c) for c in raw.get("children", [])]
                        return EvaluationRule.model_validate(raw).model_dump(mode="json")
                    after["rules"] = [confirm_rule(r) for r in after.get("rules", [])]
            if decision.decision == "reject":
                state.status = "failed"
                state.error = {"code": "review_rejected", "message": "人工复核拒绝该步骤"}
            else:
                if target.name == "profile":
                    current_company = session.get(CompanyRow, before["company_id"])
                    if current_company is not None and current_company.data["revision"] != before["revision"]:
                        raise Conflict("企业画像版本已更新，请使用最新画像重新提交任务")
                from .review_validation import validate_review_output
                after = validate_review_output(target.name, state.type, before, after,
                    {**{s.name: s.data["output"] for s in steps if not s.data.get("stale")}, "_request": state.input_snapshot})
                if target.name == "profile":
                    if decision.decision == "edit":
                        after["revision"] += 1
                    session.merge(CompanyRow(company_id=after["company_id"], data=after))
                if target.name == "ingest":
                    # The review, latest verified transcription and all evidence
                    # variants commit together. Original sources stay in audit,
                    # immutable chunk rows and older run snapshots.
                    for source in after["documents"]:
                        parsed = source["parsed"]
                        document_row = session.get(DocumentRow, parsed["document_id"])
                        if document_row is None:
                            raise DomainError("源文档未登记，不能保存复核证据")
                        document_row.data = parsed
                        for chunk in parsed["chunks"]:
                            existing = session.get(DocumentChunkRow, chunk["chunk_id"])
                            if existing is None:
                                session.add(DocumentChunkRow(chunk_id=chunk["chunk_id"], document_id=parsed["document_id"], data=chunk))
                            elif existing.data != chunk:
                                raise Conflict("证据块 ID 已关联不同内容")
                state.status, state.error = "pending", None
            # Save revisions; never destroy the original result or report.
            target.data = {**target.data, "output": after, "output_hash": content_hash(after), "confirmed": decision.decision != "reject"}
            target_index = state.known_steps.index(target.name) if target.name in state.known_steps else -1
            downstream = set(state.known_steps[target_index+1:])
            if decision.decision == "reject":
                downstream.add(target.name)
            for step in steps:
                if step.name in downstream:
                    step.data = {**step.data, "stale": True}
            if decision.decision == "edit" or any(s.name in downstream for s in steps):
                state.result_stale = True
                for report in session.scalars(select(ReportRow).where(ReportRow.run_id == run_id)):
                    report.stale = True
            state.completed_steps = [name for name in state.completed_steps if name not in downstream]
            state.review_count = 0
            state.owner, state.lease_until = None, None
            state.current_step = target.name
            bump(state)
            audit = {**request, "before": before, "after": after, "at": utcnow().isoformat(),
                     "source_revision": decision.expected_version, "revision": state.revision}
            session.add(ReviewRow(run_id=run_id, data=audit))
            session.add(AuditRow(run_id=run_id, data=audit))
            save_state(row, state)
            event(session, state, "review_applied", {"target_id": target.name})
            remember(session, scope, idempotency_key, request, state)
            return state
