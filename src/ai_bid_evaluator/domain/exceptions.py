class DomainError(Exception):
    code = "invalid_request"
    http_status = 400

    def __init__(self, message: str, details: dict | None = None):
        super().__init__(message)
        self.details = details or {}


class NotFound(DomainError):
    code = "not_found"
    http_status = 404


class Conflict(DomainError):
    code = "conflict"
    http_status = 409


class UnsupportedFormat(DomainError):
    code = "unsupported_format"
    http_status = 415


class ModelFailure(DomainError):
    code = "model_failure"
    http_status = 503


class ConfigurationError(ModelFailure):
    code = "configuration_missing"
