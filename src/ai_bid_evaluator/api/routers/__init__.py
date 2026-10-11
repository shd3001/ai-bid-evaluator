from fastapi import APIRouter
from ai_bid_evaluator.api.schemas import ErrorResponse
from . import projects, documents, runs, reviews, reports, companies


def business_router():
    router = APIRouter(prefix="/api/v1", responses={code: {"model": ErrorResponse} for code in [400, 404, 409, 413, 415, 422, 503]})
    for module in (projects, documents, runs, reviews, reports, companies):
        router.include_router(module.router)
    return router
