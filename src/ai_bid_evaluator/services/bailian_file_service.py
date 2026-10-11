from pathlib import Path

from openai import OpenAI

from ai_bid_evaluator.config import Settings


class BailianFileService:
    def __init__(self, settings: Settings) -> None:
        self.client = OpenAI(
            api_key=settings.api_key,
            base_url=settings.base_url,
        )

    def upload_file(self, file_path: Path) -> str:
        if not file_path.exists():
            raise FileNotFoundError(f"文件不存在：{file_path}")

        file_object = self.client.files.create(
            file=file_path,
            purpose="file-extract",
        )

        return file_object.id