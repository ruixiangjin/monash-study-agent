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

from lightrag_protocol import ProtocolError, decode_request, failure, success
from runtime_config import load_runtime_config


def health(request: dict[str, Any]) -> dict[str, Any]:
    working_dir_value = request.get("workingDir")
    if not isinstance(working_dir_value, str) or not working_dir_value:
        raise ValueError("workingDir must be a non-empty string")

    working_dir = Path(working_dir_value).expanduser().resolve()
    try:
        working_dir.mkdir(parents=True, exist_ok=True)
        if not working_dir.is_dir():
            raise NotADirectoryError(f"Not a directory: {working_dir}")

        import lightrag  # noqa: F401
        from lightrag import LightRAG, QueryParam  # noqa: F401

        package_version = version("lightrag-hku")
    except Exception:
        raise

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


def validate_delete_document(request: dict[str, Any]) -> tuple[str, str | None]:
    document_id = request.get("documentId")
    if not isinstance(document_id, str) or not document_id:
        raise ValueError("documentId must be a non-empty string")
    course = request.get("course")
    if course is not None and not isinstance(course, str):
        raise ValueError("course must be a string or null")
    return document_id, course


def validate_course_batch(request: dict[str, Any]) -> tuple[str, list[dict[str, Any]]]:
    course = request.get("course")
    if not isinstance(course, str) or not course:
        raise ValueError("course must be a non-empty string")
    operations = request.get("operations")
    if not isinstance(operations, list):
        raise ValueError("operations must be a JSON array")
    validated: list[dict[str, Any]] = []
    for index, operation in enumerate(operations):
        if not isinstance(operation, dict):
            raise ValueError(f"operations[{index}] must be a JSON object")
        kind = operation.get("kind")
        if kind not in {"index", "replace", "remove"}:
            raise ValueError(f"operations[{index}].kind is invalid")
        if kind == "remove":
            document_id = operation.get("documentId")
            if not isinstance(document_id, str) or not document_id:
                raise ValueError(
                    f"operations[{index}].documentId must be a non-empty string"
                )
        else:
            validate_document({"document": operation.get("document")})
        validated.append(operation)
    return course, validated


def validate_query_course(request: dict[str, Any]) -> tuple[str, str, int, int]:
    course = request.get("course")
    if not isinstance(course, str) or not course:
        raise ValueError("course must be a non-empty string")
    query = request.get("query")
    if not isinstance(query, str) or not query.strip():
        raise ValueError("query must be a non-empty string")
    top_k = request.get("topK", 20)
    chunk_top_k = request.get("chunkTopK", 20)
    if not isinstance(top_k, int) or isinstance(top_k, bool) or top_k < 1:
        raise ValueError("topK must be a positive integer")
    if not isinstance(chunk_top_k, int) or isinstance(chunk_top_k, bool) or chunk_top_k < 1:
        raise ValueError("chunkTopK must be a positive integer")
    return course, query, top_k, chunk_top_k


async def handle(request: Any) -> dict[str, Any]:
    if not isinstance(request, dict):
        raise ValueError("request must be a JSON object")
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
    if command == "delete-document":
        working_dir(request)
        document_id, course = validate_delete_document(request)
        from lightrag_runtime import delete_document

        return {
            "ok": True,
            "command": "delete-document",
            "deletion": await delete_document(request["workingDir"], course, document_id),
        }
    if command == "sync-course-batch":
        working_dir(request)
        course, operations = validate_course_batch(request)
        from lightrag_runtime import sync_course_batch

        return {
            "ok": True,
            "command": "sync-course-batch",
            "batch": await sync_course_batch(
                request["workingDir"], course, operations
            ),
        }
    if command == "query-course":
        working_dir(request)
        course, query, top_k, chunk_top_k = validate_query_course(request)
        from lightrag_runtime import query_course

        return {
            "ok": True,
            "command": "query-course",
            "query": await query_course(
                request["workingDir"], course, query, top_k, chunk_top_k
            ),
        }
    raise ValueError(f"Unsupported command: {command}")


async def main() -> None:
    request_id = "unknown"
    captured_stdout = io.StringIO()
    try:
        raw_request = json.load(sys.stdin)
        request_id, command, payload = decode_request(raw_request)
        runtime_config_path = payload.get("runtimeConfigPath")
        if not isinstance(runtime_config_path, str) or not runtime_config_path:
            raise ProtocolError("RUNTIME_CONFIG_INVALID", "payload.runtimeConfigPath must be a non-empty string")
        application_root = payload.get("applicationRoot")
        if application_root is not None and (not isinstance(application_root, str) or not application_root):
            raise ProtocolError("APPLICATION_ROOT_INVALID", "payload.applicationRoot must be a non-empty string")
        config = load_runtime_config(runtime_config_path, application_root)
        from lightrag_runtime import configure_runtime

        configure_runtime(config)
        request = dict(payload)
        request["command"] = command
        if not isinstance(request.get("workingDir"), str) or not request["workingDir"]:
            request["workingDir"] = config["lightrag"]["workingRoot"]
        with contextlib.redirect_stdout(captured_stdout):
            raw_response = await handle(request)
        if not isinstance(raw_response, dict) or raw_response.get("ok") is not True:
            raise RuntimeError("LightRAG command returned an invalid internal result")
        result = {
            key: value
            for key, value in raw_response.items()
            if key not in {"ok", "command"}
        }
        response = success(request_id, result)
    except Exception as error:  # pragma: no cover - malformed process input
        code = error.code if isinstance(error, ProtocolError) else type(error).__name__
        response = failure(request_id, code, str(error))
    diagnostics = captured_stdout.getvalue()
    if diagnostics:
        sys.stderr.write(diagnostics)
    sys.stdout.write(json.dumps(response, ensure_ascii=False))


if __name__ == "__main__":
    asyncio.run(main())
