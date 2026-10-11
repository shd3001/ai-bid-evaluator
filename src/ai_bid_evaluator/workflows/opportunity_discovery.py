import asyncio
from uuid import uuid4
from pathlib import Path
from ai_bid_evaluator.config import load_settings
from ai_bid_evaluator.domain.documents import DocumentInput, ParsedDocument
from ai_bid_evaluator.domain.opportunity import CompanyProfile, OpportunityAssessment, OpportunityRequest
from ai_bid_evaluator.domain.run import utcnow
from ai_bid_evaluator.rules.opportunity_filter import parse_notice, filter_notice, apply_notice_filter
from ai_bid_evaluator.application.notice_service import NoticeService
from ai_bid_evaluator.domain.exceptions import DomainError
from ai_bid_evaluator.search_opportunity.searcher import SearchService
from ai_bid_evaluator.search_opportunity.crawler import TenderCrawler
from ai_bid_evaluator.search_opportunity.keywords import generate_search_keywords
from ai_bid_evaluator.services.document_ingestion import ingest_document, chunk_document
from ai_bid_evaluator.reporting.opportunity_report import build_opportunity_report
from ai_bid_evaluator.worker.runner import StepOutcome
from .contracts import serialized_ingest, parsed_sources, verify_evidence, extract_rules, validate_profile_evidence
from ai_bid_evaluator.rules.opportunity_qualification import validate_opportunity_qualification


def legacy_assessment(a: OpportunityAssessment):
    return {"candidate_id": a.candidate_id, "suitability_status": {"suitable": "适合投标", "unsuitable": "不适合投标", "needs_review": "需人工复核"}[a.status],
            "suitability_score": str(a.score), "manual_review_points": a.reasons, "review_points": a.reasons,
            "evidence": [e.model_dump(mode="json") for e in a.evidence]}


