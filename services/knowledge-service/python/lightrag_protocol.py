"""Shared LightRAG worker protocol v1 validation and envelopes."""

from __future__ import annotations

from typing import Any


PROTOCOL_VERSION = 1
COMMANDS = {
    "health",
    "model-health",
    "ingest-document",
    "delete-document",
    "sync-course-batch",
    "query-course",
}


class ProtocolError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def decode_request(value: Any) -> tuple[str, str, dict[str, Any]]:
    if not isinstance(value, dict):
        raise ProtocolError("REQUEST_INVALID", "request must be a JSON object")
    if value.get("protocolVersion") != PROTOCOL_VERSION:
        raise ProtocolError("PROTOCOL_VERSION_UNSUPPORTED", "Unsupported LightRAG protocol version")
    request_id = value.get("requestId")
    if not isinstance(request_id, str) or not request_id:
        raise ProtocolError("REQUEST_ID_INVALID", "requestId must be a non-empty string")
    command = value.get("command")
    if not isinstance(command, str) or command not in COMMANDS:
        raise ProtocolError("COMMAND_UNKNOWN", f"Unsupported LightRAG command: {command}")
    payload = value.get("payload")
    if not isinstance(payload, dict):
        raise ProtocolError("PAYLOAD_INVALID", "payload must be a JSON object")
    return request_id, command, payload


def success(request_id: str, result: Any) -> dict[str, Any]:
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "requestId": request_id,
        "ok": True,
        "result": result,
    }


def failure(request_id: str, code: str, message: str) -> dict[str, Any]:
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "requestId": request_id,
        "ok": False,
        "error": {"code": code, "message": message},
    }
