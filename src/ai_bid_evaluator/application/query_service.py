from uuid import uuid4
from sqlalchemy import select
from ai_bid_evaluator.domain.exceptions import NotFound, Conflict
from ai_bid_evaluator.infrastructure.orm_models import (ProjectRow, BidderRow, DocumentRow, DocumentChunkRow,
    RunRow, EventRow, ReviewRow, RunStepRow, ReportRow, CompanyRow)
from ai_bid_evaluator.infrastructure.repositories import state_of, content_hash
from .document_service import document_response
from .pagination import page, decode_cursor


class QueryService:
    """Short database transactions for public reads; no HTTP or model dependencies."""
    def __init__(self, repository):
        self.repository = repository

    def create_project(self, request):
        result = {"project_id": f"project_{uuid4().hex}", "name": request.name}
        self.repository.add_project(**result)
        return result

    def create_bidder(self, project_id, request):
        result = {"project_id": project_id, "bidder_id": f"bidder_{uuid4().hex}", "name": request.name}
        with self.repository.db.write() as session:
            self._get(session, ProjectRow, project_id)
            session.add(BidderRow(**result))
        return result

    @staticmethod
    def _get(session, model, key):
        row = session.get(model, key)
        if row is None:
            raise NotFound("资源不存在")
        return row

    def listing(self, model, key_column, scope, convert, limit, cursor, conditions=(), numeric=False):
        after = decode_cursor(cursor, scope, numeric)
        query = select(model).where(*conditions).order_by(key_column).limit(limit + 1)
        if after is not None:
            query = query.where(key_column > after)
        with self.repository.db.read() as session:
            rows = list(session.scalars(query))
            return page(rows, limit, scope, lambda row: getattr(row, key_column.key), convert)

    def projects(self, limit, cursor):
        return self.listing(ProjectRow, ProjectRow.project_id, "projects", lambda r: {"project_id": r.project_id, "name": r.name}, limit, cursor)

    def document(self, document_id):
        with self.repository.db.read() as session:
            return document_response(self._get(session, DocumentRow, document_id))

    def chunks(self, document_id, limit, cursor):
        self.document(document_id)
        return self.listing(DocumentChunkRow, DocumentChunkRow.chunk_id, f"chunks:{document_id}", lambda r: r.data,
                            limit, cursor, [DocumentChunkRow.document_id == document_id])

    def runs(self, limit, cursor, project_id=None, type=None, status=None):
        filters = {"project_id": project_id, "type": type, "status": status}
        conditions = [getattr(RunRow, k) == v for k, v in filters.items() if v is not None]
        return self.listing(RunRow, RunRow.run_id, "runs:" + content_hash(filters), state_of, limit, cursor, conditions)

    def events(self, run_id, after_seq, limit, cursor):
        self.repository.load(run_id)
        return self.listing(EventRow, EventRow.seq, f"events:{run_id}:{after_seq}", lambda r: {"seq": r.seq, **r.data},
                            limit, cursor, [EventRow.run_id == run_id, EventRow.seq > after_seq], numeric=True)

    def reviews(self, run_id, limit, cursor):
        state = self.repository.load(run_id)
        scope = f"reviews:{run_id}"
        after = decode_cursor(cursor, scope)
        with self.repository.db.read() as session:
            rows = [{"review_id": str(r.review_id), "kind": "history", "target_id": r.data["target_id"],
                     "revision": r.data["revision"], "payload": r.data}
                    for r in session.scalars(select(ReviewRow).where(ReviewRow.run_id == run_id).order_by(ReviewRow.review_id))]
            if state.status == "awaiting_review":
                target = session.scalars(select(RunStepRow).where(RunStepRow.run_id == run_id, RunStepRow.name == state.current_step)).first()
                if target and not target.data.get("stale"):
                    rows.append({"review_id": f"pending_{target.step_id}", "kind": "pending", "target_id": target.name,
                                 "revision": state.revision, "payload": target.data["output"]})
            rows.sort(key=lambda r: r["review_id"])
            rows = [r for r in rows if after is None or r["review_id"] > after]
            return page(rows, limit, scope, lambda r: r["review_id"], lambda r: r)

    def review_response(self, run_id, state):
        with self.repository.db.read() as session:
            row = next((r for r in session.scalars(select(ReviewRow).where(ReviewRow.run_id == run_id))
                        if r.data["revision"] == state.revision), None)
            if row is None:
                raise NotFound("复核记录不存在")
            return {"review_id": str(row.review_id), "run": state, "decision": row.data["decision"],
                    "target_id": row.data["target_id"], "reason": row.data["reason"], "at": row.data["at"]}

    def results(self, run_id):
        state = self.repository.load(run_id)
        step = self.repository.steps(run_id).get("assess")
        if step is None:
            raise Conflict("评审结果尚未就绪")
        data, evidence = step["output"], []
        def walk(value):
            if isinstance(value, dict):
                if {"document_id", "chunk_id", "quote", "document_hash"} <= value.keys() and value not in evidence:
                    evidence.append(value)
                for child in value.values():
                    walk(child)
            elif isinstance(value, list):
                for child in value:
                    walk(child)
        walk(data)
        return {"run_id": run_id, "revision": state.revision, "stale": state.result_stale or step.get("stale", False),
                "confirmed": step.get("confirmed", False), "data": data, "evidence_matrix": evidence}

    def _report(self, row, state):
        return {"report_id": str(row.report_id), "run_id": row.run_id, "revision": row.revision,
                "stale": row.stale or state.result_stale, "confirmed": state.status == "succeeded" and not row.stale and not state.result_stale,
                "data": row.data}

    def reports(self, run_id, limit, cursor):
        state = self.repository.load(run_id)
        return self.listing(ReportRow, ReportRow.report_id, f"reports:{run_id}", lambda row: self._report(row, state),
                            limit, cursor, [ReportRow.run_id == run_id], numeric=True)

    def report(self, report_id):
        with self.repository.db.read() as session:
            row = self._get(session, ReportRow, report_id)
            state = state_of(self._get(session, RunRow, row.run_id))
            return self._report(row, state)

    def companies(self, limit, cursor):
        return self.listing(CompanyRow, CompanyRow.company_id, "companies", lambda r: r.data, limit, cursor)

    def company(self, company_id):
        with self.repository.db.read() as session:
            return self._get(session, CompanyRow, company_id).data
