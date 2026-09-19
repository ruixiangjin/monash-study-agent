"""JSON-line-free stdin/stdout bridge for the project-local LightRAG runtime."""

from __future__ import annotations

import json
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


def handle(request: Any) -> dict[str, Any]:
    if not isinstance(request, dict):
        return failure("unknown", "RequestError", "request must be a JSON object")
    command = request.get("command")
    if command != "health":
        command_name = command if isinstance(command, str) else "unknown"
        return failure(command_name, "CommandError", f"Unsupported command: {command_name}")
    return health(request)


def main() -> None:
    try:
        request = json.load(sys.stdin)
        response = handle(request)
    except Exception as error:  # pragma: no cover - malformed process input
        response = failure("unknown", type(error).__name__, str(error))
    sys.stdout.write(json.dumps(response, ensure_ascii=False))


if __name__ == "__main__":
    main()
