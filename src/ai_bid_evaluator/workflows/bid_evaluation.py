import asyncio
from decimal import Decimal
from ai_bid_evaluator.domain.documents import DocumentInput
from ai_bid_evaluator.domain.evaluation import QualificationCheck, ScoreResult
from ai_bid_evaluator.domain.exceptions import DomainError
from ai_bid_evaluator.rules.qualification import evaluate_qualification
from ai_bid_evaluator.rules.scoring import validate_score_result
from ai_bid_evaluator.reporting.bid_report import build_bid_report
from ai_bid_evaluator.worker.runner import StepOutcome
from .contracts import (BidderAssessment, BidAssessment, RuleExtraction, verify_evidence,
                        serialized_ingest, parsed_sources, extract_rules)


class BidEvaluationWorkflow:
    def __init__(self, repository, gateway, *, max_tokens=8000):
        self.repository, self.gateway, self.max_tokens = repository, gateway, max_tokens

    async def execute(self, name, state, outputs):
        if name == "ingest":
            output, review = await asyncio.to_thread(serialized_ingest, self.repository, state.run_id, self.max_tokens)
            return StepOutcome(output, review)
        sources = parsed_sources(outputs["ingest"])
        if name == "extract":
            rules = await extract_rules(self.gateway, [s for s in sources if s["role"] in {"announcement", "tender"}], "extract_rules")
            return StepOutcome({"rules": [r.model_dump(mode="json") for r in rules], "confirmed": False}, True)
        rules = RuleExtraction.model_validate({"rules": outputs["extract"]["rules"]}).rules
        if name == "assess":
            qualifications, scores, alternatives = [], [], {}
            bidder_ids = sorted({s["bidder_id"] for s in sources if s["role"] == "bid"})
            for bidder_id in bidder_ids:
                documents = [s["document"] for s in sources if s["role"] == "bid" and s["bidder_id"] == bidder_id]
                checks, items, inconsistencies = {}, {}, []
                alternatives[bidder_id] = {}
                for document in documents:
                    for chunk in document.chunks:
                        extracted = await self.gateway.generate_json("assess_bidder",
                            {"bidder_id": bidder_id, "rules": [r.model_dump(mode="json") for r in rules], "chunk": chunk.model_dump(mode="json")},
                            BidderAssessment, [DocumentInput(document_id=document.document_id, text=chunk.text)])
                        if extracted.bidder_id != bidder_id:
                            raise DomainError("模型返回错误投标人 ID")
                        for check in extracted.checks:
                            verify_evidence(check.evidence, documents)
                            checks.setdefault(check.rule_id, []).append(check)
                        for item in extracted.items:
                            verify_evidence(item.evidence, documents)
                            alternatives[bidder_id].setdefault(item.rule_id, []).append(item)
                for rule_id, values in alternatives[bidder_id].items():
                    if len(values) == 1:
                        items[rule_id] = values[0]
                    else:
                        # Equal partial scores may describe independent additive facts.
                        # Preserve all candidates and require an explicit final item.
                        inconsistencies.append(f"分块评分须汇总复核 {rule_id}")
                combined = []
                for rule_id, values in checks.items():
                    definite = {v.status for v in values if v.status != "needs_review"}
                    status = next(iter(definite)) if len(definite) == 1 else "needs_review"
                    evidence = [e for v in values if v.status == status for e in v.evidence]
                    combined.append(QualificationCheck(rule_id=rule_id, status=status, evidence=evidence))
                qualifications.append(evaluate_qualification(bidder_id, combined, rules))
                scored = validate_score_result(ScoreResult(bidder_id=bidder_id, items=list(items.values())), rules)
                missing = [f"评分证据缺失 {i.rule_id}" for i in scored.items if not i.evidence]
                if missing or inconsistencies:
                    scored = scored.model_copy(update={"valid": False, "errors": scored.errors + missing + inconsistencies})
                scores.append(scored)
            review = any(q.status == "needs_review" for q in qualifications) or any(not s.valid for s in scores)
            output = BidAssessment(qualifications=qualifications, scores=scores, confirmed=not review, score_alternatives=alternatives)
            return StepOutcome(output.model_dump(mode="json"), review)
        if name == "report":
            assessed = BidAssessment.model_validate(outputs["assess"])
            # Recompute after human edits, never trust stored/model valid flags.
            qs = [evaluate_qualification(q.bidder_id, q.checks, rules) for q in assessed.qualifications]
            ss = [validate_score_result(s, rules) for s in assessed.scores]
            for q in qs:
                for check in q.checks:
                    verify_evidence(check.evidence, [s["document"] for s in sources if s["bidder_id"] == q.bidder_id])
            for s in ss:
                for item in s.items:
                    verify_evidence(item.evidence, [source["document"] for source in sources if source["bidder_id"] == s.bidder_id])
                    if not item.evidence:
                        s.valid = False
                        s.errors.append(f"评分证据缺失 {item.rule_id}")
            project = self.repository.get_project(state.project_id)
            return StepOutcome(build_bid_report(project["name"], qs, ss))
        raise DomainError("未知评标步骤")
