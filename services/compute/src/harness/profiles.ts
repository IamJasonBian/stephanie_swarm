// Harness profiles: which MCP servers a run may spawn, which tools it may
// call, and how hard it is bounded. Loaded from config/harnesses/*.json.
// Default-deny: an unknown profile, server, or tool name is an error.
//
// Paths in profiles use ${REPO_DIR} and ${HOME} so nothing machine-specific
// is committed.

import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface McpServerSpec {
  command: string;
  args?: string[];
  // Only these vars (plus PATH/HOME) reach the subprocess — never the
  // compute service's full environment.
  env?: Record<string, string>;
  cwd?: string;
}

export interface ToolPolicy {
  name: string;
  mutating?: boolean; // mutating tools are refused in v1 (no confirmation channel yet)
  timeout_ms?: number;
  max_output_bytes?: number;
}

export interface HarnessLimits {
  max_tool_rounds: number;
  timeout_ms: number;
  max_tool_output_bytes: number;
}

export interface HarnessProfile {
  name: string;
  description?: string;
  exposure: "local" | "trusted";
  backends: string[];
  servers: Record<string, McpServerSpec>;
  tools: ToolPolicy[];
  limits: HarnessLimits;
  system_prompt?: string;
}

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_DIR = resolve(here, "..", "..", "..", "..");
const HARNESS_DIR = process.env.HARNESS_DIR ?? join(REPO_DIR, "config", "harnesses");

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const HARD_MAX_ROUNDS = 8;
const HARD_MAX_TIMEOUT_MS = 10 * 60_000;
const HARD_MAX_OUTPUT_BYTES = 512 * 1024;

export class ProfileError extends Error {}

function expand(s: string): string {
  return s.replace(/\$\{REPO_DIR\}/g, REPO_DIR).replace(/\$\{HOME\}/g, homedir());
}

function clamp(n: unknown, fallback: number, max: number): number {
  const v = typeof n === "number" && Number.isFinite(n) && n > 0 ? n : fallback;
  return Math.min(v, max);
}

export function parseProfile(raw: unknown, source = "<inline>"): HarnessProfile {
  const fail = (msg: string): never => {
    throw new ProfileError(`harness profile ${source}: ${msg}`);
  };
  if (!raw || typeof raw !== "object") fail("not an object");
  const p = raw as Record<string, unknown>;

  if (typeof p.name !== "string" || !NAME_RE.test(p.name)) fail("name must match " + NAME_RE);
  if (p.exposure !== "local" && p.exposure !== "trusted") {
    fail(`exposure must be "local" or "trusted" (public harnesses are not supported in v1)`);
  }
  if (!Array.isArray(p.backends) || p.backends.length === 0 || !p.backends.every((b) => typeof b === "string")) {
    fail("backends must be a non-empty string array");
  }
  if (!p.servers || typeof p.servers !== "object" || Object.keys(p.servers).length === 0) {
    fail("servers must be a non-empty object");
  }
  const servers: Record<string, McpServerSpec> = {};
  for (const [sname, sraw] of Object.entries(p.servers as Record<string, unknown>)) {
    if (!NAME_RE.test(sname)) fail(`server name "${sname}" invalid`);
    const s = sraw as Record<string, unknown>;
    if (!s || typeof s.command !== "string" || !s.command) fail(`server "${sname}" needs a command`);
    const args = Array.isArray(s.args) ? s.args : [];
    if (!args.every((a) => typeof a === "string")) fail(`server "${sname}" args must be strings`);
    const env: Record<string, string> = {};
    if (s.env !== undefined) {
      if (!s.env || typeof s.env !== "object") fail(`server "${sname}" env must be an object`);
      for (const [k, v] of Object.entries(s.env as Record<string, unknown>)) {
        if (typeof v !== "string") fail(`server "${sname}" env.${k} must be a string`);
        env[k] = expand(v);
      }
    }
    servers[sname] = {
      command: expand(s.command as string),
      args: (args as string[]).map(expand),
      env,
      cwd: typeof s.cwd === "string" ? expand(s.cwd) : undefined,
    };
  }

  if (!Array.isArray(p.tools) || p.tools.length === 0) fail("tools must be a non-empty allowlist");
  const tools: ToolPolicy[] = [];
  const seen = new Set<string>();
  for (const traw of p.tools) {
    const t = traw as Record<string, unknown>;
    if (!t || typeof t.name !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(t.name)) fail("tool name invalid");
    if (seen.has(t.name)) fail(`duplicate tool "${t.name}"`);
    seen.add(t.name);
    tools.push({
      name: t.name,
      mutating: Boolean(t.mutating),
      timeout_ms: clamp(t.timeout_ms, 30_000, HARD_MAX_TIMEOUT_MS),
      max_output_bytes: clamp(t.max_output_bytes, 16 * 1024, HARD_MAX_OUTPUT_BYTES),
    });
  }

  const l = (p.limits ?? {}) as Record<string, unknown>;
  const limits: HarnessLimits = {
    max_tool_rounds: clamp(l.max_tool_rounds, 4, HARD_MAX_ROUNDS),
    timeout_ms: clamp(l.timeout_ms, 120_000, HARD_MAX_TIMEOUT_MS),
    max_tool_output_bytes: clamp(l.max_tool_output_bytes, 64 * 1024, HARD_MAX_OUTPUT_BYTES),
  };

  return {
    name: p.name as string,
    description: typeof p.description === "string" ? p.description : undefined,
    exposure: p.exposure as "local" | "trusted",
    backends: p.backends as string[],
    servers,
    tools,
    limits,
    system_prompt: typeof p.system_prompt === "string" ? p.system_prompt : undefined,
  };
}

// Read every profile on each call (they're tiny) so edits apply without a
// restart — same convention as MOCK_RESPONSES.json in the bots.
export function loadProfiles(dir = HARNESS_DIR): Map<string, HarnessProfile> {
  const out = new Map<string, HarnessProfile>();
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return out;
  }
  for (const f of files) {
    const path = join(dir, f);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      console.warn(`harness profile ${path}: invalid JSON (${e instanceof Error ? e.message : e}) — skipped`);
      continue;
    }
    try {
      const prof = parseProfile(raw, basename(f));
      if (prof.name !== basename(f, ".json")) {
        console.warn(`harness profile ${path}: name "${prof.name}" != filename — skipped`);
        continue;
      }
      out.set(prof.name, prof);
    } catch (e) {
      console.warn(e instanceof Error ? e.message : String(e), "— skipped");
    }
  }
  return out;
}

export function getProfile(name: string, dir = HARNESS_DIR): HarnessProfile | undefined {
  if (!NAME_RE.test(name)) return undefined;
  return loadProfiles(dir).get(name);
}
