// Thin client for Judge0 CE (judge0/judge0). We use the synchronous
// `wait=true` mode so a single POST returns the full result — fits inside
// the Netlify Function 10 s sync cap as long as wall_time_limit < 9.
//
// Auth: optional X-Auth-Token header (configured server-side in judge0.conf).
// We never send the user's IP onward; the function is the only caller.

const DEFAULT_URL = process.env.JUDGE0_URL ?? "http://localhost:2358";
const AUTH_TOKEN = process.env.JUDGE0_AUTH_TOKEN ?? "";
const PYTHON_LANGUAGE_ID = 71; // Judge0 CE: Python 3.8.1
const DEFAULT_CPU_LIMIT_S = 5;
const DEFAULT_WALL_LIMIT_S = 8;

export interface Judge0SubmitOptions {
  sourceCode: string;
  stdin?: string;
  cpuTimeLimitS?: number;
  wallTimeLimitS?: number;
  memoryLimitKb?: number;
}

export interface Judge0Result {
  stdout: string | null;
  stderr: string | null;
  compileOutput: string | null;
  message: string | null;
  status: { id: number; description: string };
  time: string | null; // seconds, as string
  memory: number | null; // KB
  exitCode: number | null;
}

export class Judge0Unavailable extends Error {
  // Node strip-only TS can't handle parameter properties, so `cause` is
  // assigned explicitly (diverges from the leetcards original in form only).
  readonly cause: string;
  constructor(cause: string) {
    super(`Judge0 unavailable: ${cause}`);
    this.cause = cause;
  }
}

export async function runPython(opts: Judge0SubmitOptions): Promise<Judge0Result> {
  const url = `${DEFAULT_URL}/submissions?base64_encoded=false&wait=true`;
  const body = {
    language_id: PYTHON_LANGUAGE_ID,
    source_code: opts.sourceCode,
    stdin: opts.stdin ?? "",
    cpu_time_limit: opts.cpuTimeLimitS ?? DEFAULT_CPU_LIMIT_S,
    wall_time_limit: opts.wallTimeLimitS ?? DEFAULT_WALL_LIMIT_S,
    memory_limit: opts.memoryLimitKb ?? 256000,
    redirect_stderr_to_stdout: false,
  };
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (AUTH_TOKEN) headers["X-Auth-Token"] = AUTH_TOKEN;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      // Function-side timeout slightly under Netlify's 10 s cap.
      signal: AbortSignal.timeout(9_000),
    });
  } catch (e) {
    throw new Judge0Unavailable(e instanceof Error ? e.message : String(e));
  }

  if (res.status === 401 || res.status === 403) {
    throw new Judge0Unavailable("auth rejected");
  }
  if (!res.ok) {
    throw new Judge0Unavailable(`HTTP ${res.status}`);
  }

  const json = (await res.json()) as Record<string, unknown>;
  return {
    stdout: (json.stdout as string | null) ?? null,
    stderr: (json.stderr as string | null) ?? null,
    compileOutput: (json.compile_output as string | null) ?? null,
    message: (json.message as string | null) ?? null,
    status: (json.status as { id: number; description: string }) ?? {
      id: 0,
      description: "unknown",
    },
    time: (json.time as string | null) ?? null,
    memory: (json.memory as number | null) ?? null,
    exitCode: (json.exit_code as number | null) ?? null,
  };
}

// Judge0 status IDs we care about (from judge0/judge0 docs):
//   1=in queue, 2=processing, 3=accepted, 4=wrong answer, 5=time limit,
//   6=compile error, 7-12=runtime error variants, 13=internal error, 14=exec format error
export const JUDGE0_STATUS = {
  ACCEPTED: 3,
  TIME_LIMIT: 5,
  COMPILE_ERROR: 6,
} as const;
