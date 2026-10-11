from ai_bid_evaluator.prompts.scoring_prompt import SCORE_INSTRUCTIONS
from ai_bid_evaluator.services.agent_client import AgentFactory


class ScoringAgent:
    def __init__(self, factory: AgentFactory) -> None:
        self.factory = factory

    async def run(
                self,
                project_name: str,
                bidder_name: str,
                bid_file_id: str | None,
                bid_markdown_content: str | None,
                scoring_conditions: list,
                qualification_result: dict,
    ) -> dict:
        agent = self.factory.create_doc_agent(
            name="BidScoringAgent",
            instructions=SCORE_INSTRUCTIONS,
        )

        return await self.factory.run_doc_json(
            agent=agent,
            file_id=bid_file_id,
            payload={
                "project_name": project_name,
                "bidder_name": bidder_name,
                "bid_markdown_content": bid_markdown_content,
                "scoring_conditions": scoring_conditions,
                "qualification_result": qualification_result,
                "task": "请根据 scoring_conditions 中的评审因素与评分标准，对投标文件进行逐项打分。",
            },
        )