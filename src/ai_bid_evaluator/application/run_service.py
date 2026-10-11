from uuid import uuid4
from sqlalchemy import select
from ai_bid_evaluator.domain.run import RunCreate, RunState
from ai_bid_evaluator.domain.exceptions import Conflict, NotFound, DomainError
from ai_bid_evaluator.infrastructure.orm_models import RunRow, ProjectRow, DocumentRow, CompanyRow, DocumentChunkRow
from ai_bid_evaluator.infrastructure.repositories import get_run, state_of, save_state, bump, replay, remember, event

STEPS = {"bid_evaluation": ["ingest", "extract", "assess", "report"],
         "opportunity_discovery": ["ingest", "profile", "search", "assess", "report"]}


class RunService:
    def __init__(self, repository):
        self.repository = repository

    def create(self, request: RunCreate, idempotency_key: str) -> RunState:
        with self.repository.db.write() as session:
            return self._create_in_session(session, request, idempotency_key)

    def _create_in_session(self, session, request, idempotency_key):
        body = request.model_dump(mode="json")
        cached = replay(session, "create", idempotency_key, body)
        if cached:
            return cached
        if session.get(ProjectRow, request.project_id) is None:
            raise NotFound("项目不存在")
        if len(set(request.document_ids)) != len(request.document_ids):
            raise DomainError("文档 ID 重复")
        documents = [session.get(DocumentRow, i) for i in request.document_ids]
        if any(d is None for d in documents):
            raise NotFound("文档不存在")
        if any(d.project_id != request.project_id or d.data["status"] == "failed" for d in documents):
            raise DomainError("文档项目或解析状态不满足要求")
        body["document_snapshots"] = [{"role": d.role, "bidder_id": d.bidder_id, "parsed": d.data} for d in documents]
        if request.type == "bid_evaluation":
            roles = {d.role for d in documents}
            if not {"announcement", "tender", "bid"} <= roles:
                raise DomainError("评标需要公告、招标文件和投标材料")
        else:
            company = session.get(CompanyRow, request.company_id) if request.company_id else None
            if company:
                if not company.data.get("confirmed") or company.data.get("revision") != request.company_revision:
                    raise Conflict("企业画像未确认或版本不一致")
                from ai_bid_evaluator.domain.documents import ParsedDocument
                from ai_bid_evaluator.domain.opportunity import CompanyProfile
                from ai_bid_evaluator.workflows.contracts import validate_profile_evidence
                profile = CompanyProfile.model_validate(company.data)
                proof_ids = {e.document_id for e in profile.evidence}
                proof_rows = [session.get(DocumentRow, i) for i in proof_ids]
                if any(d is None or d.role != "profile" for d in proof_rows):
                    raise DomainError("已确认画像缺少已登记的企业来源文档")
                from ai_bid_evaluator.domain.documents import DocumentChunk
                proof_documents = [ParsedDocument.model_validate(d.data).model_copy(update={"chunks": [DocumentChunk.model_validate(c.data)
                    for c in session.scalars(select(DocumentChunkRow).where(DocumentChunkRow.document_id == d.document_id))]}) for d in proof_rows]
                validate_profile_evidence(profile, proof_documents)
                included = {d.document_id for d in documents}
                body["document_snapshots"].extend({"role": d.role, "bidder_id": d.bidder_id, "parsed": d.data}
                    for d in proof_rows if d.document_id not in included)
                body["company_snapshot"] = company.data
            elif not any(d.role == "profile" for d in documents):
                raise DomainError("机会任务需要已确认画像或画像源文档")
        state = RunState(run_id=f"run_{uuid4().hex}", type=request.type, project_id=request.project_id,
                         input_snapshot=body, known_steps=STEPS[request.type])
        row = RunRow(run_id=state.run_id, project_id=state.project_id, type=state.type,
                     status=state.status, data=state.model_dump(mode="json"))
        session.add(row)
        session.flush()
        remember(session, "create", idempotency_key, request.model_dump(mode="json"), state)
        event(session, state, "created")
        return state

    def retry(self, run_id: str, expected_version: int, idempotency_key: str) -> RunState:
        return self._change(run_id, "retry", expected_version, idempotency_key)

    def cancel(self, run_id: str, expected_version: int, idempotency_key: str) -> RunState:
        return self._change(run_id, "cancel", expected_version, idempotency_key)

    def _change(self, run_id, action, version, key):
        request = {"expected_version": version}
        scope = f"{action}:{run_id}"
        with self.repository.db.write() as session:
            cached = replay(session, scope, key, request)
            if cached:
                return cached
            row = get_run(session, run_id)
            state = state_of(row)
            if state.revision != version:
                raise Conflict("任务版本冲突")
            if action == "retry":
                if state.status != "failed":
                    raise Conflict("只能重试失败任务")
                state.status, state.error = "pending", None
                state.owner, state.lease_until = None, None
            elif state.status not in {"succeeded", "failed", "cancelled"}:
                state.cancel_requested = True
                if state.status != "running":
                    state.status, state.review_count = "cancelled", 0
            bump(state)
            save_state(row, state)
            event(session, state, action)
            remember(session, scope, key, request, state)
            return state
