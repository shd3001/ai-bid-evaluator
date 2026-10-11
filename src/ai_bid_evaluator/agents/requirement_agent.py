from ai_bid_evaluator.prompts.extract_prompt import QUALIFICATION_EXTRACT_PROMPT
from ai_bid_evaluator.services.agent_client import AgentFactory
from ai_bid_evaluator.domain.documents import DocumentInput


class RequirementAgent:
    def __init__(self, factory: AgentFactory) -> None:
        self.factory = factory

    async def run(self, project_name: str, tender_file_id: str | None, tender_markdown: str | None = None) -> dict:
        document = DocumentInput(document_id="tender", file_id=tender_file_id, text=tender_markdown)
        agent = self.factory.create_doc_agent(
            name="QualificationExtractor",
            instructions=QUALIFICATION_EXTRACT_PROMPT,
        )

        return await self.factory.run_doc_json(
            agent=agent,
            file_id=tender_file_id,
            payload={
                "project_name": project_name,
                "document_text": document.text,
                "task": "请从招标文件中提取资格评审标准和废标规则。不要提取评分标准。",
            },
        )
