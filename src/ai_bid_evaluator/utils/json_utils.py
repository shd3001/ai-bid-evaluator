import json
import re
from pathlib import Path
from typing import Any, Callable


def response_to_text(response: Any) -> str:
    if response is None:
        return ""

    if isinstance(response, str):
        return response

    text = getattr(response, "text", None)
    if text:
        return str(text)

    messages = getattr(response, "messages", None)
    if messages:
        for message in reversed(messages):
            content = getattr(message, "content", None)
            text = getattr(message, "text", None)

            if text:
                return str(text)

            if content:
                return content_to_text(content)

    content = getattr(response, "content", None)
    if content:
        return content_to_text(content)

    return str(response)


def content_to_text(content: Any) -> str:
    if isinstance(content, str):
        return content

    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                parts.append(str(item.get("text") or item.get("content") or ""))
            else:
                parts.append(str(getattr(item, "text", "") or getattr(item, "content", "")))
        return "\n".join(part for part in parts if part)

    return str(content)


def parse_json_response(response: Any) -> dict[str, Any]:
    text = response_to_text(response).strip()

    while text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text, count=1).strip()
        text = re.sub(r"\s*```$", "", text, count=1).strip()

    try:
        result = json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start == -1 or end == -1 or end <= start:
            raise ValueError("模型返回内容不是有效 JSON")
        result = json.loads(text[start:end + 1])
    if not isinstance(result, dict):
        raise ValueError("模型返回 JSON 顶层必须是对象")
    return result


def save_text_from_json(input_path: Path, output_path: Path, generator: Callable[[dict[str, Any]], str]) -> None:
    data = json.loads(input_path.read_text(encoding="utf-8"))
    text = generator(data)
    output_path.write_text(text, encoding="utf-8")
