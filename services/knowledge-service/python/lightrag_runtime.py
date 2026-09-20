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
from lightrag import QueryParam
from lightrag.llm.openai import openai_complete_if_cache
from lightrag.utils import wrap_embedding_func_with_attrs
from sentence_transformers import SentenceTransformer

_embedding_model: SentenceTransformer | None = None
_embedding_device: str | None = None
_embedding_lock = threading.RLock()
_runtime_config: dict[str, Any] | None = None


def configure_runtime(config: dict[str, Any]) -> None:
    global _runtime_config
    _runtime_config = config


def runtime_config() -> dict[str, Any]:
    if _runtime_config is None:
        raise RuntimeError("LightRAG runtime configuration has not been loaded")
    return _runtime_config


def lightrag_config() -> dict[str, Any]:
    value = runtime_config().get("lightrag")
    if not isinstance(value, dict):
        raise RuntimeError("LightRAG runtime configuration is invalid")
    return value


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
        model=lightrag_config()["llm"]["model"],
        prompt=prompt,
        system_prompt=system_prompt,
        history_messages=history_messages,
        enable_cot=False,
        keyword_extraction=keyword_extraction,
        base_url=lightrag_config()["llm"]["baseUrl"],
        api_key=api_key,
        **request_kwargs,
    )


def _load_embedding_model(device: str) -> SentenceTransformer:
    embedding = lightrag_config()["embedding"]
    model = SentenceTransformer(embedding["model"], device=device)
    model.max_seq_length = embedding["maxTokens"]
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
                batch_size=lightrag_config()["embedding"]["batchSize"],
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
                batch_size=lightrag_config()["embedding"]["batchSize"],
                convert_to_numpy=True,
                normalize_embeddings=True,
            )
    embeddings = np.asarray(encoded)
    dimension = lightrag_config()["embedding"]["dimension"]
    if embeddings.ndim != 2 or embeddings.shape != (len(texts), dimension):
        raise RuntimeError(
            f"BGE-M3 returned unexpected embedding shape: {list(embeddings.shape)} "
            f"for {len(texts)} input texts"
        )
    if not np.issubdtype(embeddings.dtype, np.number) or not np.isfinite(embeddings).all():
        raise RuntimeError("BGE-M3 returned invalid embedding values")
    return embeddings


async def _bge_m3_embedding(texts: list[str]) -> np.ndarray:
    """Embed text off the async event loop using the local BGE-M3 model."""
    return await asyncio.to_thread(_encode, texts)


def configured_embedding():
    embedding = lightrag_config()["embedding"]
    return wrap_embedding_func_with_attrs(
        embedding_dim=embedding["dimension"],
        max_token_size=embedding["maxTokens"],
        model_name=embedding["model"],
    )(_bge_m3_embedding)


async def check_embedding() -> dict[str, Any]:
    embeddings = await configured_embedding()([
        "Deterministic finite automaton",
        "Nondeterministic finite automaton",
    ])
    dimension = lightrag_config()["embedding"]["dimension"]
    if embeddings.ndim != 2 or embeddings.shape != (2, dimension):
        raise RuntimeError(f"BGE-M3 returned unexpected embedding shape: {list(embeddings.shape)}")
    if not np.issubdtype(embeddings.dtype, np.number) or not np.isfinite(embeddings).all():
        raise RuntimeError("BGE-M3 returned invalid embedding values")
    return {
        "model": lightrag_config()["embedding"]["model"],
        "dimension": dimension,
        "maxTokens": lightrag_config()["embedding"]["maxTokens"],
        "device": _embedding_device or "unknown",
        "shape": [int(embeddings.shape[0]), int(embeddings.shape[1])],
    }


