import hashlib
import json
from datetime import datetime, timezone, timedelta
from uuid import uuid4
from sqlalchemy import select, or_, and_
from ai_bid_evaluator.domain.run import RunState, utcnow
from ai_bid_evaluator.domain.documents import ParsedDocument
from ai_bid_evaluator.domain.exceptions import Conflict, NotFound
from .orm_models import (RunRow, RunStepRow, ProjectRow, BidderRow, CompanyRow, DocumentRow,
                         DocumentChunkRow, ReviewRow, EventRow, IdempotencyRow, ReportRow, EvaluationRow)


def content_hash(value) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def state_of(row: RunRow) -> RunState:
    data = dict(row.data)
    data.update(status=row.status, owner=row.owner,
                lease_until=datetime.fromtimestamp(row.lease_until, timezone.utc) if row.lease_until else None)
    return RunState.model_validate(data)


def save_state(row: RunRow, state: RunState):
    row.status, row.owner = state.status, state.owner
    row.lease_until = state.lease_until.timestamp() if state.lease_until else None
    row.data = state.model_dump(mode="json")


def bump(state: RunState):
    state.revision += 1
    state.updated_at = utcnow()


def replay(session, scope, key, request):
    if not key or len(key) > 200:
        raise ValueError("需要有效 Idempotency-Key")
    row = session.get(IdempotencyRow, (scope, key))
    if row:
        if row.request_hash != content_hash(request):
            raise Conflict("幂等键已用于不同请求")
        return RunState.model_validate(row.response)
    return None


def remember(session, scope, key, request, state):
    session.add(IdempotencyRow(scope=scope, key=key, request_hash=content_hash(request), response=state.model_dump(mode="json")))


def get_run(session, run_id):
    row = session.get(RunRow, run_id)
    if row is None:
        raise NotFound("任务不存在")
    return row


def event(session, state, name, details=None):
    session.add(EventRow(run_id=state.run_id, data={"event": name, "revision": state.revision,
                                                  "at": utcnow().isoformat(), "details": details or {}}))