class OpportunityDiscoveryWorkflow:
    def __init__(self, repository, gateway, *, searcher=None, crawler=None, settings=None, max_tokens=8000):
        self.repository, self.gateway = repository, gateway
        self.settings = settings
        self.searcher, self.crawler, self.max_tokens = searcher, crawler, max_tokens

    async def execute(self, name, state, outputs):
        if name == "ingest":
            output, review = await asyncio.to_thread(serialized_ingest, self.repository, state.run_id, self.max_tokens)
            return StepOutcome(output, review)
        if name == "profile":
            existing = state.input_snapshot.get("company_snapshot")
            if existing:
                profile = CompanyProfile.model_validate(existing)
                docs = [s["document"] for s in parsed_sources(outputs["ingest"]) if s["role"] == "profile"]
                # Rebase verified citations onto this run's budgeted chunks.
                references = []
                for ref in profile.evidence:
                    matches = [c for d in docs for c in d.chunks if c.document_id == ref.document_id
                        and c.document_hash == ref.document_hash and ref.quote in c.text
                        and all(getattr(c, f) == getattr(ref, f) for f in ("page", "sheet", "row_start", "row_end", "column_start", "column_end"))]
                    if not matches:
                        raise DomainError("画像证据跨越文本块，请重新提取和复核")
                    references.append(matches[0].evidence(ref.quote))
                profile = profile.model_copy(update={"evidence": references})
                validate_profile_evidence(profile, docs)
                return StepOutcome(profile.model_dump(mode="json"))
            sources = parsed_sources(outputs["ingest"])
            profiles = []
            company_id = f"company_{state.run_id.removeprefix('run_')}"
            for source in sources:
                if source["role"] != "profile":
                    continue
                doc = source["document"]
                for chunk in doc.chunks:
                    profile = await self.gateway.generate_json("extract_profile", {"company_id": company_id, "chunk": chunk.model_dump(mode="json")},
                        CompanyProfile, [DocumentInput(document_id=doc.document_id, text=chunk.text)])
                    if profile.company_id != company_id:
                        raise DomainError("企业画像 ID 不匹配")
                    verify_evidence(profile.evidence, [doc])
                    profiles.append(profile)
            if not profiles:
                raise DomainError("画像没有可用来源")
            merged = profiles[0].model_copy(update={"confirmed": False,
                "qualifications": sorted({q for p in profiles for q in p.qualifications}),
                "evidence": [e for p in profiles for e in p.evidence]})
            return StepOutcome(merged.model_dump(mode="json"), True)
        profile = CompanyProfile.model_validate(outputs["profile"])
        if name == "search":
            options = OpportunityRequest.model_validate(state.input_snapshot.get("options") or {})
            queries = options.queries or generate_search_keywords(profile.model_dump(mode="json"), regions=options.regions)
            settings = self.settings or load_settings()
            searcher = self.searcher or SearchService(settings)
            crawler = self.crawler or TenderCrawler(settings, out_dir=settings.project_root / "data" / "runs" / state.run_id / "crawled")
            candidates = await searcher.search(queries, max_candidates=options.max_candidates)
            diagnostics = getattr(searcher, "diagnostics", [])
            if diagnostics and all(d["status"] == "failed" for d in diagnostics):
                class SearchUnavailable(DomainError):
                    code = "search_unavailable"
                raise SearchUnavailable("所有搜索来源失败，不能视为成功无结果")
            rows = []
            for candidate in candidates:
                row = {"candidate_id": candidate.candidate_id, "title": candidate.title, "url": candidate.url,
                       "source_name": candidate.source_name, "provider": candidate.provider,
                       "providers": candidate.providers or ([candidate.provider] if candidate.provider else []), "sources": candidate.sources}
                try:
                    await crawler.crawl(candidate)
                    if candidate.fetch_status != "done" or candidate.md_path is None:
                        raise DomainError("公告抓取失败")
                    doc = await asyncio.to_thread(ingest_document, candidate.md_path, f"doc_{uuid4().hex}")
                    doc = doc.model_copy(update={"chunks": chunk_document(doc, self.max_tokens)})
                    notice = parse_notice(f"notice_{uuid4().hex}", candidate.title, candidate.url, doc, row["providers"])
                    notice = await asyncio.to_thread(NoticeService(self.repository).save, notice, row["sources"])
                    await asyncio.to_thread(self.repository.add_document, state.project_id, "announcement", doc)
                    row["notice"] = notice.model_dump(mode="json")
                    row["parsed"] = doc.model_dump(mode="json")
                    row["fetch_status"] = candidate.fetch_status
                except Exception:
                    row["fetch_status"] = "failed"
                    row["diagnostics"] = ["公告抓取或解析失败，需人工复核"]
                rows.append(row)
            return StepOutcome({"candidates": rows, "source_diagnostics": diagnostics})
        if name == "assess":
            assessments, candidate_rules = [], {}
            options = OpportunityRequest.model_validate(state.input_snapshot.get("options") or {})
            for candidate in outputs["search"]["candidates"]:
                candidate_id = candidate["candidate_id"]
                if candidate.get("fetch_status") != "done" or not candidate.get("parsed"):
                    assessments.append(OpportunityAssessment(candidate_id=candidate_id, reasons=["公告抓取失败"]))
                    continue
                doc = ParsedDocument.model_validate(candidate["parsed"])
                notice = parse_notice(candidate.get("notice", {}).get("notice_id", f"notice_{candidate_id}"), candidate["title"], candidate["url"], doc, candidate.get("providers", []))
                filtered = filter_notice(notice, options, utcnow()).model_copy(update={"candidate_id": candidate_id})
                if filtered.status == "unsuitable":
                    assessments.append(filtered)
                    continue
                if doc.status != "ready" or not profile.qualifications:
                    assessments.append(OpportunityAssessment(candidate_id=candidate_id, reasons=["公告质量或企业画像不足"]))
                    continue
                try:
                    rules = await extract_rules(self.gateway, [{"document": doc}], "extract_opportunity_rules")
                    candidate_rules[candidate_id] = [r.model_dump(mode="json") for r in rules]
                    if not rules:
                        assessments.append(OpportunityAssessment(candidate_id=candidate_id, reasons=["未提取到资格要求"]))
                        continue
                    result = await self.gateway.generate_json("assess_opportunity", {"candidate_id": candidate_id,
                        "company_profile": profile.model_dump(mode="json"), "rules": [r.model_dump(mode="json") for r in rules]}, OpportunityAssessment, [])
                    if result.candidate_id != candidate_id:
                        raise DomainError("机会判定 ID 不匹配")
                    result = validate_opportunity_qualification(result, profile, rules,
                        [s["document"] for s in parsed_sources(outputs["ingest"]) if s["role"] == "profile"], doc)
                    assessments.append(apply_notice_filter(result, notice, options, utcnow()))
                except asyncio.CancelledError:
                    raise
                except Exception:
                    assessments.append(OpportunityAssessment(candidate_id=candidate_id, reasons=["候选评估失败，需单独重试或人工复核"]))
            review = any(a.status == "needs_review" for a in assessments)
            return StepOutcome({"assessments": [a.model_dump(mode="json") for a in assessments],
                                "legacy_results": [legacy_assessment(a) for a in assessments], "candidate_rules": candidate_rules,
                                "source_diagnostics": outputs["search"].get("source_diagnostics", []),
                                "candidate_notices": {c["candidate_id"]: c.get("notice") for c in outputs["search"]["candidates"]},
                                "confirmed": not review}, review)
        if name == "report":
            assessments = [OpportunityAssessment.model_validate(a) for a in outputs["assess"]["assessments"]]
            options = OpportunityRequest.model_validate(state.input_snapshot.get("options") or {})
            for index, result in enumerate(assessments):
                candidate = next(c for c in outputs["search"]["candidates"] if c["candidate_id"] == result.candidate_id)
                if candidate.get("parsed"):
                    doc = ParsedDocument.model_validate(candidate["parsed"])
                    notice = parse_notice(candidate["notice"]["notice_id"], candidate["title"], candidate["url"], doc, candidate.get("providers", []))
                    assessments[index] = apply_notice_filter(result, notice, options, utcnow())
            report = build_opportunity_report(outputs["search"]["candidates"], [legacy_assessment(a) for a in assessments])
            report["confirmed"] = not report["manual_review"]
            report["source_diagnostics"] = outputs["search"].get("source_diagnostics", [])
            report["notices"] = {c["candidate_id"]: c.get("notice") for c in outputs["search"]["candidates"]}
            report["as_of"] = utcnow().isoformat()
            return StepOutcome(report)
        raise DomainError("未知机会步骤")
