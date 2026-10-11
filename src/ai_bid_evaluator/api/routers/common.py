from typing import Annotated
from fastapi import Query, Header
from ai_bid_evaluator.domain.exceptions import DomainError

Limit = Annotated[int, Query(ge=1, le=100)]
Cursor = Annotated[str | None, Query(max_length=2000)]


def idempotency_key(value: Annotated[str, Header(alias="Idempotency-Key", min_length=1, max_length=200)]):
    if not value.strip():
        raise DomainError("Idempotency-Key 不能为空")
    return value
