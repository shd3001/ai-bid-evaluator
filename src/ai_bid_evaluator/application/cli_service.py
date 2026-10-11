import asyncio
from pathlib import Path
from uuid import uuid4
from ai_bid_evaluator.domain.run import RunCreate
from ai_bid_evaluator.domain.opportunity import OpportunityRequest
from ai_bid_evaluator.domain.exceptions import DomainError
from ai_bid_evaluator.infrastructure.orm_models import ProjectRow, BidderRow, DocumentRow, DocumentChunkRow
from ai_bid_evaluator.infrastructure.repositories import replay, remember
from ai_bid_evaluator.services.document_ingestion import ingest_document
from .run_service import RunService


async def submit_legacy_input(repository, project_root: Path, raw: dict, run_type: str, key: str):
    bids = raw.get("bid_files", [])
    if not bids:
        raise DomainError("输入缺少投标材料")
    if run_type == "opportunity_discovery" and len(bids) != 1:
        raise DomainError("机会任务首版需要且只接受一家企业材料")
    files = []
    if run_type == "bid_evaluation":
        for role in ("announcement", "tender"):
            if not raw.get(f"{role}_file"):
                raise DomainError("评标缺少公告或招标文件")
            files.append((role, None, raw[f"{role}_file"]))
    files.extend(("bid" if run_type == "bid_evaluation" else "profile", index, bid["file"]) for index, bid in enumerate(bids))
    parsed = []
    for role, index, value in files:
        path = Path(value)
        if not path.is_absolute():
            path = project_root / path
        doc = await asyncio.to_thread(ingest_document, path, f"doc_{uuid4().hex}")
        parsed.append((role, index, doc))
    request = {"type": run_type, "input": raw, "hashes": [d.document_hash for _, _, d in parsed]}
    # Parsing is outside the write transaction; registration and run creation commit together.
    with repository.db.write() as session:
        cached = replay(session, "cli_submit", key, request)
        if cached:
            return cached
        project_id = f"project_{uuid4().hex}"
        session.add(ProjectRow(project_id=project_id, name=raw.get("project_name") or "辅助评审项目"))
        session.flush()
        bidder_ids = {}
        if run_type == "bid_evaluation":
            for index, bid in enumerate(bids):
                bidder_id = f"bidder_{uuid4().hex}"
                bidder_ids[index] = bidder_id
                session.add(BidderRow(bidder_id=bidder_id, project_id=project_id, name=bid.get("bidder_name") or "投标人"))
            session.flush()
        for role, index, doc in parsed:
            session.add(DocumentRow(document_id=doc.document_id, project_id=project_id,
                                    role=role, bidder_id=bidder_ids.get(index) if role == "bid" else None, data=doc.model_dump(mode="json")))
            session.flush()
            for chunk in doc.chunks:
                session.add(DocumentChunkRow(chunk_id=chunk.chunk_id, document_id=doc.document_id, data=chunk.model_dump(mode="json")))
        session.flush()
        budget = raw.get("budget") or {}
        options = None
        if run_type == "opportunity_discovery":
            options = OpportunityRequest(queries=raw.get("search_queries_override") or [], regions=raw.get("regions") or [],
                max_candidates=raw.get("max_candidates") or 5, min_budget=budget.get("min"), max_budget=budget.get("max"))
        run = RunService(repository)._create_in_session(session, RunCreate(type=run_type, project_id=project_id,
                    document_ids=[d.document_id for _, _, d in parsed], options=options), f"cli_run:{key}")
        remember(session, "cli_submit", key, request, run)
        return run
