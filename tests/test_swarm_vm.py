"""Tests for bin/swarm-vm. Real supervisor, real processes, fake agent jobs.

    python3 -m unittest tests.test_swarm_vm -v        (from the repo root, ~40s)
"""
import json, os, shutil, signal, subprocess, sys, tempfile, textwrap, time, unittest

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "bin", "swarm-vm")


def proc_gone(pid):
    try:
        with open(f"/proc/{pid}/stat") as f:
            return f.read().rsplit(")", 1)[1].split()[0] == "Z"
    except OSError:
        return True


class VM(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp(prefix="svm-")
        self.env = {**os.environ, "SWARM_VM_HOME": self.home}
        for k in ("SWARM_VM_DAILY_USD", "SWARM_VM_PRICE_IN", "SWARM_VM_PRICE_OUT"):
            self.env.pop(k, None)
        self.addCleanup(shutil.rmtree, self.home, True)
        self.addCleanup(self.kill_all)

    def kill_all(self):
        for m in self.runs():
            if m.get("pgid") and m["state"] in ("running", "orphan"):
                try: os.killpg(m["pgid"], signal.SIGKILL)
                except OSError: pass

    def agent(self, *args, env=None):
        r = subprocess.run([sys.executable, SCRIPT, "agent", *args], capture_output=True, text=True,
                           env={**self.env, **(env or {})}, timeout=60)
        return json.loads(r.stdout.strip().splitlines()[-1]) if r.stdout.strip() else {"stderr": r.stderr}

    def start(self, *cmd, env=None, **opts):
        flags = []
        for k, v in opts.items(): flags += ["--" + k.replace("_", "-"), str(v)]
        return self.agent("start", *flags, "--", *cmd, env=env)

    def runs(self):
        out = []
        rd = os.path.join(self.home, "runs")
        for rid in sorted(os.listdir(rd)) if os.path.isdir(rd) else []:
            try: out.append(json.load(open(os.path.join(rd, rid, "meta.json"))))
            except (OSError, ValueError): pass
        return out

    def wait(self, rid, states=("done", "failed", "killed", "lost"), timeout=30):
        end = time.time() + timeout
        while time.time() < end:
            m = next((m for m in self.runs() if m["id"] == rid), None)
            if m and m["state"] in states: return m
            time.sleep(0.2)
        self.fail(f"run {rid} still {m and m['state']} after {timeout}s")

    def log(self, rid):
        return self.agent_text("logs", rid, "-n", "100000")

    def agent_text(self, *args):
        return subprocess.run([sys.executable, SCRIPT, "agent", *args], capture_output=True, text=True,
                              env=self.env).stdout

    @staticmethod
    def py(code):
        return [sys.executable, "-c", textwrap.dedent(code)]

    # ── pids ──────────────────────────────────────────────────────────
    def test_clean_exit_sweeps_grandchildren(self):
        pidfile = os.path.join(self.home, "gc.pid")
        r = self.start(*self.py(f"""
            import subprocess
            p = subprocess.Popen(["sleep", "300"]); open({pidfile!r}, "w").write(str(p.pid))
            print('{{"type":"result","session_id":"a","total_cost_usd":0.05}}')"""))
        m = self.wait(r["id"])
        self.assertEqual((m["state"], m["cost"]), ("done", 0.05))
        self.assertTrue(proc_gone(int(open(pidfile).read())), "backgrounded grandchild survived the job")

    def test_ttl_kill_is_fast_and_kills_group(self):
        pidfile = os.path.join(self.home, "gc.pid")
        r = self.start(*self.py(f"""
            import subprocess, time
            p = subprocess.Popen(["sleep", "300"]); open({pidfile!r}, "w").write(str(p.pid)); time.sleep(300)"""), ttl=2)
        t0 = time.time(); m = self.wait(r["id"])
        self.assertEqual((m["state"], m["reason"]), ("killed", "ttl"))
        self.assertLess(time.time() - t0, 8, "kill waited out the grace period (zombie leader?)")
        self.assertTrue(proc_gone(int(open(pidfile).read())))

    def test_manual_kill(self):
        r = self.start("sleep", "300")
        self.assertEqual(self.agent("kill", r["id"])["state"], "killed")
        self.assertEqual(self.agent("kill", "nope").get("error"), "no such run: nope")

    def test_orphan_detected_and_reaped(self):
        r = self.start("sleep", "300")
        m = self.runs()[0]
        os.kill(m["watcher"], signal.SIGKILL); time.sleep(1)
        row = next(x for x in self.agent("ls")["runs"] if x["id"] == r["id"])
        self.assertEqual(row["state"], "orphan")
        self.assertIn(r["id"], self.agent("reap")["orphans_killed"])
        self.assertTrue(proc_gone(m["pid"]))
        # orphan spend is ledgered, not lost
        self.assertTrue(self.runs()[0]["ledgered"])

    def test_max_procs_kills_runaway(self):
        r = self.start("bash", "-c", "for i in $(seq 30); do sleep 300 & done; wait", max_procs=10)
        m = self.wait(r["id"], timeout=20)
        self.assertEqual(m["reason"], "max-procs")

    def test_start_returns_promptly_with_piped_stdio(self):
        t0 = time.time()
        subprocess.run(f"{sys.executable} {SCRIPT} agent start -- sleep 2 | cat", shell=True, env=self.env,
                       capture_output=True, timeout=20)
        self.assertLess(time.time() - t0, 3, "ssh would hang: daemon kept the caller's stdio open")

    # ── logs ──────────────────────────────────────────────────────────
    def test_secrets_redacted(self):
        env = os.path.join(self.home, "env")
        open(env, "w").write("export ANTHROPIC_API_KEY=sk-ant-supersecretvalue1234567890\n"); os.chmod(env, 0o600)
        r = self.start(*self.py("""
            import os; print('key', os.environ['ANTHROPIC_API_KEY']); print('hdr Bearer abcdefghijklmnop1234')"""))
        out = self.wait(r["id"]) and self.log(r["id"])
        self.assertNotIn("supersecret", out); self.assertNotIn("abcdefghijklmnop", out)
        self.assertEqual(out.count("[REDACTED]"), 2)

    def test_env_file_must_be_private(self):
        env = os.path.join(self.home, "env"); open(env, "w").write("A=1\n"); os.chmod(env, 0o644)
        self.assertIn("chmod 600", self.start("true").get("error", ""))

    def test_log_is_size_capped(self):
        r = self.start(*self.py("""
            for i in range(20000): print('x' * 200)"""), max_log_mb=1)
        self.wait(r["id"])
        d = os.path.join(self.home, "runs", r["id"])
        total = sum(os.path.getsize(os.path.join(d, f)) for f in ("log", "log.1") if os.path.exists(os.path.join(d, f)))
        self.assertLess(total, 1.1 * 1024 * 1024)
        self.assertGreater(total, 100_000)

    def test_tail_output_not_lost_when_job_exits_fast(self):
        r = self.start(*self.py("""
            import sys
            for i in range(50000): print('{"type":"x","n":%d}' % i)
            print('{"type":"result","session_id":"s","total_cost_usd":1.25}')"""))
        m = self.wait(r["id"])
        self.assertEqual(m["cost"], 1.25, "final result line (real cost) was dropped")
        self.assertIn('"total_cost_usd":1.25', self.log(r["id"]))

    def test_newline_free_flood_is_bounded(self):
        r = self.start(*self.py("""
            import sys; sys.stdout.write('y' * (5 * 1024 * 1024))"""), max_log_mb=64)
        self.assertEqual(self.wait(r["id"])["state"], "done")

    # ── spend ─────────────────────────────────────────────────────────
    def usage(self, i, sid="s", inp=1000, out=500, cr=0, cw=0):
        return ('{"type":"assistant","session_id":"%s","message":{"id":"m%s","usage":{"input_tokens":%d,'
                '"output_tokens":%d,"cache_read_input_tokens":%d,"cache_creation_input_tokens":%d}}}' % (sid, i, inp, out, cr, cw))

    def test_token_budget_kill(self):
        lines = [self.usage(i) for i in range(10)]
        r = self.start(*self.py(f"import time\nfor l in {lines!r}: print(l, flush=True); time.sleep(0.3)"), budget_tokens=4000)
        m = self.wait(r["id"])
        self.assertEqual((m["state"], m["reason"]), ("killed", "budget-tokens"))
        self.assertLess(m["tokens"], 8000)

    def test_cache_reads_do_not_count_toward_token_budget(self):
        lines = [self.usage(i, inp=10, out=10, cr=200_000) for i in range(6)]
        r = self.start(*self.py(f"for l in {lines!r}: print(l, flush=True)"), budget_tokens=1000)
        m = self.wait(r["id"])
        self.assertEqual(m["state"], "done")
        self.assertEqual((m["tokens"], m["tokens_cache_read"]), (120, 1_200_000))

    def test_estimate_prices_cache_reads_at_discount(self):
        r = self.start(*self.py(f"print({self.usage(1, inp=0, out=0, cr=1_000_000)!r})"),
                       env={"SWARM_VM_PRICE_IN": "3", "SWARM_VM_PRICE_OUT": "15"})
        self.assertAlmostEqual(self.wait(r["id"])["cost"], 0.3, places=3)   # 1M cache-read @ 0.1 × $3

    def test_repeated_message_ids_use_max_not_first(self):
        lines = [self.usage(1, out=5), self.usage(1, out=300), self.usage(1, out=300)]
        r = self.start(*self.py(f"for l in {lines!r}: print(l)"))
        self.assertEqual(self.wait(r["id"])["tokens_out"], 300)

    def test_costs_sum_across_sessions(self):
        r = self.start(*self.py("""
            print('{"type":"result","session_id":"a","total_cost_usd":0.05}')
            print('{"type":"result","session_id":"b","total_cost_usd":0.07}')"""))
        self.assertAlmostEqual(self.wait(r["id"])["cost"], 0.12, places=4)

    def test_budget_usd_kill_with_price_table(self):
        lines = [self.usage(i, inp=100_000, out=0) for i in range(10)]   # $0.30/turn at $3/M
        r = self.start(*self.py(f"import time\nfor l in {lines!r}: print(l, flush=True); time.sleep(0.3)"),
                       budget_usd=0.5, env={"SWARM_VM_PRICE_IN": "3", "SWARM_VM_PRICE_OUT": "15"})
        m = self.wait(r["id"])
        self.assertEqual(m["reason"], "budget-usd"); self.assertLess(m["cost"], 1.0)

    def test_daily_cap_blocks_start_and_kills_live_run(self):
        env = {"SWARM_VM_DAILY_USD": "0.02", "SWARM_VM_PRICE_IN": "3", "SWARM_VM_PRICE_OUT": "15"}
        lines = [self.usage(i, inp=10_000, out=0) for i in range(60)]   # $0.03/turn
        r = self.start(*self.py(f"import time\nfor l in {lines!r}: print(l, flush=True); time.sleep(0.3)"), env=env)
        self.assertEqual(self.wait(r["id"], timeout=40)["reason"], "daily-cap")
        self.assertIn("daily cap", self.start("true", env=env).get("error", ""))

    def test_lost_run_spend_still_counts_today(self):
        r = self.start(*self.py(f"import time\nprint({self.usage(1, inp=1_000_000, out=0)!r}, flush=True); time.sleep(300)"),
                       env={"SWARM_VM_PRICE_IN": "3"})
        time.sleep(1.5)
        m = self.runs()[0]
        os.kill(m["watcher"], signal.SIGKILL); os.killpg(m["pgid"], signal.SIGKILL); time.sleep(1)
        self.agent("ls")                                    # reconcile → lost, ledgered
        self.assertGreaterEqual(self.agent("spend")["cost"], 3.0)

    # ── transport ─────────────────────────────────────────────────────
    def test_cli_over_ssh_shim(self):
        shim = os.path.join(self.home, "fakessh")
        open(shim, "w").write('#!/bin/bash\nshift; exec bash -c "$*"\n'); os.chmod(shim, 0o755)
        env = {**self.env, "SWARM_VM_SSH": shim}
        out = subprocess.run([sys.executable, SCRIPT, "-H", "vm1,vm2", "spend"], capture_output=True, text=True, env=env).stdout
        self.assertIn("fleet", out); self.assertIn("vm1", out); self.assertIn("vm2", out)

    def test_fleet_cap_warns_on_unreachable_host_and_strict_refuses(self):
        env = {**self.env, "SWARM_VM_FLEET_USD": "100", "SWARM_VM_SSH": "/bin/false"}
        r = subprocess.run([sys.executable, SCRIPT, "-H", "vm1", "start", "--", "true"], capture_output=True, text=True, env=env)
        self.assertIn("unverifiable", r.stderr)
        r = subprocess.run([sys.executable, SCRIPT, "-H", "vm1", "start", "--", "true"], capture_output=True, text=True,
                           env={**env, "SWARM_VM_FLEET_STRICT": "1"})
        self.assertNotEqual(r.returncode, 0); self.assertIn("not starting", r.stderr)

    def test_claude_without_stream_json_warns(self):
        d = tempfile.mkdtemp(); self.addCleanup(shutil.rmtree, d, True)
        shim = os.path.join(d, "claude"); open(shim, "w").write("#!/bin/bash\n"); os.chmod(shim, 0o755)
        r = subprocess.run([sys.executable, SCRIPT, "-H", "local", "start", "--budget-usd", "1", "--", shim, "-p", "hi"],
                           capture_output=True, text=True, env=self.env)
        self.assertIn("stream-json", r.stderr)


if __name__ == "__main__":
    unittest.main()
