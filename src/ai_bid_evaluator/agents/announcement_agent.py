from ai_bid_evaluator.prompts.announcement_prompt import ANNOUNCEMENT_QUALIFICATION_PROMPT
from ai_bid_evaluator.services.agent_client import AgentFactory


class AnnouncementQualificationAgent:
    def __init__(self, factory: AgentFactory) -> None:
        self.factory = factory

    async def run(
        self,
        project_name: str,
        bidder_name: str,
        bid_file_id: str | None,
        bid_markdown_content: str | None,
        announcement_extract: dict ,
    ) -> dict:
        agent = self.factory.create_doc_agent(
            name="AnnouncementQualificationScoringAgent",
            instructions=ANNOUNCEMENT_QUALIFICATION_PROMPT,
        )
        return await self.factory.run_doc_json(
            agent=agent,
            file_id=bid_file_id,
            payload={
                "project_name": project_name,
                "bidder_name": bidder_name,
                "bid_markdown_content": bid_markdown_content,
                "announcement_extract": announcement_extract,
                "task": "请根据招标公告中的资质要求，对投标文件进行资格审查并评分。",
            },
        )
