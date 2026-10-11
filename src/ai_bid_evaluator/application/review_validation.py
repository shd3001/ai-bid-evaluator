"""Review submissions use the same rules and evidence checks as workers."""
from ai_bid_evaluator.domain.documents import ParsedDocument
from ai_bid_evaluator.domain.evaluation import EvaluationRule
from ai_bid_evaluator.domain.opportunity import CompanyProfile, OpportunityAssessment
from ai_bid_evaluator.domain.exceptions import DomainError
from ai_bid_evaluator.workflows.contracts import BidAssessment, parsed_sources, verify_evidence, validate_profile_evidence
from ai_bid_evaluator.rules.qualification import evaluate_qualification
from ai_bid_evaluator.rules.scoring import validate_score_result, scoring_leaves


def validate_review_output(name, run_type, before, after, outputs):
    if name == "profile":
        profile = CompanyProfile.model_validate(after)
        if profile.company_id != before.get("company_id") or profile.revision != before.get("revision"):
            raise DomainError("企业身份和版本不能通过复核改写")
        sources = parsed_sources(outputs.get("ingest", {"documents": []}))
        validate_profile_evidence(profile, [s["document"] for s in sources if s["role"] == "profile"])
        return profile.model_dump(mode="json")
    if name == "ingest":
        original = {s["parsed"]["document_id"]: s for s in before["documents"]}
        edited = after["documents"]
        if len(edited) != len(original) or {s["parsed"]["document_id"] for s in edited} != set(original):
            raise DomainError("不能删除、增加或重关联文档")
        for s in edited:
            doc = ParsedDocument.model_validate(s["parsed"])
            old = original[doc.document_id]
            if (s["role"], s["bidder_id"], doc.document_hash) != (old["role"], old["bidder_id"], old["parsed"]["document_hash"]):
                raise DomainError("文档身份、角色或哈希被修改")
            if not doc.chunks or any(not c.text.strip() for c in doc.chunks):
                raise DomainError("空扫描材料须补录正文后复核")
            if any(c.document_id != doc.document_id or c.document_hash != doc.document_hash for c in doc.chunks):
                raise DomainError("文本块身份不匹配")
            from ai_bid_evaluator.services.document_ingestion import identify_chunks
            reviewed = doc.model_copy(update={"status": "ready", "chunks": identify_chunks([
                c.model_copy(update={"quality": "good"}) for c in doc.chunks])})
            s["parsed"] = reviewed.model_dump(mode="json")
        return after
    sources = parsed_sources(outputs.get("ingest", {"documents": []}))
    if name == "extract":
        rules = [EvaluationRule.model_validate(r) for r in after["rules"]]
        if not rules:
            raise DomainError("没有资格/评分规则，不能确认")
        if run_type == "bid_evaluation" and not {"qualification", "score"} <= {r.kind for r in rules}:
            raise DomainError("评标规则须包含资格和评分")
        seen = set()
        def validate(rule):
            if rule.rule_id in seen or not rule.evidence:
                raise DomainError("规则 ID 重复或缺少证据")
            seen.add(rule.rule_id)
            verify_evidence(rule.evidence, [s["document"] for s in sources if s["role"] in {"announcement", "tender"}])
            for child in rule.children:
                validate(child)
        for rule in rules:
            validate(rule)
        _, errors = scoring_leaves(rules)
        if run_type == "bid_evaluation" and errors:
            raise DomainError("评分规则不完整", {"reasons": errors})
        return after
    if name == "assess" and run_type == "bid_evaluation":
        result = BidAssessment.model_validate(after)
        rules = [EvaluationRule.model_validate(r) for r in outputs["extract"]["rules"]]
        expected = {s["bidder_id"] for s in sources if s["role"] == "bid"}
        if {q.bidder_id for q in result.qualifications} != expected or {s.bidder_id for s in result.scores} != expected or len(result.qualifications) != len(expected) or len(result.scores) != len(expected):
            raise DomainError("人工结果的投标人 ID 不完整或重复")
        qs, ss = [], []
        for q in result.qualifications:
            documents = [s["document"] for s in sources if s["bidder_id"] == q.bidder_id]
            for check in q.checks:
                verify_evidence(check.evidence, documents)
            checked = evaluate_qualification(q.bidder_id, q.checks, rules)
            if checked.status == "needs_review":
                raise DomainError("资格未知项尚未解决")
            qs.append(checked)
        for score in result.scores:
            documents = [s["document"] for s in sources if s["bidder_id"] == score.bidder_id]
            for item in score.items:
                verify_evidence(item.evidence, documents)
                if not item.evidence:
                    raise DomainError("评分证据缺失")
            checked = validate_score_result(score, rules)
            if not checked.valid:
                raise DomainError("评分校验失败", {"reasons": checked.errors})
            ss.append(checked)
        return BidAssessment(qualifications=qs, scores=ss, confirmed=True, score_alternatives=result.score_alternatives).model_dump(mode="json")
    if name == "assess":
        candidates = outputs["search"]["candidates"]
        expected = {c["candidate_id"] for c in candidates}
        assessments = [OpportunityAssessment.model_validate(a) for a in after["assessments"]]
        if len(assessments) != len(expected) or {a.candidate_id for a in assessments} != expected:
            raise DomainError("机会结果 ID 不完整或重复")
        for a in assessments:
            candidate = next(c for c in candidates if c["candidate_id"] == a.candidate_id)
            docs = [s["document"] for s in sources]
            if candidate.get("parsed"):
                docs.append(ParsedDocument.model_validate(candidate["parsed"]))
            verify_evidence(a.evidence, docs)
            from ai_bid_evaluator.rules.opportunity_filter import parse_notice, filter_notice
            from ai_bid_evaluator.domain.opportunity import OpportunityRequest
            from ai_bid_evaluator.domain.run import utcnow
            if candidate.get("parsed"):
                notice = parse_notice(candidate.get("notice", {}).get("notice_id", "notice_" + a.candidate_id), candidate["title"], candidate["url"],
                    ParsedDocument.model_validate(candidate["parsed"]), candidate.get("providers", []))
                filtered = filter_notice(notice, OpportunityRequest.model_validate(outputs.get("_request", {}).get("options") or {}), utcnow())
                if filtered.status == "unsuitable" and a.status == "unsuitable":
                    continue
                if filtered.status != "suitable":
                    raise DomainError("公告类型、时效或筛选条件未通过，不能确认推荐")
            from ai_bid_evaluator.rules.opportunity_qualification import validate_opportunity_qualification
            profile = CompanyProfile.model_validate(outputs["profile"])
            rules = [EvaluationRule.model_validate(r) for r in before.get("candidate_rules", {}).get(a.candidate_id, [])]
            if candidate.get("parsed"):
                checked = validate_opportunity_qualification(a, profile, rules,
                    [s["document"] for s in sources if s["role"] == "profile"], ParsedDocument.model_validate(candidate["parsed"]))
            else:
                checked = a.model_copy(update={"status": "needs_review"})
            if checked.status == "needs_review":
                raise DomainError("机会资格未知或证据缺失，不能确认推荐")
        from ai_bid_evaluator.workflows.opportunity_discovery import legacy_assessment
        after["legacy_results"] = [legacy_assessment(a) for a in assessments]
        return after
    raise DomainError("该步骤不能直接复核确认，请根据源材料重新执行")
