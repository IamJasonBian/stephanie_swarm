// A cheap-review run is a local git checkout or a GitHub slug, plus a PR.
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import type { ReviewJobInput } from "./cheapReviewMcp.ts";

const SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PR_URL = /^https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)(?:[/?#].*)?$/;

export interface ParsedRepoPr {
  kind: "path" | "slug";
  repo: string;
  number: number;
  slug?: string;
}

export interface LoadedPr {
  repo: string;
  pr: string;
  title: string;
  url: string;
  jobs: ReviewJobInput[];
}

export function parseRepoPr(repo: string, pr: string | number): ParsedRepoPr {
  const prText = String(pr).trim();
  const url = PR_URL.exec(prText);
  let number: number;
  let urlSlug: string | undefined;
  if (url) {
    urlSlug = `${url[1]}/${url[2]}`;
    number = Number(url[3]);
  } else if (/^\d+$/.test(prText)) {
    number = Number(prText);
  } else {
    throw new Error("pr must be a pull request number or a github.com pull URL");
  }
  if (!Number.isInteger(number) || number < 1) throw new Error("pr must be a positive integer");

  const repoText = repo.trim();
  if (!repoText) throw new Error("repo is required");
  if (SLUG.test(repoText)) {
    if (urlSlug && urlSlug.toLowerCase() !== repoText.toLowerCase()) {
      throw new Error(`pr URL is ${urlSlug}, not ${repoText}`);
    }
    return { kind: "slug", repo: repoText, number, slug: repoText };
  }
  if (repoText.startsWith("-")) throw new Error("repo path must not start with -");
  return { kind: "path", repo: repoText, number, slug: urlSlug };
}

export function splitUnifiedDiff(diff: string): { path: string; diff: string }[] {
  const chunks = diff
    .split(/(?=^diff --git )/m)
    .map((part) => part.trim())
    .filter((part) => part.startsWith("diff --git "));
  return chunks.map((text) => {
    const plus = /^\+\+\+ (?:b\/)?(.+)$/m.exec(text);
    let path = plus?.[1]?.trim() ?? "";
    if (!path || path === "/dev/null") {
      const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(text);
      path = header?.[2]?.trim() || header?.[1]?.trim() || "unknown";
    }
    return { path, diff: text };
  });
}

function run(cmd: string, args: string[], cwd?: string, timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, maxBuffer: 8 * 1024 * 1024, timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        const detail = (stderr || stdout || err.message).trim().slice(0, 500);
        reject(new Error(detail || `${cmd} failed`));
        return;
      }
      resolve(stdout);
    });
  });
}

export async function assertGitRepo(dir: string): Promise<void> {
  const info = await stat(dir).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`${dir} is not a directory`);
  try {
    const inside = (await run("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"])).trim();
    if (inside !== "true") throw new Error("not a work tree");
  } catch {
    throw new Error(`${dir} is not a git repo`);
  }
}

export async function loadPullRequest(repo: string, pr: string | number): Promise<LoadedPr> {
  const parsed = parseRepoPr(repo, pr);
  if (parsed.kind === "path") await assertGitRepo(parsed.repo);
  const cwd = parsed.kind === "path" ? parsed.repo : undefined;
  const repoArgs = parsed.kind === "slug" ? ["--repo", parsed.slug!] : [];
  const diff = await run("gh", ["pr", "diff", String(parsed.number), ...repoArgs], cwd);
  let title = "";
  let url = "";
  try {
    const raw = await run("gh", ["pr", "view", String(parsed.number), "--json", "title,url", ...repoArgs], cwd);
    const meta = JSON.parse(raw) as { title?: string; url?: string };
    title = meta.title ?? "";
    url = meta.url ?? "";
  } catch {
    // The diff is the review input. Metadata is only a header.
  }
  const jobs = splitUnifiedDiff(diff).map((file) => ({ path: file.path, diff: file.diff, id: file.path }));
  return {
    repo: parsed.kind === "slug" ? parsed.slug! : parsed.repo,
    pr: String(parsed.number),
    title,
    url,
    jobs,
  };
}

// Diff only — no title lookup — so a caller with a short deadline makes one gh call.
export async function loadPullRequestDiff(
  repo: string,
  pr: string | number,
  timeoutMs: number,
): Promise<{ repo: string; pr: string; diff: string }> {
  const parsed = parseRepoPr(repo, pr);
  if (parsed.kind === "path") await assertGitRepo(parsed.repo);
  const cwd = parsed.kind === "path" ? parsed.repo : undefined;
  const repoArgs = parsed.kind === "slug" ? ["--repo", parsed.slug!] : [];
  const diff = await run("gh", ["pr", "diff", String(parsed.number), ...repoArgs], cwd, timeoutMs);
  return {
    repo: parsed.kind === "slug" ? parsed.slug! : parsed.repo,
    pr: String(parsed.number),
    diff,
  };
}