class RunRepository:
    def __init__(self, db):
        self.db = db

    def add_project(self, project_id, name):
        with self.db.write() as session:
            session.add(ProjectRow(project_id=project_id, name=name))

    def get_project(self, project_id):
        with self.db.read() as session:
            row = session.get(ProjectRow, project_id)
            return {"project_id": row.project_id, "name": row.name} if row else None

    def add_bidder(self, project_id, bidder_id, name):
        with self.db.write() as session:
            session.add(BidderRow(project_id=project_id, bidder_id=bidder_id, name=name))

    def add_company(self, company_id, data):
        from ai_bid_evaluator.domain.opportunity import CompanyProfile
        profile = CompanyProfile.model_validate(data)
        if profile.company_id != company_id:
            raise ValueError("企业 ID 不一致")
        with self.db.write() as session:
            session.merge(CompanyRow(company_id=company_id, data=profile.model_dump(mode="json")))

    def add_document(self, project_id, role, document: ParsedDocument, bidder_id=None):
        if role not in {"announcement", "tender", "bid", "profile"}:
            raise ValueError("文档角色不合法")
        with self.db.write() as session:
            if bidder_id:
                bidder = session.get(BidderRow, bidder_id)
                if bidder is None or bidder.project_id != project_id:
                    raise ValueError("投标人与项目不匹配")
            if role == "bid" and bidder_id is None:
                raise ValueError("投标材料须关联 bidder_id")
            session.add(DocumentRow(document_id=document.document_id, project_id=project_id,
                                    role=role, bidder_id=bidder_id, data=document.model_dump(mode="json")))
            session.flush()
            for c in document.chunks:
                session.add(DocumentChunkRow(chunk_id=c.chunk_id, document_id=document.document_id, data=c.model_dump(mode="json")))

    def documents(self, run_id):
        state = self.load(run_id)
        if "document_snapshots" in state.input_snapshot:
            return [{"role": d["role"], "bidder_id": d["bidder_id"], "document": ParsedDocument.model_validate(d["parsed"])}
                    for d in state.input_snapshot["document_snapshots"]]
        with self.db.read() as session:
            rows = [session.get(DocumentRow, doc_id) for doc_id in state.input_snapshot.get("document_ids", [])]
            return [{"role": r.role, "bidder_id": r.bidder_id, "document": ParsedDocument.model_validate(r.data)} for r in rows if r]

    def register_chunks(self, document):
        with self.db.write() as session:
            for chunk in document.chunks:
                data = chunk.model_dump(mode="json")
                row = session.get(DocumentChunkRow, chunk.chunk_id)
                if row is None:
                    session.add(DocumentChunkRow(chunk_id=chunk.chunk_id, document_id=document.document_id, data=data))
                elif row.data != data:
                    raise Conflict("证据块 ID 已关联不同内容")

    def company(self, company_id):
        with self.db.read() as session:
            row = session.get(CompanyRow, company_id)
            return row.data if row else None

    def load(self, run_id):
        with self.db.read() as session:
            return state_of(get_run(session, run_id))

    def steps(self, run_id):
        with self.db.read() as session:
            return {row.name: row.data for row in session.scalars(select(RunStepRow).where(RunStepRow.run_id == run_id).order_by(RunStepRow.step_id))}

    def reviews(self, run_id):
        with self.db.read() as session:
            return [row.data for row in session.scalars(select(ReviewRow).where(ReviewRow.run_id == run_id).order_by(ReviewRow.review_id))]

    def events(self, run_id, after_seq=0):
        with self.db.read() as session:
            return [{"seq": row.seq, **row.data} for row in session.scalars(select(EventRow).where(EventRow.run_id == run_id, EventRow.seq > after_seq).order_by(EventRow.seq))]

    def record_model(self, run_id, metadata):
        allowed = {"task", "model", "prompt_version", "schema_version", "input_hash", "attempt", "usage", "status"}
        with self.db.write() as session:
            state = state_of(get_run(session, run_id))
            event(session, state, "model_call", {k: v for k, v in metadata.items() if k in allowed})

    def claim_next(self, owner: str, now: datetime, lease_seconds: int, run_id: str | None = None) -> RunState | None:
        if now.tzinfo is None or lease_seconds <= 0:
            raise ValueError("租约需要带时区时间和正数时长")
        with self.db.write() as session:
            query = select(RunRow).where(or_(RunRow.status == "pending", and_(RunRow.status == "running", RunRow.lease_until <= now.timestamp()))).order_by(RunRow.run_id)
            if run_id is not None:
                query = query.where(RunRow.run_id == run_id)
            row = session.scalars(query).first()
            if row is None:
                return None
            state = state_of(row)
            state.status, state.owner = "running", owner
            state.lease_until = now + timedelta(seconds=lease_seconds)
            bump(state)
            save_state(row, state)
            event(session, state, "claimed")
            return state

    def _owned(self, session, run_id, owner, now=None):
        row = get_run(session, run_id)
        now = now or utcnow()
        if row.status != "running" or row.owner != owner or row.lease_until is None or row.lease_until <= now.timestamp():
            raise Conflict("任务租约失效")
        return row, state_of(row)

    def renew_lease(self, run_id, owner, now, lease_seconds=120):
        with self.db.write() as session:
            row, state = self._owned(session, run_id, owner, now)
            state.lease_until = now + timedelta(seconds=lease_seconds)
            save_state(row, state)

    def begin_step(self, run_id, owner, name, input_data, versions=None):
        with self.db.write() as session:
            row, state = self._owned(session, run_id, owner)
            state.current_step = name
            bump(state)
            save_state(row, state)
            event(session, state, "step_started", {"step": name, "input_hash": content_hash(input_data), **(versions or {})})

    def checkpoint(self, run_id, owner, name, output, *, awaiting_review=False, input_data=None, versions=None):
        with self.db.write() as session:
            row, state = self._owned(session, run_id, owner)
            existing = session.scalars(select(RunStepRow).where(RunStepRow.run_id == run_id, RunStepRow.name == name)).first()
            data = {"output": output, "input_hash": content_hash(input_data or state.input_snapshot),
                    "output_hash": content_hash(output), "versions": versions or {}, "stale": False,
                    "confirmed": not awaiting_review, "source_revision": state.revision, "completed_at": utcnow().isoformat()}
            if existing:
                existing.data = data
            else:
                session.add(RunStepRow(run_id=run_id, name=name, data=data))
            state.current_step = name
            if name not in state.completed_steps:
                state.completed_steps.append(name)
            if awaiting_review:
                state.status, state.owner, state.lease_until = "awaiting_review", None, None
                state.review_count = 1
            if state.cancel_requested:
                state.status, state.owner, state.lease_until = "cancelled", None, None
                state.review_count = 0
            bump(state)
            if name == "report":
                session.add(ReportRow(run_id=run_id, revision=state.revision, stale=False, data=output))
                state.result_stale = False
            if name == "assess":
                session.add(EvaluationRow(run_id=run_id, revision=state.revision, data=output))
            save_state(row, state)
            event(session, state, "awaiting_review" if awaiting_review else "step_completed", {"step": name})
            return state

    def finish(self, run_id, owner):
        with self.db.write() as session:
            row, state = self._owned(session, run_id, owner)
            state.status = "cancelled" if state.cancel_requested else "succeeded"
            state.owner, state.lease_until = None, None
            bump(state)
            save_state(row, state)
            event(session, state, state.status)
            return state

    def fail(self, run_id, owner, code="execution_failed"):
        with self.db.write() as session:
            row, state = self._owned(session, run_id, owner)
            state.status = "cancelled" if state.cancel_requested else "failed"
            state.error = {"code": code, "message": "任务步骤失败，请检查配置或输入后重试"}
            state.owner, state.lease_until = None, None
            bump(state)
            save_state(row, state)
            event(session, state, state.status, state.error)
            return state
