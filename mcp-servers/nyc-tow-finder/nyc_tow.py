"""NYC towed-vehicle finder — core client.

Reverse-engineered client for NYC's "Find Your Towed Vehicle" tool at
https://nycserv.nyc.gov/NYCServWeb/PVO_Find_Towed_Vehicle.jsp

That page is a classic NYCSERV JSP app fronted by Akamai Bot Manager. Two
facts drive this implementation, both discovered empirically:

  1. The Akamai edge 403s a plain requests/curl client AND a *headless*
     Chromium (automation fingerprint). A TLS-impersonating client
     (curl_cffi, `impersonate="chrome124"`) sails through with a 200.

  2. The app reads a single pipe-delimited `NycservRequest` field that the
     page's JavaScript (navigation.js -> oProtocol_fbBuildRequest) assembles
     from every form element in DOM order. If the `g-recaptcha-response`
     field is missing from that string the app soft-blocks the request and
     re-renders the search form with a bogus "issue with your browser
     settings / disable Compatibility View" banner instead of running the
     query. Including the (empty) recaptcha field makes the query run.

This module rebuilds that exact request faithfully, so no browser is needed.

The tool queries a public NYC government lookup on behalf of a plate the
caller supplies; it performs a single GET + single POST per lookup.
"""
from __future__ import annotations

import html
import re
from dataclasses import dataclass, field
from typing import Optional

try:
    from curl_cffi import requests as _requests  # TLS impersonation
except ImportError as e:  # pragma: no cover
    raise ImportError(
        "nyc_tow requires curl_cffi (browser TLS impersonation to pass the "
        "Akamai edge). Install it with: pip install curl_cffi"
    ) from e

BASE = "https://nycserv.nyc.gov/NYCServWeb"
SEARCH_PAGE = f"{BASE}/PVO_Find_Towed_Vehicle.jsp"
POST_URL = f"{BASE}/NYCSERVMain"
IMPERSONATE = "chrome124"

# Special characters the site's plateNoValidate() rejects.
_PLATE_BAD = set("~!@#$%^&*:_='?()+;[]|\\.,`\" ")


class TowFinderError(RuntimeError):
    """Raised when the lookup cannot be completed (network / bot block)."""


@dataclass
class TowResult:
    plate: str
    state: str
    plate_type: str
    towed: bool
    message: str
    records: list = field(default_factory=list)  # list[dict] parsed rows
    raw_text: str = ""

    def to_dict(self) -> dict:
        return {
            "plate": self.plate,
            "state": self.state,
            "plate_type": self.plate_type,
            "towed": self.towed,
            "message": self.message,
            "records": self.records,
        }


def normalize_plate(plate: str) -> str:
    """Apply the site's own normalization: strip spaces and dashes, uppercase.

    Mirrors TrimChar(TrimChar(plate," "),"-") + plateNoValidate() rules.
    Raises ValueError on plates the site would reject.
    """
    if plate is None:
        raise ValueError("plate is required")
    cleaned = plate.strip().replace(" ", "").replace("-", "").upper()
    if not cleaned:
        raise ValueError("plate is required")
    if len(cleaned) > 10:
        raise ValueError("plate too long: max 10 characters (0-9, A-Z)")
    bad = _PLATE_BAD & set(cleaned)
    if bad:
        raise ValueError(
            f"plate contains invalid characters {sorted(bad)}; "
            "only 0-9 and A-Z are allowed"
        )
    return cleaned


def _build_nycserv_request(plate: str, state: str, ptype: str) -> str:
    """Rebuild the pipe-delimited NycservRequest string exactly as the page's
    navigation.js produces it for a towed-vehicle search (towcheck=true =>
    ServiceName PVO_VIO_BY_PLATE_AND_TOW).

    Field order and the literal `ParamCount=undefined` match the real browser
    payload captured from the live page.
    """
    ordered = [
        ("ChannelType", "ct/Browser"),
        ("RequestType", "rt/Business"),
        ("SubSystemType", "st/Payments"),
        ("AgencyType", "at/PVO"),
        ("ServiceName", "PVO_VIO_BY_PLATE_AND_TOW"),
        ("MethodName", "NONE"),
        ("ParamCount", "undefined"),
        ("searchplate", plate),
        ("towcheck", "true"),
        ("selState", state),
        ("selPlateType", ptype),
        ("g-recaptcha-response", ""),
        ("PageID", "PVO_Find_Towed_Vehicle"),
        ("PVO_VIOLATION_NUMBER", ""),
        ("PVO_PLATE_ID", plate),
        ("PVO_SEARCH_FOR_TOW", "true"),
        ("PVO_PLATE_TYPE", ptype),
        ("PVO_STATE_NAME", state),
    ]
    return "|".join(f"{k}={v}" for k, v in ordered)


def _post_fields(plate: str, state: str, ptype: str, nycserv_request: str):
    """Full POST body, field order matching the real browser submission."""
    return [
        ("searchplate", plate),
        ("towcheck", "true"),
        ("selState", state),
        ("selPlateType", ptype),
        ("g-recaptcha-response", ""),
        ("ChannelType", "ct/Browser"),
        ("RequestType", "rt/Business"),
        ("SubSystemType", "st/Payments"),
        ("AgencyType", "at/PVO"),
        ("ServiceName", "PVO_VIO_BY_PLATE_AND_TOW"),
        ("MethodName", "NONE"),
        ("PageID", "PVO_Find_Towed_Vehicle"),
        ("ParamCount", "0"),
        ("PVO_VIOLATION_NUMBER", ""),
        ("PVO_PLATE_ID", plate),
        ("PVO_SEARCH_FOR_TOW", "true"),
        ("PVO_PLATE_TYPE", ptype),
        ("PVO_STATE_NAME", state),
        ("NycservRequest", nycserv_request),
    ]


