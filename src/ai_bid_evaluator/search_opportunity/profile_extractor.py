from ai_bid_evaluator.search_opportunity.prompts.profile_extract_prompt import PROFILE_EXTRACT_PROMPT
from ai_bid_evaluator.services.agent_client import AgentFactory


class ProfileExtractorAgent:
    def __init__(self, factory: AgentFactory) -> None:
        self.factory = factory

    async def run(self, company_name: str, bid_markdown_content: str) -> dict:
        agent = self.factory.create_doc_agent(
            name="CompanyProfileExtractor",
            instructions=PROFILE_EXTRACT_PROMPT,
        )

        return await self.factory.run_doc_json(
            agent=agent,
            file_id=None,
            payload={
                "company_name": company_name,
                "bid_markdown_content": bid_markdown_content,
                "task": "请从投标文件中提取企业能力画像。",
            },
        )
