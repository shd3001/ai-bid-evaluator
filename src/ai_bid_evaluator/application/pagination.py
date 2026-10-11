import base64
import json
from ai_bid_evaluator.domain.exceptions import DomainError


def decode_cursor(cursor, scope, numeric=False):
    if cursor is None:
        return None
    try:
        if len(cursor) > 2000:
            raise ValueError()
        value = json.loads(base64.urlsafe_b64decode(cursor.encode()))
        if value["scope"] != scope or not isinstance(value["after"], str):
            raise ValueError()
        return int(value["after"]) if numeric else value["after"]
    except (ValueError, KeyError, TypeError, UnicodeError):
        raise DomainError("分页游标无效或不属于当前查询") from None


def page(rows, limit, scope, key, convert):
    has_more = len(rows) > limit
    rows = rows[:limit]
    cursor = None
    if has_more:
        cursor = base64.urlsafe_b64encode(json.dumps({"scope": scope, "after": str(key(rows[-1]))}).encode()).decode()
    return {"items": [convert(row) for row in rows], "next_cursor": cursor}
