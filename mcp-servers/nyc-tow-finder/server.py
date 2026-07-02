"""nyc-tow-finder MCP server.

Exposes NYC's "Find Your Towed Vehicle" lookup
(https://nycserv.nyc.gov/NYCServWeb/PVO_Find_Towed_Vehicle.jsp) as MCP tools so
any bot's Claude session can check a plate with typed parameters instead of
driving the browser form by hand.

The heavy lifting (Akamai TLS-impersonation bypass + the reverse-engineered
NYCSERV pipe-protocol) lives in nyc_tow.py; this file is a thin FastMCP wrapper.

Requires: pip install "mcp[cli]" curl_cffi
"""
from __future__ import annotations

import json
from pathlib import Path

from mcp.server.fastmcp import FastMCP

import nyc_tow

mcp = FastMCP("nyc-tow-finder")

_REF_PATH = Path(__file__).with_name("reference.json")


def _reference() -> dict:
    try:
        return json.loads(_REF_PATH.read_text())
    except Exception:
        return {"states": {}, "plate_types": {}}


@mcp.tool()
def find_towed_vehicle(plate: str, state: str = "NY", plate_type: str = "PAS") -> str:
    """Check whether a license plate's vehicle has been towed by the NYC
    Sheriff/Marshal, via NYC's public "Find Your Towed Vehicle" tool.

    Also surfaces open parking violations tied to the plate, since NYC returns
    both together (ServiceName PVO_VIO_BY_PLATE_AND_TOW).

    Args:
        plate: The license plate. Spaces and dashes are stripped and it is
            upper-cased; max 10 chars, letters/digits only.
        state: 2-letter state or province code (default "NY"). Use
            list_states() for valid codes.
        plate_type: NYC plate-type code (default "PAS" = Passenger). Use
            list_plate_types() for valid codes.

    Returns a JSON string: {plate, state, plate_type, towed (bool), message,
    records (list of parsed result rows)}. On a plate with no tow / no open
    violations, `towed` is false and `records` is empty.
    """
    try:
        result = nyc_tow.find_towed_vehicle(plate, state, plate_type)
    except ValueError as e:
        return json.dumps({"error": "invalid_input", "detail": str(e)})
    except nyc_tow.TowFinderError as e:
        return json.dumps({"error": "lookup_failed", "detail": str(e)})
    return json.dumps(result.to_dict(), indent=2)


@mcp.tool()
def list_states() -> str:
    """List the valid state/province codes accepted by find_towed_vehicle,
    as a JSON object mapping code -> label (e.g. "NY" -> "NY - New York")."""
    return json.dumps(_reference().get("states", {}), indent=2)


@mcp.tool()
def list_plate_types() -> str:
    """List the valid NYC plate-type codes accepted by find_towed_vehicle,
    as a JSON object mapping code -> label (e.g. "PAS" -> "PAS - Passenger")."""
    return json.dumps(_reference().get("plate_types", {}), indent=2)


if __name__ == "__main__":
    mcp.run()
