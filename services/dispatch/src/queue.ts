// In-memory job queue with per-backend concurrency slots.
// hermes runs one-at-a-time (single local model); claude allows parallelism.
// Jobs are ephemeral chat/execute calls — no persistence in v1; completed
// jobs are swept after RESULT_TTL_MS.

import { randomUUID } from "node:crypto";

export const BACKENDS = ["hermes", "claude", "kimi", "qwen"] as const;
export type Backend = (typeof BACKENDS)[number];
// agent = chat + server-side MCP tool loop (compute /v1/agent/completions).
export type JobType = "chat" | "execute" | "convert" | "agent";
// Backends that can run agent jobs (accept tool definitions).
export const TOOL_CAPABLE: readonly Backend[] = ["qwen", "kimi"];
// Local single-model backends: one slot per compute node.
const LOCAL_BACKENDS: readonly Backend[] = ["hermes", "qwen"];
export type JobStatus = "queued" | "running" | "done" | "failed";

export interface JobPreferences {
  model?: Backend;
  fallback?: boolean;
}

export interface Job {
  jobId: string;
  type: JobType;
  payload: Record<string, unknown>;
  preferences: JobPreferences;
  status: JobStatus;
  model?: Backend;
  result?: unknown;
  error?: string;
  createdAt: number;
  finishedAt?: number;
}

const RESULT_TTL_MS = 60 * 60 * 1000;

// Concurrency scales with pool size: each compute node can run one local
// model (hermes, qwen) at a time, so N nodes ⇒ N parallel slots each. The
// pool is dynamic (nodes self-register), so index.ts calls setNodeCount().
const PER_NODE: Record<"hermes" | "qwen", number> = {
  hermes: Number(process.env.HERMES_CONCURRENCY ?? 1),
  // A 27B model on a 48 GiB Mac is one inference at a time.
  qwen: Number(process.env.QWEN_CONCURRENCY ?? 1),
};
const NODE_COUNT = Math.max(
  1,
  (process.env.COMPUTE_URLS ?? process.env.COMPUTE_URL ?? "x").split(",").filter((s) => s.trim()).length
);

const limits: Record<Backend, number> = {
  hermes: PER_NODE.hermes * NODE_COUNT,
  qwen: PER_NODE.qwen * NODE_COUNT,
  claude: Number(process.env.CLAUDE_CONCURRENCY ?? 4),
  kimi: Number(process.env.KIMI_CONCURRENCY ?? 4),
};

export function setNodeCount(n: number): void {
  for (const b of LOCAL_BACKENDS) limits[b] = PER_NODE[b as "hermes" | "qwen"] * Math.max(1, n);
  void pump(); // new capacity may unblock queued jobs
}
const running: Record<Backend, number> = { hermes: 0, claude: 0, kimi: 0, qwen: 0 };

const jobs = new Map<string, Job>();
const pending: Job[] = [];
const waiters = new Map<string, ((job: Job) => void)[]>();

let executor: ((job: Job, backend: Backend) => Promise<{ result: unknown; model: Backend }>) | null = null;
let roundRobin = 0;

export function setExecutor(fn: typeof executor): void {
  executor = fn;
}

export function enqueue(type: JobType, payload: Record<string, unknown>, preferences: JobPreferences): Job {
  const job: Job = {
    jobId: randomUUID(),
    type,
    payload,
    preferences,
    status: "queued",
    createdAt: Date.now(),
  };
  jobs.set(job.jobId, job);
  pending.push(job);
  void pump();
  return job;
}

export function getJob(jobId: string): Job | undefined {
  return jobs.get(jobId);
}

// Resolves when the job reaches a terminal state, or with its current state on timeout.
export function waitForJob(jobId: string, timeoutMs: number): Promise<Job | undefined> {
  const job = jobs.get(jobId);
  if (!job || job.status === "done" || job.status === "failed") {
    return Promise.resolve(job);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(jobs.get(jobId)), timeoutMs);
    const list = waiters.get(jobId) ?? [];
    list.push((j) => {
      clearTimeout(timer);
      resolve(j);
    });
    waiters.set(jobId, list);
  });
}

export function queueStats() {
  return {
    queued: pending.length,
    running: { ...running },
    limits: { ...limits },
    tracked: jobs.size,
  };
}

function pickBackend(job: Job): Backend {
  if (job.preferences.model) return job.preferences.model;
  if (job.type === "agent") return TOOL_CAPABLE[0];
  // No preference: rotate through the backends so none starves.
  roundRobin = (roundRobin + 1) % BACKENDS.length;
  return BACKENDS[roundRobin];
}

// Chat may fall back anywhere. Agent jobs never fall back: the profile pins
// which backends may run its tools, and switching silently to a cloud model
// would change the trust boundary mid-request.
function fallbackCandidates(job: Job, b: Backend): Backend[] {
  if (job.type !== "chat") return [];
  return BACKENDS.filter((x) => x !== b);
}

// Drain the pending queue into free slots. Called on enqueue and completion.
async function pump(): Promise<void> {
  if (!executor) return;
  for (let i = 0; i < pending.length; i++) {
    const job = pending[i];
    const backend = pickBackend(job);
    // chat/agent jobs hold their backend's slot. Non-LLM jobs (execute →
    // judge0, convert → docling) occupy a claude slot arbitrarily to bound
    // total concurrency.
    const usesModel = job.type === "chat" || job.type === "agent";
    const slot: Backend = usesModel ? backend : "claude";
    if (running[slot] >= limits[slot]) continue;

    pending.splice(i, 1);
    i--;
    running[slot]++;
    job.status = "running";
    if (usesModel) job.model = backend;
    void run(job, backend, slot);
  }
}

async function run(job: Job, backend: Backend, slot: Backend): Promise<void> {
  try {
    const { result, model } = await executor!(job, backend);
    job.result = result;
    if (job.type === "chat" || job.type === "agent") job.model = model;
    job.status = "done";
  } catch (e) {
    const errors = [`${backend}: ${e instanceof Error ? e.message : String(e)}`];
    if (job.preferences.fallback) {
      for (const alt of fallbackCandidates(job, backend)) {
        try {
          const { result, model } = await executor!(job, alt);
          job.result = result;
          job.model = model;
          job.status = "done";
          break;
        } catch (e2) {
          errors.push(`${alt}: ${e2 instanceof Error ? e2.message : String(e2)}`);
        }
      }
    }
    if (job.status !== "done") {
      job.error = errors.join("; ");
      job.status = "failed";
    }
  } finally {
    job.finishedAt = Date.now();
    running[slot]--;
    for (const resolve of waiters.get(job.jobId) ?? []) resolve(job);
    waiters.delete(job.jobId);
    void pump();
  }
}

// TTL sweep for completed jobs.
setInterval(() => {
  const cutoff = Date.now() - RESULT_TTL_MS;
  for (const [id, job] of jobs) {
    if (job.finishedAt && job.finishedAt < cutoff) jobs.delete(id);
  }
}, 60_000).unref();
