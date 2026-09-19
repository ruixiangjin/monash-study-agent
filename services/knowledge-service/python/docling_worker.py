"""Thin JSON bridge from the TypeScript Normalization Layer to Docling."""

from __future__ import annotations

import argparse
import json
import logging
import platform
import sys
from pathlib import Path
from typing import Any

import docling
from docling.datamodel.base_models import InputFormat
from docling.datamodel.pipeline_options import (
    OcrMacOptions,
    OcrMode,
    PdfPipelineOptions,
    RapidOcrOptions,
    TableStructureOptions,
)
from docling.document_converter import DocumentConverter, PdfFormatOption


def build_converter(*, full_page_ocr: bool) -> tuple[DocumentConverter, str]:
    """Build Docling's Standard PDF Pipeline with a local OCR backend."""
    mode = OcrMode.FULL_PAGE if full_page_ocr else OcrMode.DEFAULT
    if platform.system() == "Darwin":
        ocr_options = OcrMacOptions(mode=mode)
        ocr_engine = "ocrmac"
    else:
        ocr_options = RapidOcrOptions(mode=mode)
        ocr_engine = "rapidocr"

    pdf_options = PdfPipelineOptions(
        do_ocr=True,
        do_table_structure=True,
        ocr_options=ocr_options,
        table_structure_options=TableStructureOptions(do_cell_matching=True),
    )
    converter = DocumentConverter(
        allowed_formats=[InputFormat.PDF, InputFormat.DOCX, InputFormat.PPTX],
        format_options={
            InputFormat.PDF: PdfFormatOption(pipeline_options=pdf_options),
        },
    )
    return converter, ocr_engine


def bbox_dict(bbox: Any) -> dict[str, float] | None:
    """Return Docling bounding-box coordinates when provenance includes them."""
    if bbox is None:
        return None
    names = (("l", "left"), ("t", "top"), ("r", "right"), ("b", "bottom"))
    values: dict[str, float] = {}
    for short, output in names:
        value = getattr(bbox, short, None)
        if not isinstance(value, (int, float)):
            return None
        values[output] = float(value)
    return values


def regions_for(items: list[Any], kind: str) -> list[dict[str, Any]]:
    """Retain page and box locators for pictures and tables."""
    regions: list[dict[str, Any]] = []
    for item in items:
        reference = getattr(item, "self_ref", None)
        for provenance in getattr(item, "prov", []) or []:
            page = getattr(provenance, "page_no", None)
            if not isinstance(page, int):
                continue
            region: dict[str, Any] = {"kind": kind, "page": page}
            if isinstance(reference, str):
                region["reference"] = reference
            bbox = bbox_dict(getattr(provenance, "bbox", None))
            if bbox is not None:
                region["bbox"] = bbox
            regions.append(region)
    return regions


def convert(path: Path) -> dict[str, Any]:
    """Convert one supported document and return JSON-safe normalized input."""
    full_page_ocr = False
    converter, ocr_engine = build_converter(full_page_ocr=False)
    result = converter.convert(path, raises_on_error=True)
    markdown = result.document.export_to_markdown()

    if path.suffix.lower() == ".pdf" and len(markdown.strip()) < 20:
        full_page_ocr = True
        converter, ocr_engine = build_converter(full_page_ocr=True)
        result = converter.convert(path, raises_on_error=True)
        markdown = result.document.export_to_markdown()

    pages = sorted(int(page) for page in result.document.pages)
    picture_regions = regions_for(list(result.document.pictures), "picture")
    table_regions = regions_for(list(result.document.tables), "table")
    return {
        "markdown": markdown,
        "pageNumbers": pages,
        "regions": picture_regions + table_regions,
        "inputFormat": path.suffix.lower().lstrip("."),
        "doclingVersion": docling.__version__,
        "ocrEngine": ocr_engine if path.suffix.lower() == ".pdf" else "not-applicable",
        "usedFullPageOcr": full_page_ocr,
        "pictureCount": len(result.document.pictures),
        "tableCount": len(result.document.tables),
    }


def main() -> None:
    """Parse one input path and emit exactly one JSON object on stdout."""
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    args = parser.parse_args()
    logging.basicConfig(level=logging.WARNING, stream=sys.stderr)
    payload = convert(args.input.resolve())
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))


if __name__ == "__main__":
    main()
