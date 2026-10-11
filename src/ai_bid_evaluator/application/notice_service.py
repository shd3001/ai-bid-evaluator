from sqlalchemy import select
from ai_bid_evaluator.infrastructure.orm_models import NoticeRow, NoticeSourceRow
from ai_bid_evaluator.infrastructure.repositories import content_hash
from ai_bid_evaluator.domain.run import utcnow


class NoticeService:
    def __init__(self, repository):
        self.repository = repository

    def save(self, notice, sources):
        identity = [notice.project_number, notice.lot_id, notice.notice_type] if notice.project_number and notice.lot_id else [notice.url, notice.notice_type]
        notice_id = "notice_" + content_hash(identity)[:32]
        notice = notice.model_copy(update={"notice_id": notice_id})
        with self.repository.db.write() as session:
            if notice.notice_type == "correction" and notice.project_number and notice.lot_id:
                for row in session.scalars(select(NoticeRow)):
                    old = row.data["notice"]
                    if (old.get("project_number"), old.get("lot_id"), old.get("notice_type")) == (notice.project_number, notice.lot_id, "tender"):
                        notice = notice.model_copy(update={"related_notice_id": row.notice_id})
                        break
            data = notice.model_dump(mode="json")
            row = session.get(NoticeRow, notice_id)
            if row is None:
                row = NoticeRow(notice_id=notice_id, data={"notice": data, "revision": 1, "versions": [], "updated_at": utcnow().isoformat()})
                session.add(row)
                session.flush()
            elif row.data["notice"] != data:
                row.data = {"notice": data, "revision": row.data["revision"] + 1,
                            "versions": row.data["versions"] + [{"revision": row.data["revision"], "notice": row.data["notice"]}],
                            "updated_at": utcnow().isoformat()}
            existing = {content_hash(r.data) for r in session.scalars(select(NoticeSourceRow).where(NoticeSourceRow.notice_id == notice_id))}
            for source in sources or [{"provider": p, "url": notice.url} for p in notice.providers]:
                source = {k: v for k, v in source.items() if k in {"provider", "url", "source_name", "published_date"}}
                if content_hash(source) not in existing:
                    session.add(NoticeSourceRow(notice_id=notice_id, data=source))
                    existing.add(content_hash(source))
        return notice
