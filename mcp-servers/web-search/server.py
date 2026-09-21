"""web-search MCP server.

Read-only public web search (DuckDuckGo-style aggregation via `ddgs`) exposed
as a single MCP tool so a local model harness can look things up without any
shell or filesystem access. Results are data, not instructions — callers must
treat the returned text as untrusted.

Requires: pip install -r requirements.txt   (mcp<2, ddgs)
"""
from __future__ import annotations

import json
import sys

from ddgs import DDGS
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("web-search")

MAX_RESULTS_CAP = 10
SNIPPET_CAP = 600


@mcp.tool()
def web_search(query: str, max_results: int = 5) -> str:
    """Search the live public web and return titles, snippets, and source URLs.

    Use for current facts, news, prices, schedules, or anything that needs an
    up-to-date source. Results are ranked by the search provider; each item is
    numbered so the model can cite it.

    Args:
        query: Specific search query (a few keywords or a short question).
        max_results: Number of results to return, 1-10 (default 5).
    """
    query = query.strip()
    if not query:
        return json.dumps({"error": "query is required"})
    n = max(1, min(int(max_results), MAX_RESULTS_CAP))
    try:
        hits = DDGS().text(query, max_results=n) or []
    except Exception as e:  # network/provider failure — surface, don't crash
        return json.dumps({"error": "search_failed", "detail": str(e)[:300]})
    results = []
    for h in hits[:n]:
        results.append(
            {
                "title": (h.get("title") or "Untitled")[:200],
                "url": h.get("href") or h.get("url") or "",
                "snippet": (h.get("body") or h.get("description") or "")[:SNIPPET_CAP],
            }
        )
    return json.dumps({"query": query, "results": results}, ensure_ascii=False)


if __name__ == "__main__":
    # stdio only — stdout is the protocol channel, so any diagnostics go to stderr.
    print("web-search MCP server (stdio)", file=sys.stderr)
    mcp.run(transport="stdio")
