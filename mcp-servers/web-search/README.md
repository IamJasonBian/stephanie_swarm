# web-search MCP server

One read-only tool, `web_search(query, max_results=5)`, returning JSON
`{query, results: [{title, url, snippet}]}`. No network access other than the
search provider; no filesystem or shell.

```bash
mcp-servers/web-search/setup.sh          # builds .venv (mcp<2 + ddgs)
mcp-servers/web-search/.venv/bin/python mcp-servers/web-search/server.py   # stdio
```

It is referenced by `config/harnesses/web-readonly.json` and spawned on demand
by the compute service's harness (`POST /v1/agent/completions`). Search output
is untrusted data: the harness quotes it back to the model as a tool result and
never as instructions.
