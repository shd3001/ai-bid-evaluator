from sqlalchemy import select
from ai_bid_evaluator.infrastructure.orm_models import ReportRow


class ReportService:
    def __init__(self, repository):
        self.repository = repository

    def versions(self, run_id):
        self.repository.load(run_id)
        with self.repository.db.read() as session:
            return [{"report_id": row.report_id, "revision": row.revision, "stale": row.stale, "data": row.data}
                    for row in session.scalars(select(ReportRow).where(ReportRow.run_id == run_id).order_by(ReportRow.report_id))]
