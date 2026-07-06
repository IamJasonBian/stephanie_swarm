#!/usr/bin/env python3
"""Document → markdown converter worker (docling).

Usage: convert.py <source>
  <source> is a local file path or a URL (PDF, DOCX, PPTX, XLSX, HTML,
  images, ...). Markdown goes to stdout; errors to stderr with exit 1.

Invoked as a subprocess by the compute service's /v1/convert route.
Swap docling for Marker here if needed — the contract is just
"source in, markdown on stdout".
"""
import sys


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: convert.py <path-or-url>", file=sys.stderr)
        return 1
    source = sys.argv[1]
    from docling.document_converter import DocumentConverter

    converter = DocumentConverter()
    result = converter.convert(source)
    sys.stdout.write(result.document.export_to_markdown())
    return 0


if __name__ == "__main__":
    sys.exit(main())
