# nyc-tow-finder MCP server

Exposes NYC's public **"Find Your Towed Vehicle"** lookup
(<https://nycserv.nyc.gov/NYCServWeb/PVO_Find_Towed_Vehicle.jsp>) as MCP tools,
so any bot's Claude session can check a plate with typed parameters instead of
driving the browser form by hand.

## Tools

| Tool | Args | Returns |
| --- | --- | --- |
| `find_towed_vehicle` | `plate`, `state="NY"`, `plate_type="PAS"` | JSON `{plate, state, plate_type, towed, message, records}` |
| `list_states` | – | JSON map of valid state/province codes |
| `list_plate_types` | – | JSON map of valid NYC plate-type codes |

`records` is a list of parsed result rows. For a plate with no tow and no open
violations, `towed` is `false` and `records` is empty.

## How it works (and why it's not just `requests.get`)

The NYCSERV site is a classic JSP app behind **Akamai Bot Manager**. Two things
had to be reverse-engineered:

1. **Edge bot protection.** A plain `requests`/`curl` client gets a `403 Access
   Denied` at the Akamai edge — and so does a *headless* Chromium (its
   automation fingerprint is detected). The fix is a **TLS-impersonating**
   client: [`curl_cffi`](https://github.com/lexiforest/curl_cffi) with
   `impersonate="chrome124"` presents a real Chrome TLS/HTTP2 fingerprint and
   sails through with a `200`.

2. **The NYCSERV pipe-protocol.** The form doesn't POST plain fields. Its
   JavaScript (`navigation.js` → `oProtocol_fbBuildRequest`) concatenates every
   form element, in DOM order, into a single pipe-delimited `NycservRequest`
   field that the servlet actually reads:

   ```
   ChannelType=ct/Browser|RequestType=rt/Business|...|ServiceName=PVO_VIO_BY_PLATE_AND_TOW|
   MethodName=NONE|ParamCount=undefined|searchplate=ABC1234|towcheck=true|selState=NY|
   selPlateType=PAS|g-recaptcha-response=|PageID=PVO_Find_Towed_Vehicle|...
   ```

   Crucially, if the empty **`g-recaptcha-response`** field is omitted from that
   string, the app soft-blocks the request and re-renders the search form with a
   bogus *"issue with your browser settings / disable Compatibility View"*
   banner instead of running the query. Including it makes the query run.

`nyc_tow.py` rebuilds that exact request faithfully, so **no browser is needed
at runtime** — just `curl_cffi`.

Setting `towcheck=true` selects `ServiceName=PVO_VIO_BY_PLATE_AND_TOW`, so NYC
returns any open parking violations together with tow status.

## Install

```bash
mkdir -p ~/mcp-servers/nyc-tow-finder
cp ~/stephanie_swarm/mcp-servers/nyc-tow-finder/*.py     ~/mcp-servers/nyc-tow-finder/
cp ~/stephanie_swarm/mcp-servers/nyc-tow-finder/reference.json ~/mcp-servers/nyc-tow-finder/
pip install "mcp[cli]" curl_cffi          # into the interpreter mcp.json points at
```

`config/mcp.json` already registers the server at
`/Users/jasonzb/mcp-servers/nyc-tow-finder/server.py`.

## Standalone CLI (handy for testing without MCP)

```bash
python nyc_tow.py ABC1234 NY PAS
```

```json
{
  "plate": "ABC1234",
  "state": "NY",
  "plate_type": "PAS",
  "towed": false,
  "message": "No towed vehicle or open violations found for plate ABC1234 (NY, type PAS).",
  "records": []
}
```

## Notes / limitations

- The tool performs a single GET + single POST per lookup against a public NYC
  government service. Use it responsibly (don't enumerate plates).
- The positive-result parser (`records`) is deliberately defensive: it surfaces
  every data-table row plus the full visible text, because NYC only renders real
  result rows for plates that actually have a tow / open violations. If NYC
  changes the results template, `records` still returns the rows and no data is
  lost.
- `reference.json` (67 state codes, 90 plate-type codes) is scraped from the
  live form's `<select>` options.
