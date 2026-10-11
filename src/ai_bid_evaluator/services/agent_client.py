from dataclasses import dataclass
from typing import Any
from pydantic import RootModel
from ai_bid_evaluator.domain.documents import DocumentInput
from ai_bid_evaluator.services.llm_gateway import LLMGateway, BailianClient


@dataclass(frozen=True)
class DocAgent:
    name: str
    instructions: str


class JSONObject(RootModel[dict[str, Any]]):
    pass


class AgentFactory:
    """Legacy agent signatures bridged to the shared bounded gateway."""
    def __init__(self, settings, client=None):
        self.settings = settings
        self.doc_gateway = LLMGateway(client or BailianClient(settings), model=settings.doc_model,
            max_attempts=settings.retry_count, retry_seconds=settings.retry_seconds, timeout_seconds=settings.model_timeout_seconds)
        self.text_gateway = LLMGateway(client or BailianClient(settings, model=settings.agent_model), model=settings.agent_model,
            max_attempts=settings.retry_count, retry_seconds=settings.retry_seconds, timeout_seconds=settings.model_timeout_seconds)

    def create_doc_agent(self, name, instructions):
        return DocAgent(name=name, instructions=instructions)

    def create_text_agent(self, name, instructions):
        return DocAgent(name=name, instructions=instructions)

    async def run_doc_json(self, agent, file_id, payload):
        documents = [DocumentInput(document_id="legacy", file_id=file_id)] if file_id else []
        result = await self.doc_gateway.generate_json(agent.name, {"instructions": agent.instructions, **payload}, JSONObject, documents)
        return result.root

    async def run_text_json(self, agent, payload):
        result = await self.text_gateway.generate_json(agent.name, {"instructions": agent.instructions, **payload}, JSONObject, [])
        return result.root

    async def close(self):
        await self.doc_gateway.close()
        if self.text_gateway.client is not self.doc_gateway.client:
            await self.text_gateway.close()
