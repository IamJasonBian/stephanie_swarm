// Deterministic guardrails around tool execution. Nothing here consults the
// model — same philosophy as the bots' regex/watchdog layer.

import type { HarnessProfile, ToolPolicy } from "./profiles.ts";

export type PolicyDecision = { ok: true; policy: ToolPolicy } | { ok: false; reason: string };

export function checkToolCall(profile: HarnessProfile, name: string, route: Map<string, string>): PolicyDecision {
  const policy = profile.tools.find((t) => t.name === name);
  if (!policy) return { ok: false, reason: `tool "${name}" is not in the profile allowlist` };
  if (!route.has(name)) return { ok: false, reason: `tool "${name}" is allowed but no server exposes it` };
  if (policy.mutating) {
    // No confirmation channel in v1 — refuse rather than guess.
    return { ok: false, reason: `tool "${name}" is mutating and requires confirmation, which this caller cannot provide` };
  }
  return { ok: true, policy };
}

export function parseArguments(raw: string | undefined): { ok: true; args: Record<string, unknown> } | { ok: false; reason: string } {
  if (!raw || !raw.trim()) return { ok: true, args: {} };
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false, reason: "arguments must be a JSON object" };
    return { ok: true, args: v as Record<string, unknown> };
  } catch (e) {
    return { ok: false, reason: `arguments are not valid JSON: ${e instanceof Error ? e.message : e}` };
  }
}

export function truncate(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) return { text, truncated: false };
  const cut = buf.subarray(0, Math.max(0, maxBytes - 64)).toString("utf8");
  return { text: `${cut}\n…[truncated: ${buf.byteLength} bytes > ${maxBytes} limit]`, truncated: true };
}

// Stable fingerprint so "same tool, same args" twice in a row is detected.
export function fingerprint(name: string, args: Record<string, unknown>): string {
  const sorted = Object.keys(args)
    .sort()
    .map((k) => `${k}=${JSON.stringify(args[k])}`)
    .join("&");
  return `${name}(${sorted})`;
}

export interface AuditEvent {
  ts: string;
  request_id: string;
  profile: string;
  backend: string;
  event: "tool_call" | "tool_denied" | "run_end";
  tool?: string;
  server?: string;
  duration_ms?: number;
  result_bytes?: number;
  outcome: "ok" | "error" | "denied" | "timeout" | "limit";
  detail?: string;
  rounds?: number;
}

// One JSON line per event on stdout → services/compute.log. Deliberately no
// arguments or result bodies (they may contain secrets or PII).
export function audit(ev: Omit<AuditEvent, "ts">): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...ev }));
}