async def check_llm() -> dict[str, Any]:
    response = await deepseek_complete("Reply with exactly OK.")
    if not isinstance(response, str) or not response.strip():
        raise RuntimeError("DeepSeek returned an empty response")
    return {
        "provider": "deepseek",
        "model": lightrag_config()["llm"]["model"],
        "baseUrl": lightrag_config()["llm"]["baseUrl"],
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
    rag_config = lightrag_config()
    rag = LightRAG(
        working_dir=str(course_working_dir),
        llm_model_func=deepseek_complete,
        llm_model_name=rag_config["llm"]["model"],
        embedding_func=configured_embedding(),
        embedding_func_max_async=rag_config["embedding"]["maxAsync"],
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
        "model": lightrag_config()["llm"]["model"],
        "embeddingModel": lightrag_config()["embedding"]["model"],
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


async def sync_course_batch(
    working_dir_root: str,
    course: str,
    operations: list[dict[str, Any]],
) -> dict[str, Any]:
    rag, course_working_dir = await create_rag(working_dir_root, course)
    results: list[dict[str, Any]] = []
    try:
        for operation in operations:
            kind = operation["kind"]
            document = operation.get("document")
            document_id = (
                operation["documentId"]
                if kind == "remove"
                else document["documentId"]
            )
            if kind == "index":
                try:
                    await _insert_with_rag(rag, document)
                    results.append({"documentId": document_id, "kind": kind, "ok": True})
                except Exception as error:
                    results.append(_batch_failure(document_id, kind, "ingest", error))
                continue

            try:
                deletion = await rag.adelete_by_doc_id(document_id)
                if deletion.status != "success":
                    raise RuntimeError(
                        f"LightRAG deletion returned {deletion.status}: {deletion.message}"
                    )
            except Exception as error:
                results.append(_batch_failure(document_id, kind, "delete", error))
                continue

            if kind == "remove":
                results.append({"documentId": document_id, "kind": kind, "ok": True})
                continue

            try:
                await _insert_with_rag(rag, document)
                results.append({"documentId": document_id, "kind": kind, "ok": True})
            except Exception as error:
                results.append(
                    _batch_failure(
                        document_id,
                        kind,
                        "ingest",
                        error,
                        old_deleted=True,
                    )
                )
    finally:
        await close_rag(rag)

    return {
        "course": course,
        "workingDir": str(course_working_dir),
        "operations": results,
    }


async def _insert_with_rag(rag: LightRAG, document: dict[str, Any]) -> None:
    await rag.ainsert(
        document["text"],
        ids=[document["documentId"]],
        file_paths=[document["sourcePath"]],
    )


def _batch_failure(
    document_id: str,
    kind: str,
    stage: str,
    error: BaseException,
    *,
    old_deleted: bool = False,
) -> dict[str, Any]:
    return {
        "documentId": document_id,
        "kind": kind,
        "ok": False,
        "stage": stage,
        "oldDeleted": old_deleted,
        "error": {"type": type(error).__name__, "message": str(error)},
    }


async def query_course(
    working_dir_root: str,
    course: str,
    query: str,
    top_k: int,
    chunk_top_k: int,
) -> dict[str, Any]:
    rag, course_working_dir = await create_rag(working_dir_root, course)
    try:
        raw_result = await rag.aquery_data(
            query,
            param=QueryParam(
                mode=lightrag_config()["query"]["mode"],
                top_k=top_k,
                chunk_top_k=chunk_top_k,
                enable_rerank=lightrag_config()["query"]["rerank"],
            ),
        )
        data = raw_result.get("data", {}) if isinstance(raw_result, dict) else {}
        raw_chunks = data.get("chunks", []) if isinstance(data, dict) else []
        if not isinstance(raw_chunks, list):
            raw_chunks = []

        chunk_ids = [
            chunk.get("chunk_id")
            for chunk in raw_chunks
            if isinstance(chunk, dict) and isinstance(chunk.get("chunk_id"), str)
        ]
        stored_chunks = await rag.text_chunks.get_by_ids(chunk_ids)
        stored_by_id = {
            chunk_id: stored
            for chunk_id, stored in zip(chunk_ids, stored_chunks)
            if isinstance(stored, dict)
        }

        chunks: list[dict[str, Any]] = []
        unresolved = 0
        for raw_chunk in raw_chunks:
            if not isinstance(raw_chunk, dict):
                continue
            chunk_id = raw_chunk.get("chunk_id")
            content = raw_chunk.get("content")
            stored = stored_by_id.get(chunk_id) if isinstance(chunk_id, str) else None
            document_id = stored.get("full_doc_id") if stored is not None else None
            if not isinstance(document_id, str) or not document_id:
                unresolved += 1
                continue
            if not isinstance(content, str) or not content:
                continue

            chunk: dict[str, Any] = {
                "documentId": document_id,
                "content": content,
            }
            if isinstance(chunk_id, str) and chunk_id:
                chunk["chunkId"] = chunk_id
            file_path = raw_chunk.get("file_path")
            reference_id = raw_chunk.get("reference_id")
            if isinstance(file_path, str) and file_path:
                chunk["filePath"] = file_path
            if isinstance(reference_id, str) and reference_id:
                chunk["referenceId"] = reference_id
            score = raw_chunk.get("score")
            if isinstance(score, (int, float)) and not isinstance(score, bool):
                chunk["score"] = float(score)
            chunks.append(chunk)

        return {
            "course": course,
            "mode": "mix",
            "chunks": chunks,
            "unresolved": unresolved,
            "workingDir": str(course_working_dir),
        }
    finally:
        await close_rag(rag)
