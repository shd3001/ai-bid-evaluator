from ai_bid_evaluator.prompts.qualification_prompt import QUALIFICATION_INSTRUCTIONS
from ai_bid_evaluator.services.agent_client import AgentFactory


class QualificationAgent:
    def __init__(self, factory: AgentFactory) -> None:
        self.factory = factory

    async def run(
        self,
        project_name: str,
        bidder_name: str,
        bid_file_id: str | None,
        bid_markdown_content: str | None,
        extracted_requirements: dict,
    ) -> dict:
        agent = self.factory.create_doc_agent(
            name="QualificationScoringAgent",
            instructions=QUALIFICATION_INSTRUCTIONS,
        )

        return await self.factory.run_doc_json(
            agent=agent,
            file_id=bid_file_id,
            payload={
                "project_name": project_name,
                "bidder_name": bidder_name,
                "bid_markdown_content": bid_markdown_content,
                "qualification_requirements": extracted_requirements.get("qualification_review_standards", []),
                "disqualification_rules": extracted_requirements.get("disqualification_rules", []),
                "task": "请先对该投标人的资质要求进行评分和资格审查。",
            },
        )