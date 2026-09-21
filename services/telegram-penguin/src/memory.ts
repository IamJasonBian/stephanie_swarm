// Learning loop storage — append-only JSONL under data/ (gitignored).
//
//   data/turns.jsonl    every user/assistant exchange (per chat) — raw material
//                       for later eval / fine-tuning / "what did we say last time"
//   data/cases.jsonl    outcomes the user reports with /outcome — these become
//                       the "Lessons from past cases" block injected into every
//                       reimbursement prompt, so tactics that won get preferred
//                       and ones that lost get flagged.
//
// Deliberately tiny and dependency-free; swap for SQLite when it outgrows this.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.PENGUIN_DATA_DIR ?? join(here, "..", "data");
const TURNS = join(DATA_DIR, "turns.jsonl");
const CASES = join(DATA_DIR, "cases.jsonl");

export type Outcome = "won" | "partial" | "lost" | "pending";

export interface Turn {
  ts: string;
  chat: number;
  role: "user" | "assistant";
  content: string; // text only; images are noted as [image] — never stored
  model?: string;
  tool_calls?: number;
  attachments?: number;
}

export interface CaseRecord {
  ts: string;
  chat: number;
  outcome: Outcome;
  note: string; // user's words: what worked / what didn't
  summary: string; // one-line case summary the bot derived at the time
}

function ensure(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function appendJsonl(path: string, obj: unknown): void {
  ensure();
  appendFileSync(path, JSON.stringify(obj) + "\n");
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as T];
      } catch {
        return [];
      }
    });
}

export function logTurn(t: Omit<Turn, "ts">): void {
  appendJsonl(TURNS, { ts: new Date().toISOString(), ...t });
}

export function recordOutcome(c: Omit<CaseRecord, "ts">): void {
  appendJsonl(CASES, { ts: new Date().toISOString(), ...c });
}

export function cases(limit = 200): CaseRecord[] {
  return readJsonl<CaseRecord>(CASES).slice(-limit);
}

// Last thing the assistant said in a chat — used as the case summary when the
// user reports an outcome without describing the case.
export function lastAssistant(chat: number): string | undefined {
  const turns = readJsonl<Turn>(TURNS).filter((t) => t.chat === chat && t.role === "assistant");
  return turns.at(-1)?.content;
}

// The block injected into the system prompt. Recent outcomes first, capped so
// it never crowds out the conversation. Wins and losses both matter.
export function lessonsBlock(max = 12): string | undefined {
  const all = cases().filter((c) => c.outcome !== "pending");
  if (all.length === 0) return undefined;
  const recent = all.slice(-max).reverse();
  const tally = { won: 0, partial: 0, lost: 0 };
  for (const c of all) if (c.outcome in tally) tally[c.outcome as keyof typeof tally]++;
  const lines = recent.map((c) => {
    const tag = c.outcome === "won" ? "WON" : c.outcome === "partial" ? "PARTIAL" : "LOST";
    const summary = c.summary.replace(/\s+/g, " ").slice(0, 160);
    const note = c.note.replace(/\s+/g, " ").slice(0, 200);
    return `- [${tag}] ${summary}${note ? ` — user: "${note}"` : ""}`;
  });
  return [
    `Lessons from past cases (${all.length} recorded: ${tally.won} won, ${tally.partial} partial, ${tally.lost} lost). Prefer what won; warn about what lost.`,
    ...lines,
  ].join("\n");
}

export function stats(): { turns: number; cases: number; won: number; partial: number; lost: number } {
  const c = cases(10_000);
  return {
    turns: readJsonl<Turn>(TURNS).length,
    cases: c.length,
    won: c.filter((x) => x.outcome === "won").length,
    partial: c.filter((x) => x.outcome === "partial").length,
    lost: c.filter((x) => x.outcome === "lost").length,
  };
}
