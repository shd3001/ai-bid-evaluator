import asyncio
from ai_bid_evaluator.cli import run_cli


async def main():
    await run_cli("bid_evaluation")


if __name__ == "__main__":
    asyncio.run(main())
