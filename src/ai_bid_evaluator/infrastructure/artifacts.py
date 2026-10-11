import json
import os
from pathlib import Path
import re
import tempfile


class ArtifactStore:
    def __init__(self, root: Path):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def path(self, run_id: str, name: str, suffix=".json") -> Path:
        for value in (run_id, name):
            if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", value) or value.upper() in {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1,10)), *(f"LPT{i}" for i in range(1,10))}:
                raise ValueError("产物标识不合法")
        if suffix not in {".json", ".md", ".txt"}:
            raise ValueError("产物格式不合法")
        target = (self.root / run_id / f"{name}{suffix}").resolve()
        if not target.is_relative_to(self.root):
            raise ValueError("产物路径超出受控目录")
        return target

    def write_json(self, run_id: str, name: str, data: dict) -> Path:
        return self.write_text(run_id, name, json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False))

    def write_text(self, run_id: str, name: str, content: str, suffix=".json") -> Path:
        target = self.path(run_id, name, suffix)
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=target.parent, delete=False) as handle:
                temporary = Path(handle.name)
                handle.write(content)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, target)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
        return target
