from pydantic import Field
from ai_bid_evaluator.domain.base import Contract, Identifier
from ai_bid_evaluator.domain.evaluation import EvaluationRule, QualificationCheck, QualificationResult, ScoreItem, ScoreResult
from ai_bid_evaluator.domain.opportunity import OpportunityAssessment
from ai_bid_evaluator.domain.documents import ParsedDocument, DocumentInput
from ai_bid_evaluator.domain.exceptions import DomainError
from ai_bid_evaluator.services.document_ingestion import chunk_document


class RuleExtraction(Contract):
    rules: list[EvaluationRule] = Field(default_factory=list)


class BidderAssessment(Contract):
    bidder_id: Identifier
    checks: list[QualificationCheck] = Field(default_factory=list)
    items: list[ScoreItem] = Field(default_factory=list)


class BidAssessment(Contract):
    qualifications: list[QualificationResult]
    scores: list[ScoreResult]
    confirmed: bool = False
    score_alternatives: dict[str, dict[str, list[ScoreItem]]] = Field(default_factory=dict)


def verify_evidence(evidence, documents):
    chunks = {c.chunk_id: c for doc in documents for c in doc.chunks}
    for ref in evidence:
        source = chunks.get(ref.chunk_id)
        if source is None or ref.document_id != source.document_id or ref.document_hash != source.document_hash or ref.quote not in source.text:
            raise DomainError("证据与源文档不一致")
        for field in ("page", "sheet", "row_start", "row_end", "column_start", "column_end"):
            if getattr(ref, field) != getattr(source, field):
                raise DomainError("证据定位与源文本块不一致")


def validate_profile_evidence(profile, documents):
    verify_evidence(profile.evidence, documents)
    # Store source wording, not an unsupported normalized qualification label.
    compact = lambda text: "".join(text.split())
    for qualification in profile.qualifications:
        if not compact(qualification) or not any(compact(qualification) in compact(e.quote) for e in profile.evidence):
            raise DomainError("企业资格主张缺少逐项来源证据")


def serialized_ingest(repository, run_id, max_tokens):
    sources = repository.documents(run_id)
    result = []
    review = False
    for source in sources:
        doc = source["document"]
        if doc.status == "failed":
            raise DomainError("材料解析失败")
        chunks = chunk_document(doc, max_tokens)
        parsed = doc.model_copy(update={"chunks": chunks})
        repository.register_chunks(parsed)
        result.append({"role": source["role"], "bidder_id": source["bidder_id"], "parsed": parsed.model_dump(mode="json")})
        review = review or doc.status != "ready" or not chunks
    return {"documents": result, "confirmed": not review}, review


def parsed_sources(ingest):
    return [{**s, "document": ParsedDocument.model_validate(s["parsed"])} for s in ingest["documents"]]


async def extract_rules(gateway, sources, task):
    rules = {}
    for source in sources:
        document = source["document"]
        for chunk in document.chunks:
            extracted = await gateway.generate_json(task, {"chunk": chunk.model_dump(mode="json")}, RuleExtraction,
                [DocumentInput(document_id=document.document_id, text=chunk.text)])
            def unconfirm(rule):
                verify_evidence(rule.evidence, [document])
                return rule.model_copy(update={"confirmed": False, "children": [unconfirm(c) for c in rule.children]})
            for rule in extracted.rules:
                rule = unconfirm(rule)
                if rule.rule_id in rules:
                    old = rules[rule.rule_id]
                    if old.model_dump(exclude={"evidence"}) != rule.model_dump(exclude={"evidence"}):
                        raise DomainError("重复规则 ID 定义冲突，需修正提取结果")
                    rule = old.model_copy(update={"evidence": old.evidence + rule.evidence})
                rules[rule.rule_id] = rule
    return list(rules.values())
