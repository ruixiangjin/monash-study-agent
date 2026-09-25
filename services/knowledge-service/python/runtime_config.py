"""Loader for the shared non-secret runtime configuration."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def load_runtime_config(path: str, application_root: str | None = None) -> dict[str, Any]:
    config_path = Path(path).expanduser().resolve()
    with config_path.open(encoding="utf-8") as stream:
        value = json.load(stream)
    if not isinstance(value, dict):
        raise ValueError(f"Runtime config must be a JSON object: {config_path}")
    if value.get("schemaVersion") != 1 or value.get("knowledgeProvider") != "lightrag":
        raise ValueError(f"Unsupported runtime config: {config_path}")
    lightrag = value.get("lightrag")
    if not isinstance(lightrag, dict):
        raise ValueError(f"Runtime config has no lightrag section: {config_path}")
    for key in ("workingRoot", "sqlitePath"):
        if not isinstance(lightrag.get(key), str) or not lightrag[key]:
            raise ValueError(f"Runtime config lightrag.{key} is invalid: {config_path}")

    repository_root = (
        Path(application_root).expanduser().resolve()
        if application_root is not None
        else config_path.parent.parent
    )
    resolved = dict(value)
    resolved_lightrag = dict(lightrag)
    resolved_lightrag["workingRoot"] = str(resolve_path(repository_root, lightrag["workingRoot"]))
    resolved_lightrag["sqlitePath"] = str(resolve_path(repository_root, lightrag["sqlitePath"]))
    resolved["lightrag"] = resolved_lightrag
    return resolved


def resolve_path(repository_root: Path, value: str) -> Path:
    candidate = Path(value).expanduser()
    return candidate if candidate.is_absolute() else (repository_root / candidate).resolve()
