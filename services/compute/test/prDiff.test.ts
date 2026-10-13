import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { parseRepoPr, splitUnifiedDiff, assertGitRepo } from "../src/prDiff.ts";

const DIFF = `diff --git a/add.ts b/add.ts
--- a/add.ts
+++ b/add.ts
@@ -1 +1 @@
-function add(a, b) { return a + b }
+function add(a, b) { return a - b }
diff --git a/readme.md b/readme.md
--- a/readme.md
+++ b/readme.md
@@ -1 +1 @@
-old
+new
`;

test("parseRepoPr accepts a slug and a number, and a matching PR URL", () => {
  assert.deepEqual(parseRepoPr("acme/widget", 14), { kind: "slug", repo: "acme/widget", number: 14, slug: "acme/widget" });
  assert.equal(parseRepoPr("acme/widget", "https://github.com/acme/widget/pull/14").number, 14);
  assert.throws(() => parseRepoPr("other/widget", "https://github.com/acme/widget/pull/14"), /acme\/widget/);
  assert.throws(() => parseRepoPr("acme/widget", "not-a-pr"), /pull request number/);
});

test("a local path stays a path", () => {
  const parsed = parseRepoPr("/Users/jasonzb/src/widget", "9");
  assert.equal(parsed.kind, "path");
  assert.equal(parsed.number, 9);
});

test("splitUnifiedDiff makes one job per file", () => {
  const files = splitUnifiedDiff(DIFF);
  assert.deepEqual(files.map((f) => f.path), ["add.ts", "readme.md"]);
  assert.match(files[0].diff, /a - b/);
});

test("assertGitRepo rejects a directory that is not a checkout", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cheap-review-"));
  try {
    await assert.rejects(assertGitRepo(dir), /not a git repo/);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("assertGitRepo accepts a real checkout", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cheap-review-git-"));
  try {
    await new Promise<void>((resolve, reject) => {
      execFile("git", ["init", dir], (err) => (err ? reject(err) : resolve()));
    });
    await assertGitRepo(dir);
  } finally {
    await rm(dir, { recursive: true });
  }
});
