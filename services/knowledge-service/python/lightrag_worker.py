"""JSON stdin/stdout bridge for the project-local LightRAG runtime."""

from __future__ import annotations

import asyncio
import contextlib
import json
import io
import platform
import sys
from importlib.metadata import version
from pathlib import Path
from typing import Any


def failure(command: str, error_type: str, message: str) -> dict[str, Any]:
    return {
        "ok": False,
        "command": command,
        "error": {"type": error_type, "message": message},
    }


def health(request: dict[str, Any]) -> dict[str, Any]:
    working_dir_value = request.get("workingDir")
    if not isinstance(working_dir_value, str) or not working_dir_value:
        return failure("health", "RequestError", "workingDir must be a non-empty string")

    working_dir = Path(working_dir_value).expanduser().resolve()
    try:
        working_dir.mkdir(parents=True, exist_ok=True)
        if not working_dir.is_dir():
            return failure("health", "WorkingDirectoryError", f"Not a directory: {working_dir}")

        import lightrag  # noqa: F401
        from lightrag import LightRAG, QueryParam  # noqa: F401

        package_version = version("lightrag-hku")
    except Exception as error:  # pragma: no cover - exercised by runtime failures
        return failure("health", type(error).__name__, str(error))

    return {
        "ok": True,
        "command": "health",
        "runtime": {
            "package": "lightrag-hku",
            "version": package_version,
            "pythonVersion": platform.python_version(),
            "workingDir": str(working_dir),
        },
    }


def working_dir(request: dict[str, Any]) -> Path:
    value = request.get("workingDir")
    if not isinstance(value, str) or not value:
        raise ValueError("workingDir must be a non-empty string")
    path = Path(value).expanduser().resolve()
    path.mkdir(parents=True, exist_ok=True)
    if not path.is_dir():
        raise NotADirectoryError(f"Not a directory: {path}")
    return path


def validate_document(request: dict[str, Any]) -> dict[str, Any]:
    document = request.get("document")
    if not isinstance(document, dict):
        raise ValueError("document must be a JSON object")
    for field in ("documentId", "resourceId", "text", "sourcePath"):
        value = document.get(field)
        if not isinstance(value, str) or not value:
            raise ValueError(f"document.{field} must be a non-empty string")
    course = document.get("course")
    if course is not None and not isinstance(course, str):
        raise ValueError("document.course must be a string or null")
    return document


async def handle(request: Any) -> dict[str, Any]:
    if not isinstance(request, dict):
        return failure("unknown", "RequestError", "request must be a JSON object")
    command = request.get("command")
    command_name = command if isinstance(command, str) else "unknown"
    if command == "health":
        return health(request)
    if command == "model-health":
        working_dir(request)
        from lightrag_runtime import check_embedding, check_llm

        llm = await check_llm()
        embedding = await check_embedding()
        return {
            "ok": True,
            "command": "model-health",
            "models": {"llm": llm, "embedding": embedding},
        }
    if command == "ingest-document":
        document = validate_document(request)
        from lightrag_runtime import ingest_document

        return {
            "ok": True,
            "command": "ingest-document",
            "ingestion": await ingest_document(request["workingDir"], document),
        }
    return failure(command_name, "CommandError", f"Unsupported command: {command_name}")


def command_name(request: Any) -> str:
    if isinstance(request, dict) and isinstance(request.get("command"), str):
        return request["command"]
    return "unknown"


async def main() -> None:
    request: Any = None
    captured_stdout = io.StringIO()
    try:
        request = json.load(sys.stdin)
        with contextlib.redirect_stdout(captured_stdout):
            response = await handle(request)
    except Exception as error:  # pragma: no cover - malformed process input
        response = failure(command_name(request), type(error).__name__, str(error))
    diagnostics = captured_stdout.getvalue()
    if diagnostics:
        sys.stderr.write(diagnostics)
    sys.stdout.write(json.dumps(response, ensure_ascii=False))


if __name__ == "__main__":
    asyncio.run(main())
