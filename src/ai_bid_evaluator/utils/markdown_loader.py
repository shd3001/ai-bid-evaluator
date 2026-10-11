from pathlib import Path

from markitdown import MarkItDown


def load_file_as_markdown(file_path: Path) -> str:
    converter = MarkItDown()
    result = converter.convert(str(file_path))

    text = result.text_content or ""

    if not text.strip():
        raise ValueError(f"文件转换为空，无法传给模型：{file_path}")

    return text