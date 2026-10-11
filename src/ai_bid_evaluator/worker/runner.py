import asyncio
from contextlib import suppress
from dataclasses import dataclass
from uuid import uuid4
from ai_bid_evaluator.domain.run import utcnow
from ai_bid_evaluator.domain.exceptions import Conflict, DomainError


@dataclass
class StepOutcome:
    output: dict
    awaiting_review: bool = False


class WorkerRunner:
    def __init__(self, repository, gateway, *, workflows=None, owner=None, lease_seconds=120,
                 heartbeat_seconds=30, clock=utcnow, artifacts=None):
        if not 0 < heartbeat_seconds < lease_seconds:
            raise ValueError("续租间隔必须小于租约时长")
        self.repository, self.gateway, self.artifacts = repository, gateway, artifacts
        self.owner = owner or f"worker_{uuid4().hex}"
        self.lease_seconds, self.heartbeat_seconds, self.clock = lease_seconds, heartbeat_seconds, clock
        if workflows is None:
            from ai_bid_evaluator.workflows.bid_evaluation import BidEvaluationWorkflow
            from ai_bid_evaluator.workflows.opportunity_discovery import OpportunityDiscoveryWorkflow
            workflows = {"bid_evaluation": BidEvaluationWorkflow(repository, gateway),
                         "opportunity_discovery": OpportunityDiscoveryWorkflow(repository, gateway)}
        self.workflows = workflows

    async def run_once(self, run_id=None):
        state = await asyncio.to_thread(self.repository.claim_next, self.owner, self.clock(), self.lease_seconds, run_id)
        if state is None:
            return None
        while state.status == "running" and state.owner == self.owner:
            state = await self.execute_next_step(state.run_id)
        return state

    async def execute_next_step(self, run_id):
        state = await asyncio.to_thread(self.repository.load, run_id)
        if state.owner != self.owner or state.status != "running":
            raise Conflict("worker 没有有效任务租约")
        if state.cancel_requested:
            return await asyncio.to_thread(self.repository.finish, run_id, self.owner)
        remaining = [name for name in state.known_steps if name not in state.completed_steps]
        if not remaining:
            return await asyncio.to_thread(self.repository.finish, run_id, self.owner)
        name = remaining[0]
        stored = await asyncio.to_thread(self.repository.steps, run_id)
        outputs = {step: data["output"] for step, data in stored.items() if not data.get("stale") and data.get("confirmed")}
        versions = {"model": getattr(self.gateway, "model", "none"), "prompt": getattr(self.gateway, "prompt_version", "1"),
                    "schema": getattr(self.gateway, "schema_version", "1")}
        await asyncio.to_thread(self.repository.begin_step, run_id, self.owner, name, {"snapshot": state.input_snapshot, "outputs": outputs}, versions)
        if self.gateway is not None and hasattr(self.gateway, "cancelled"):
            self.gateway.cancelled = lambda: self.repository.load(run_id).cancel_requested
            self.gateway.record = lambda metadata: self.repository.record_model(run_id, metadata)

        async def heartbeat():
            while True:
                await asyncio.sleep(self.heartbeat_seconds)
                await asyncio.to_thread(self.repository.renew_lease, run_id, self.owner, self.clock(), self.lease_seconds)

        pulse = asyncio.create_task(heartbeat())
        step = asyncio.create_task(self.workflows[state.type].execute(name, state, outputs))
        try:
            done, _ = await asyncio.wait({step, pulse}, return_when=asyncio.FIRST_COMPLETED)
            if pulse in done:
                await pulse
            outcome = await step
            # Stop heartbeat before committing a boundary that releases the lease.
            pulse.cancel()
            with suppress(asyncio.CancelledError):
                await pulse
            updated = await asyncio.to_thread(self.repository.checkpoint, run_id, self.owner, name, outcome.output,
                awaiting_review=outcome.awaiting_review, input_data={"snapshot": state.input_snapshot, "outputs": outputs}, versions=versions)
            if self.artifacts:
                await asyncio.to_thread(self.artifacts.write_json, run_id, name, outcome.output)
            if updated.cancel_requested and updated.status == "running":
                return await asyncio.to_thread(self.repository.finish, run_id, self.owner)
            return updated
        except asyncio.CancelledError:
            if self.repository.load(run_id).cancel_requested:
                return await asyncio.to_thread(self.repository.finish, run_id, self.owner)
            # Shutdown leaves the durable lease/checkpoint for expiration recovery.
            raise
        except Conflict:
            # A superseded worker must never write into its successor's task.
            return await asyncio.to_thread(self.repository.load, run_id)
        except Exception as exc:
            try:
                return await asyncio.to_thread(self.repository.fail, run_id, self.owner, getattr(exc, "code", "execution_failed"))
            except Conflict:
                return await asyncio.to_thread(self.repository.load, run_id)
        finally:
            pulse.cancel()
            step.cancel()
            for task in (pulse, step):
                with suppress(asyncio.CancelledError, Exception):
                    await task
