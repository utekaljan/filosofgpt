#!/usr/bin/env python3
"""Persistent JSON-lines worker for the pinned Docling PDF converter."""

from __future__ import annotations

import contextlib
import importlib.metadata
import json
import logging
import os
import sys
import time
from pathlib import Path
from typing import Any

PROTOCOL_STDOUT = sys.stdout
DOCLING_VERSION = importlib.metadata.version("docling-slim")


def build_converter():
    from docling.backend.docling_parse_backend import DoclingParseDocumentBackend
    from docling.datamodel.accelerator_options import AcceleratorOptions
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    from docling.document_converter import DocumentConverter, PdfFormatOption

    pipeline_options = PdfPipelineOptions(
        accelerator_options=AcceleratorOptions(),
        do_ocr=False,
        do_table_structure=False,
        do_code_enrichment=False,
        do_formula_enrichment=False,
        do_picture_description=False,
        do_picture_classification=False,
        do_chart_extraction=False,
        generate_page_images=False,
        generate_picture_images=False,
    )
    return DocumentConverter(
        allowed_formats=[InputFormat.PDF],
        format_options={
            InputFormat.PDF: PdfFormatOption(
                pipeline_options=pipeline_options,
                backend=DoclingParseDocumentBackend,
            )
        },
    )


def convert_pdf(converter: Any, source: Path, destination: Path) -> dict[str, Any]:
    started = time.monotonic()
    result = converter.convert(source, raises_on_error=True)
    if result.status.value != "success":
        raise RuntimeError(f"Docling returned {result.status.value}; partial output is rejected")

    pages: list[str] = []
    converted_page_count = 0
    for page_number in sorted(result.document.pages):
        page_markdown = result.document.export_to_markdown(
            page_no=page_number,
            image_placeholder="",
            escape_html=True,
            escape_underscores=False,
        ).strip()
        if page_markdown:
            converted_page_count += 1
            pages.append(f"## Page {page_number}\n\n{page_markdown}")
        else:
            pages.append(f"## Page {page_number}")

    markdown = "\n\n".join(pages).strip()
    if converted_page_count == 0:
        raise RuntimeError("Docling produced no textual Markdown")

    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f"{destination.name}.tmp-{os.getpid()}")
    temporary.write_text(markdown + "\n", encoding="utf-8")
    temporary.replace(destination)
    return {
        "sourcePageCount": len(result.document.pages),
        "convertedPageCount": converted_page_count,
        "elapsedSeconds": time.monotonic() - started,
        "bytes": destination.stat().st_size,
        "doclingVersion": DOCLING_VERSION,
    }


def respond(payload: dict[str, Any]) -> None:
    PROTOCOL_STDOUT.write(json.dumps(payload, ensure_ascii=False) + "\n")
    PROTOCOL_STDOUT.flush()


def main() -> None:
    logging.basicConfig(stream=sys.stderr, level=logging.WARNING)
    with contextlib.redirect_stdout(sys.stderr):
        converter = build_converter()

    for raw_line in sys.stdin:
        raw_line = raw_line.strip()
        if not raw_line:
            continue
        request: dict[str, Any] = {}
        try:
            request = json.loads(raw_line)
            if request.get("command") == "shutdown":
                respond({
                    "id": request.get("id"),
                    "ok": True,
                    "shutdown": True,
                    "doclingVersion": DOCLING_VERSION,
                })
                break
            source = Path(request["input"]).resolve(strict=True)
            destination = Path(request["output"]).resolve()
            with contextlib.redirect_stdout(sys.stderr):
                metrics = convert_pdf(converter, source, destination)
            respond({"id": request.get("id"), "ok": True, **metrics})
        except Exception as error:  # The parent records the exact per-book failure.
            respond({
                "id": request.get("id"),
                "ok": False,
                "doclingVersion": DOCLING_VERSION,
                "error": f"{type(error).__name__}: {error}",
            })


if __name__ == "__main__":
    main()
