// Document → markdown conversion via the docling worker in services/converter.
// Accepts a URL/path source, or base64 file data (written to a temp file).
// The Python worker is a subprocess per conversion; the contract is
// "source in, markdown on stdout", so Marker can be swapped in convert.py
// without touching this file.

import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { BackendUnavailable } from "./ollama.ts";

const here = dirname(fileURLToPath(import.meta.url));
const CONVERTER_DIR = process.env.CONVERTER_DIR ?? join(here, "..", "..", "..", "converter");
const PYTHON = join(CONVERTER_DIR, ".venv", "bin", "python");
const SCRIPT = join(CONVERTER_DIR, "convert.py");
const CONVERT_TIMEOUT_MS = 300_000;

export interface DocumentInput {
  // Either a URL/local path...
  source?: string;
  // ...or inline base64 content with a filename (extension drives format detection).
  filename?: string;
  data?: string;
}

export async function converterReady(): Promise<boolean> {
  try {
    await access(PYTHON);
    return true;
  } catch {
    return false;
  }
}

function runWorker(source: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      PYTHON,
      [SCRIPT, source],
      { timeout: CONVERT_TIMEOUT_MS, maxBuffer: 50 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new BackendUnavailable("converter", (stderr || err.message).slice(-500)));
        } else {
          resolve(stdout);
        }
      }
    );
  });
}

export async function convertDocument(doc: DocumentInput): Promise<{ name: string; markdown: string }> {
  if (!(await converterReady())) {
    throw new BackendUnavailable("converter", "docling venv missing — run services/converter setup (uv venv + uv pip install docling)");
  }

  if (doc.source) {
    return { name: doc.source, markdown: await runWorker(doc.source) };
  }

  if (doc.filename && doc.data) {
    const safeName = basename(doc.filename);
    const dir = await mkdtemp(join(tmpdir(), "hermes-convert-"));
    const filePath = join(dir, safeName);
    try {
      await writeFile(filePath, Buffer.from(doc.data, "base64"));
      return { name: safeName, markdown: await runWorker(filePath) };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  throw new Error("document needs either 'source' (URL/path) or 'filename' + 'data' (base64)");
}
