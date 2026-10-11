from tempfile import SpooledTemporaryFile
from starlette.responses import JSONResponse


class UploadBodyLimit:
    """Bound multipart bytes before the framework spools/parses the request.

    64 KiB is reserved for multipart boundaries and metadata. The document
    service independently enforces the exact file-byte limit.
    """
    def __init__(self, app, limit):
        self.app, self.limit = app, limit + 65536

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] != "POST" or scope["path"] != "/api/v1/documents":
            return await self.app(scope, receive, send)
        with SpooledTemporaryFile(max_size=1024 * 1024) as body:
            total = 0
            while True:
                message = await receive()
                if message["type"] == "http.disconnect":
                    return
                chunk = message.get("body", b"")
                total += len(chunk)
                if total > self.limit:
                    response = JSONResponse({"error": {"code": "upload_too_large", "message": "上传请求超过大小限制", "details": {},
                        "request_id": scope.get("state", {}).get("request_id", "unknown")}}, status_code=413)
                    return await response(scope, receive, send)
                body.write(chunk)
                if not message.get("more_body", False):
                    break
            body.seek(0)
            async def bounded_receive():
                chunk = body.read(65536)
                return {"type": "http.request", "body": chunk, "more_body": body.tell() < total}
            await self.app(scope, bounded_receive, send)
