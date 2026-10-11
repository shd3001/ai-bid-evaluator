from typing import Annotated, Literal
from fastapi import APIRouter, Depends, Form, UploadFile, File
from starlette.concurrency import run_in_threadpool
from ai_bid_evaluator.api.schemas import DocumentResponse, DocumentChunk, Page
from ai_bid_evaluator.api.dependencies import get_document_service, get_query_service
from ai_bid_evaluator.domain.base import Identifier
from .common import Limit, Cursor

router = APIRouter(tags=["documents"])


@router.post("/documents", status_code=201, response_model=DocumentResponse, operation_id="documents_upload")
async def upload_document(project_id: Annotated[Identifier, Form()], role: Annotated[Literal["announcement", "tender", "bid", "profile"], Form()],
                          file: Annotated[UploadFile, File()], bidder_id: Annotated[Identifier | None, Form()] = None,
                          service=Depends(get_document_service)):
    try:
        return await run_in_threadpool(service.upload, file.file, file.filename, project_id, role, bidder_id)
    finally:
        await file.close()


@router.get("/documents/{document_id}", response_model=DocumentResponse, operation_id="documents_get")
def document(document_id: Identifier, service=Depends(get_query_service)):
    return service.document(document_id)


@router.get("/documents/{document_id}/chunks", response_model=Page[DocumentChunk], operation_id="documents_chunks")
def chunks(document_id: Identifier, limit: Limit = 20, cursor: Cursor = None, service=Depends(get_query_service)):
    return service.chunks(document_id, limit, cursor)
