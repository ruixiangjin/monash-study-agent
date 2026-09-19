"""DeepSeek, BGE-M3, and LightRAG runtime primitives."""

from __future__ import annotations

import asyncio
import os
import sys
import threading
from pathlib import Path
from typing import Any

import numpy as np
import torch
from lightrag import LightRAG
from lightrag.llm.openai import openai_complete_if_cache
from lightrag.utils import wrap_embedding_func_with_attrs
from sentence_transformers import SentenceTransformer

DEEPSEEK_MODEL = "deepseek-flash"
DEEPSEEK_BASE_URL = "https://api.deepseek.com"

EMBEDDING_MODEL = "BAAI/bge-m3"
EMBEDDING_DIMENSION = 1024
EMBEDDING_MAX_TOKENS = 8192
EMBEDDING_BATCH_SIZE = 4

_embedding_model: SentenceTransformer | None = None
_embedding_device: str | None = None
_embedding_lock = threading.RLock()


async def deepseek_complete(
    prompt: str,
    system_prompt: str | None = None,
    history_messages: list | None = None,
    keyword_extraction: bool = False,
    **kwargs: Any,
) -> str:
    """Call DeepSeek through LightRAG's current OpenAI-compatible adapter."""
    api_key = os.getenv("DEEPSEEK_API_KEY")
    if not api_key:
        raise RuntimeError("DEEPSEEK_API_KEY is required for LightRAG LLM calls")

    request_kwargs = dict(kwargs)
    request_kwargs.pop("model", None)
    request_kwargs.pop("base_url", None)
    request_kwargs.pop("api_key", None)
    request_kwargs.pop("enable_cot", None)
    request_kwargs["reasoning_effort"] = "none"
    extra_body = dict(request_kwargs.get("extra_body") or {})
    extra_body["thinking"] = {"type": "disabled"}
    request_kwargs["extra_body"] = extra_body

    return await openai_complete_if_cache(
        model=DEEPSEEK_MODEL,
        prompt=prompt,
        system_prompt=system_prompt,
        history_messages=history_messages,
        enable_cot=False,
        keyword_extraction=keyword_extraction,
        base_url=DEEPSEEK_BASE_URL,
        api_key=api_key,
        **request_kwargs,
    )


def _load_embedding_model(device: str) -> SentenceTransformer:
    model = SentenceTransformer(EMBEDDING_MODEL, device=device)
    model.max_seq_length = EMBEDDING_MAX_TOKENS
    return model


def get_embedding_model() -> SentenceTransformer:
    """Load BGE-M3 once, preferring MPS and falling back to CPU."""
    global _embedding_device, _embedding_model
    with _embedding_lock:
        if _embedding_model is not None:
            return _embedding_model

        requested_device = "mps" if torch.backends.mps.is_available() else "cpu"
        try:
            _embedding_model = _load_embedding_model(requested_device)
            _embedding_device = requested_device
        except Exception as error:
            if requested_device != "mps":
                raise
            _report_cpu_fallback(error)
            _embedding_model = _load_embedding_model("cpu")
            _embedding_device = "cpu"
        return _embedding_model


def _report_cpu_fallback(error: BaseException) -> None:
    sys.stderr.write(
        f"BGE-M3 MPS failed ({type(error).__name__}: {error}); using CPU\n"
    )


def _encode(texts: list[str]) -> np.ndarray:
    global _embedding_device, _embedding_model
    with _embedding_lock:
        model = get_embedding_model()
        try:
            encoded = model.encode(
                texts,
                batch_size=EMBEDDING_BATCH_SIZE,
                convert_to_numpy=True,
                normalize_embeddings=True,
            )
        except Exception as error:
            if _embedding_device != "mps":
                raise
            _report_cpu_fallback(error)
            _embedding_model = _load_embedding_model("cpu")
            _embedding_device = "cpu"
            encoded = _embedding_model.encode(
                texts,
                batch_size=EMBEDDING_BATCH_SIZE,
                convert_to_numpy=True,
                normalize_embeddings=True,
            )
    embeddings = np.asarray(encoded)
    if embeddings.ndim != 2 or embeddings.shape != (len(texts), EMBEDDING_DIMENSION):
        raise RuntimeError(
            f"BGE-M3 returned unexpected embedding shape: {list(embeddings.shape)} "
            f"for {len(texts)} input texts"
        )
    if not np.issubdtype(embeddings.dtype, np.number) or not np.isfinite(embeddings).all():
        raise RuntimeError("BGE-M3 returned invalid embedding values")
    return embeddings