def _visible_text(page: str) -> str:
    t = re.sub(r"<script.*?</script>", " ", page, flags=re.S | re.I)
    t = re.sub(r"<style.*?</style>", " ", t, flags=re.S | re.I)
    t = re.sub(r"<[^>]+>", " ", t)
    t = html.unescape(t)
    t = re.sub(r"\s+", " ", t)
    return t.strip()


def _returned_to_search_form(page: str) -> bool:
    """The app re-renders the empty search form when a plate has no towed
    vehicle / no open violations. Detect that state."""
    return (
        'name="searchplate"' in page
        and 'VALUE="PVO_Find_Towed_Vehicle"' in page
        and "Search by Plate Number" in page
    )


def _bot_blocked(page: str) -> bool:
    return "issue with your browser settings" in page


# Labels the NYCSERV violations/tow results page uses. Surfaced when present.
_TOW_LABELS = [
    "Tow Date", "Towed", "Pound", "Facility", "Borough", "Redemption",
    "Amount Due", "Violation", "Judgment", "Marshal", "Location", "Status",
]


def _parse_results(page: str) -> tuple[list, str]:
    """Best-effort extraction of a violations/tow results page.

    NYC only shows real result rows for plates that actually have open
    violations/a tow, so this parser is written defensively: it pulls every
    data table's rows as records and returns the full visible text so a caller
    never loses information even if the exact template shifts.
    """
    records: list = []
    for tbl in re.findall(r"<table[^>]*>.*?</table>", page, flags=re.S | re.I):
        rows = re.findall(r"<tr[^>]*>(.*?)</tr>", tbl, flags=re.S | re.I)
        for row in rows:
            cells = re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", row, flags=re.S | re.I)
            vals = [_visible_text(c) for c in cells]
            vals = [v for v in vals if v]
            # keep rows that look like data (>=2 cells, mentions a known label
            # or a date/dollar amount)
            joined = " ".join(vals)
            if len(vals) >= 2 and (
                any(lbl.lower() in joined.lower() for lbl in _TOW_LABELS)
                or re.search(r"\d{2}/\d{2}/\d{2,4}", joined)
                or re.search(r"\$\s?\d", joined)
            ):
                records.append(vals)
    return records, _visible_text(page)


def find_towed_vehicle(
    plate: str,
    state: str = "NY",
    plate_type: str = "PAS",
    timeout: int = 45,
) -> TowResult:
    """Look up whether a plate's vehicle has been towed by NYC.

    Args:
        plate: License plate (spaces/dashes stripped, upper-cased).
        state: 2-letter state/province code (default NY). See reference.json.
        plate_type: NYC plate-type code (default PAS = Passenger).

    Returns a TowResult. Raises TowFinderError on network/bot-block failure,
    ValueError on an invalid plate.
    """
    plate = normalize_plate(plate)
    state = (state or "NY").strip().upper()
    plate_type = (plate_type or "PAS").strip().upper()

    session = _requests.Session(impersonate=IMPERSONATE)
    try:
        session.get(SEARCH_PAGE, timeout=timeout)  # establish session cookies
        nyreq = _build_nycserv_request(plate, state, plate_type)
        resp = session.post(
            POST_URL,
            data=_post_fields(plate, state, plate_type, nyreq),
            headers={
                "Referer": SEARCH_PAGE,
                "Origin": "https://nycserv.nyc.gov",
                "Content-Type": "application/x-www-form-urlencoded",
                "Upgrade-Insecure-Requests": "1",
            },
            timeout=timeout,
        )
    except Exception as e:  # curl_cffi network errors
        raise TowFinderError(f"request to NYCSERV failed: {e}") from e

    page = resp.text
    if resp.status_code == 403 or "Access Denied" in page[:600]:
        raise TowFinderError(
            "blocked at the Akamai edge (HTTP 403). The site's bot protection "
            "rejected the request."
        )
    if _bot_blocked(page):
        raise TowFinderError(
            "NYCSERV soft-blocked the request (browser-settings banner). "
            "The lookup was not run."
        )

    if _returned_to_search_form(page):
        return TowResult(
            plate=plate, state=state, plate_type=plate_type, towed=False,
            message=(f"No towed vehicle or open violations found for plate "
                     f"{plate} ({state}, type {plate_type})."),
            records=[], raw_text=_visible_text(page)[:4000],
        )

    records, text = _parse_results(page)
    towed = "tow" in text.lower() and bool(records)
    msg = (f"Results found for plate {plate} ({state}). "
           + ("Vehicle appears to have been towed — see records."
              if towed else "See records for details."))
    return TowResult(
        plate=plate, state=state, plate_type=plate_type, towed=towed,
        message=msg, records=records, raw_text=text[:4000],
    )


def _cli() -> None:
    import argparse
    import json as _json

    ap = argparse.ArgumentParser(
        description="NYC towed-vehicle finder (nycserv.nyc.gov)")
    ap.add_argument("plate", help="license plate")
    ap.add_argument("state", nargs="?", default="NY", help="state code (default NY)")
    ap.add_argument("plate_type", nargs="?", default="PAS",
                    help="plate-type code (default PAS)")
    args = ap.parse_args()
    try:
        res = find_towed_vehicle(args.plate, args.state, args.plate_type)
    except (ValueError, TowFinderError) as e:
        print(_json.dumps({"error": str(e)}))
        raise SystemExit(1)
    print(_json.dumps(res.to_dict(), indent=2))


if __name__ == "__main__":
    _cli()
