from ai_bid_evaluator.prompts.announcement_extract_prompt import ANNOUNCEMENT_QUALIFICATION_EXTRACT_PROMPT
from ai_bid_evaluator.services.agent_client import AgentFactory
from ai_bid_evaluator.domain.documents import DocumentInput

class AnnouncementQualificationExtractorAgent:
    def __init__(self, factory: AgentFactory) -> None:
        self.factory = factory

    async def run(
        self,
        project_name: str,
        announcement_file_id: str | None,
        announcement_markdown: str | None = None,
    ) -> dict:
        DocumentInput(document_id="announcement", file_id=announcement_file_id, text=announcement_markdown)
        agent = self.factory.create_doc_agent(
            name="AnnouncementQualificationExtractor",
            instructions=ANNOUNCEMENT_QUALIFICATION_EXTRACT_PROMPT,
        )

        payload = {
            "project_name": project_name,
            "task": "请从招标公告中提取资质要求。",
        }
        if announcement_markdown:
            payload["announcement_markdown"] = announcement_markdown

        return await self.factory.run_doc_json(
            agent=agent,
            file_id=announcement_file_id,
            payload=payload,
        )