@wrap_embedding_func_with_attrs(
    embedding_dim=EMBEDDING_DIMENSION,
    max_token_size=EMBEDDING_MAX_TOKENS,
    model_name=EMBEDDING_MODEL,
)
async def bge_m3_embedding(texts: list[str]) -> np.ndarray:
    """Embed text off the async event loop using the local BGE-M3 model."""
    return await asyncio.to_thread(_encode, texts)


async def check_embedding() -> dict[str, Any]:
    embeddings = await bge_m3_embedding([
        "Deterministic finite automaton",
        "Nondeterministic finite automaton",
    ])
    if embeddings.ndim != 2 or embeddings.shape != (2, EMBEDDING_DIMENSION):
        raise RuntimeError(f"BGE-M3 returned unexpected embedding shape: {list(embeddings.shape)}")
    if not np.issubdtype(embeddings.dtype, np.number) or not np.isfinite(embeddings).all():
        raise RuntimeError("BGE-M3 returned invalid embedding values")
    return {
        "model": EMBEDDING_MODEL,
        "dimension": EMBEDDING_DIMENSION,
        "maxTokens": EMBEDDING_MAX_TOKENS,
        "device": _embedding_device or "unknown",
        "shape": [int(embeddings.shape[0]), int(embeddings.shape[1])],
    }


async def check_llm() -> dict[str, Any]:
    response = await deepseek_complete("Reply with exactly OK.")
    if not isinstance(response, str) or not response.strip():
        raise RuntimeError("DeepSeek returned an empty response")
    return {
        "provider": "deepseek",
        "model": DEEPSEEK_MODEL,
        "baseUrl": DEEPSEEK_BASE_URL,
        "thinking": False,
        "responseReceived": True,
    }


def _course_directory(working_dir_root: str, course: str | None) -> Path:
    root = Path(working_dir_root).expanduser().resolve()
    course_name = course or "UNCLASSIFIED"
    if not course_name or course_name in {".", ".."} or "/" in course_name or "\\" in course_name:
        raise ValueError(f"Invalid course directory: {course_name}")
    return root / course_name


async def create_rag(
    working_dir_root: str,
    course: str | None,
) -> tuple[LightRAG, Path]:
    course_working_dir = _course_directory(working_dir_root, course)
    course_working_dir.mkdir(parents=True, exist_ok=True)
    rag = LightRAG(
        working_dir=str(course_working_dir),
        llm_model_func=deepseek_complete,
        llm_model_name=DEEPSEEK_MODEL,
        embedding_func=bge_m3_embedding,
        embedding_func_max_async=1,
    )
    await rag.initialize_storages()
    return rag, course_working_dir


async def close_rag(rag: LightRAG) -> None:
    await rag.finalize_storages()


async def ingest_document(
    working_dir_root: str,
    document: dict[str, Any],
) -> dict[str, Any]:
    document_id = document["documentId"]
    resource_id = document["resourceId"]
    course = document.get("course")
    rag, course_working_dir = await create_rag(working_dir_root, course)
    try:
        await rag.ainsert(
            document["text"],
            ids=[document_id],
            file_paths=[document["sourcePath"]],
        )
    finally:
        await close_rag(rag)
    return {
        "documentId": document_id,
        "resourceId": resource_id,
        "course": course,
        "workingDir": str(course_working_dir),
        "model": DEEPSEEK_MODEL,
        "embeddingModel": EMBEDDING_MODEL,
    }


async def delete_document(
    working_dir_root: str,
    course: str | None,
    document_id: str,
) -> dict[str, Any]:
    rag, course_working_dir = await create_rag(working_dir_root, course)
    try:
        deletion = await rag.adelete_by_doc_id(document_id)
    finally:
        await close_rag(rag)

    return {
        "documentId": document_id,
        "course": course,
        "workingDir": str(course_working_dir),
        "deleted": deletion.status == "success",
        "status": deletion.status,
        "message": deletion.message,
    }
