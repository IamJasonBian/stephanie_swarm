# frontend — Coach in a Cave (`:8879`)

Negotiation & application assistant UI: offer-letter and promotion negotiation,
resume and cover-letter suggestions, a leverage/options playground, and a
multi-turn Thought Partner with three personas (Coach, Calm Negotiator,
Hothead) that keeps a live re-ranked priority list. Warm cave aesthetic over a
basalt-cave wallpaper (dharmx/walls), procedural canvas fallback when offline.

Chat goes through the swarm's **compute** service, so every conversation gets
the `negotiation.md` base playbook (BATNA, anchoring, calibrated questions,
MESOs, ...) underneath the app's own persona prompts, and the model picker
exposes the swarm aliases: `hermes` (free/local), `claude`, `kimi`.

```
browser ──▶ frontend :8879 (UI + SSE adapter) ──▶ compute :8878 ──▶ hermes/claude/kimi
```

Compute is non-streaming (v1); `server.py` re-emits each reply as an SSE
chunk stream so the UI types. When compute grows streaming, swap `_chat()` to
pass-through.

## Run

```bash
cd services/frontend && python3 server.py   # :8879, stdlib only — no deps
```

## Routes

- `/` — the app
- `POST /api/chat` — `{model, temperature, messages}` → SSE, proxied to
  compute `/v1/chat/completions`
- `GET /api/models` — swarm aliases from compute `/v1/models`
- `GET /health`, `GET /cave.jpg`

## Env

| Var | Default |
|---|---|
| `PORT` | `8879` |
| `COMPUTE_URL` | `http://localhost:8878` |
| `LLM_MODEL` | `hermes` |
