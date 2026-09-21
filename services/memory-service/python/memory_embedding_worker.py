"""One-shot BGE-M3 embedding worker for the independent Memory index."""

from __future__ import annotations

import json
import sys
from typing import Any

import numpy as np
import torch
from sentence_transformers import SentenceTransformer


def require_positive_integer(value: Any, field: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 1:
        raise ValueError(f"{field} must be a positive integer")
    return value


def main() -> None:
    request = json.load(sys.stdin)
    if not isinstance(request, dict):
        raise ValueError("request must be an object")
    model_name = request.get("model")
    texts = request.get("texts")
    if not isinstance(model_name, str) or not model_name:
        raise ValueError("model must be a non-empty string")
    if not isinstance(texts, list) or not texts or not all(
        isinstance(text, str) and text.strip() for text in texts
    ):
        raise ValueError("texts must be a non-empty string array")
    dimension = require_positive_integer(request.get("dimension"), "dimension")
    max_tokens = require_positive_integer(request.get("maxTokens"), "maxTokens")
    batch_size = require_positive_integer(request.get("batchSize"), "batchSize")

    requested_device = "mps" if torch.backends.mps.is_available() else "cpu"
    try:
        model = SentenceTransformer(model_name, device=requested_device)
        model.max_seq_length = max_tokens
        embeddings = model.encode(
            texts,
            batch_size=batch_size,
            convert_to_numpy=True,
            normalize_embeddings=True,
        )
        device = requested_device
    except Exception as error:
        if requested_device != "mps":
            raise
        sys.stderr.write(
            f"BGE-M3 MPS failed ({type(error).__name__}: {error}); using CPU\n"
        )
        model = SentenceTransformer(model_name, device="cpu")
        model.max_seq_length = max_tokens
        embeddings = model.encode(
            texts,
            batch_size=batch_size,
            convert_to_numpy=True,
            normalize_embeddings=True,
        )
        device = "cpu"

    matrix = np.asarray(embeddings)
    if matrix.shape != (len(texts), dimension) or not np.isfinite(matrix).all():
        raise RuntimeError(f"invalid embedding matrix shape or values: {matrix.shape}")
    json.dump(
        {
            "model": model_name,
            "device": device,
            "embeddings": matrix.tolist(),
        },
        sys.stdout,
        ensure_ascii=False,
    )


if __name__ == "__main__":
    main()
