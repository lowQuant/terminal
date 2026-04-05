# Terminal Functions

Bloomberg-style function codes invoked from the global search bar. Type
the code (e.g. `ECO`, `EVTS`) and press Enter. Press **`Esc`** from any
function view to return Home. Functions always rank above ticker matches
in autocomplete.

## Implemented

### `ECO` — Economic Calendar
Macro economic data releases with impact ratings and Actual / Forecast /
Prior values. Filterable by country.
*Data: TradingView events widget.*

### `EVTS` — Corporate Events
Upcoming earnings calendar with EPS estimates, filterable by country
(US / EU / JP / HK) and watchlist. US uses NASDAQ's public API for full
daily market coverage; non-US regions build their universe dynamically
from TradingView's scanner API and poll yfinance for the earnings dates.
*Data: NASDAQ (US) or TradingView scanner + yfinance (non-US).*

## Planned

Shown in autocomplete with a grey `SOON` badge:

- `CMDTY` — Commodity Overview
- `FX` — Currency Cross Rates
- `WEIF` — World Equity Futures
- `MOV` — Top Movers
- `WL` — Watchlist

## Adding a New Function

1. **Register** in the `FUNCTIONS` array in `app.js`
   (`code`, `name`, `desc`, `aliases`, `implemented`)
2. **Render** — write `renderMyFunction(container)` in `app.js` and
   route it from `openFunction(code)`
3. **Style** — reuse `.function-wrapper`, `.function-header`,
   `.function-toolbar`, `.country-btn` from `styles.css`
4. **Backend** (if needed) — create `functions/<code>.py` with a Flask
   Blueprint, then append it to `ALL_BLUEPRINTS` in
   `functions/__init__.py`. The `cached()` helper lives in
   `functions/_utils.py`.

## File Map

```
app.js                    # FUNCTIONS registry, openFunction, per-function renderers
server.py                 # Stock/search/news routes + registers function blueprints
exchange_map.py           # Yahoo ↔ TradingView ↔ yfinance symbol resolution
functions/
├── __init__.py           # ALL_BLUEPRINTS list
├── _utils.py             # cached() helper
├── _tv_scanner.py        # TradingView scanner API client (universe selection)
├── eco.py                # ECO backend: country metadata endpoint
└── evts.py               # EVTS backend: NASDAQ + scanner + yfinance
```
