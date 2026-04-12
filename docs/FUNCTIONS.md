# Terminal Functions

Bloomberg-style function codes invoked from the global search bar. Type
the code (e.g. `ECO`, `EVTS`, `EQS`) and press Enter. Functions always
rank above ticker matches in autocomplete.

---

## Design principles

### Two kinds of functions

**Market-level functions** (`ECO`, `EVTS`, `EQS`, `MOST`, `MOV`) are
not tied to any single security. They render a **function hero header**
with the function code badge and name, plus their own toolbar with
filters (country, window, view, etc.):

```
┌──────────────────────────────────────────────────────┐
│  [EVTS]  CORPORATE EVENTS                            │
│          Upcoming Earnings                           │
│                                                      │
│  🇺🇸 US · 🇩🇪 DE · 🇬🇧 GB · 🇯🇵 JP    7d · 14d · 30d  │
│──────────────────────────────────────────────────────│
│  Date  │ Symbol │ Name │ Market cap │ EPS Est │ …    │
```

**Security-specific functions** (`DES`, `FA`, `GP`, `CN`, `OMON`,
`IVOL`) require a loaded ticker. They extend the **symbol bar** with
a function badge — the ticker stays visible so you know which name
you're looking at:

```
┌──────────────────────────────────────────────────────┐
│  AAPL  Apple Inc.   [OMON] Options Monitor           │
│──────────────────────────────────────────────────────│
│  Apr 15 · Apr 17 · Apr 20 · Apr 25 · May 02 ·       │
│  Strike │ Bid │ Ask │ IV │ Delta │ Gamma │ …          │
```

### Currency conversion layer (`FX`)

`FX` is **not a function** — it's a cross-cutting **service** that any
number-displaying function can call to convert values into the user's
preferred currency. The infrastructure is production-ready:

```
functions/fx.py
  └── get_rate(from_ccy, to_ccy)   — single pair (ECB daily rates)
  └── convert(amount, from, to)    — amount conversion
  └── GET /api/fx/rates            — full EUR-based rate table
  └── GET /api/fx/convert          — single conversion endpoint
```

Functions that display financial figures (`EVTS`, `MOST`, `MOV`) already
have a **currency dropdown** in their toolbar. When the user picks a
currency (e.g. EUR → USD), the function fetches the current rate from
`/api/fx/rates` and re-renders all monetary columns in the target
currency. The plan is that every function that shows numbers for a
company should eventually support this.

### Escape key behavior (current + planned)

Escape has a multi-level priority that keeps you in context as long as
possible before bailing out:

| Press | Context | Action |
|---|---|---|
| 1st `Esc` | Article / settings modal open | Close the modal |
| 1st `Esc` | In a security-specific function | Focus the **symbol selector** (so you can type a new ticker without leaving the function) |
| 2nd `Esc` | Symbol selector already focused | Return to home view |

**Planned improvement (not yet implemented):**

| Press | Action |
|---|---|
| 1st `Esc` | Close any open modal |
| 1st `Esc` (security function) | Focus the symbol selector |
| 2nd `Esc` | Show an **asset-class quick menu** for the current security — functions `1`-`9` recommended for the asset class (e.g. for equities: `DES`, `FA`, `GP`, `CN`, `OMON`, `IVOL`, …) plus `More` to see all. Selectable by mouse or number keys. |
| 3rd `Esc` | Return to Home screen |

The quick menu lets you navigate between functions for the same ticker
without ever going back to the search bar — the Bloomberg "next
function" workflow. Asset-class-aware means that when we add commodities,
FX, and crypto, each class gets its own recommended function set:

```
Equities:   1=DES  2=FA  3=GP  4=CN  5=OMON  6=IVOL  7=W  8=EVTS  9=EQS
Commodities: 1=DES  2=GP  3=CN  4=OMON  5=SEAS (seasonal)  …
FX pairs:    1=GP   2=CN  3=CORR  4=VOL  …
Crypto:      1=DES  2=GP  3=CN  4=OMON  5=CHAIN (on-chain metrics)  …
```

This is the core navigation model going forward — the search bar is
for **finding** a security; the Esc quick-menu is for **exploring** it
across functions.

---

## Implemented functions

### `ECO` — Economic Calendar

Macro economic data releases with impact ratings and Actual / Forecast /
Prior values. Filterable by country.

| Property | Value |
|---|---|
| **Type** | Market-level (function hero header) |
| **Data source** | TradingView `embed-widget-events` |
| **Backend** | `functions/eco.py` — country list only, the widget handles data |
| **Currency** | N/A (events, not prices) |
| **WF tool** | ❌ — client-side widget only, no data endpoint to wrap |
| **Filters** | Country picker (TradingView-native filter, driven by `_countries.py`) |

### `EVTS` — Corporate Events (Earnings Calendar)

Upcoming earnings with EPS estimates, market cap, reporting time. Full
daily market coverage for US; international markets via TradingView
scanner.

| Property | Value |
|---|---|
| **Type** | Market-level |
| **Data source** | NASDAQ public API (US), TradingView scanner (non-US) |
| **Backend** | `functions/evts.py` |
| **Currency** | ✅ — market cap + EPS converted via `/api/fx/rates` |
| **WF tool** | ✅ `EVTS` — params: `country`, `days`, `limit` |
| **Filters** | Country, scope (all / watchlist), window (7d/14d/30d), currency, column filters (market cap, EPS estimate, last-year EPS) |

### `EQS` — Equity Screener

Custom multi-factor stock screen. Select a market, pick from preset
filter collections or build your own with the filter builder, and the
backend translates your criteria into TradingView scanner queries.

| Property | Value |
|---|---|
| **Type** | Market-level (reference implementation for function hero pattern) |
| **Data source** | TradingView scanner API |
| **Backend** | `functions/eqs.py` — `/api/eqs/markets`, `/api/eqs/fields`, `/api/eqs/scan` |
| **Currency** | ❌ (planned) |
| **WF tool** | ❌ (planned — needs POST-based tool adapter for scan) |
| **Filters** | Market dropdown, preset buttons (loaded from `/api/eqs/fields`), dynamic filter builder (+Add Filter, operator/value per field) |

### `MOST` — Most Active / Top Movers

Gainers, losers, most active by volume, and US pre-market movers.
Market-cap floor prevents microcap noise.

| Property | Value |
|---|---|
| **Type** | Market-level |
| **Data source** | TradingView scanner API |
| **Backend** | `functions/most.py` |
| **Currency** | ✅ — price + market cap converted via `/api/fx/rates` |
| **WF tool** | ✅ `MOST` — params: `country`, `view`, `limit` |
| **Filters** | Country, view (gainers/losers/active/premarket), currency, column filters (market cap, change%, rel. volume) |

### `MOV` — Index Movers

Which index constituents are driving the index up or down, ranked by
contribution in basis points. Answers "why did the S&P move?" not
just "how much did it move?"

| Property | Value |
|---|---|
| **Type** | Market-level |
| **Data source** | TradingView scanner API |
| **Backend** | `functions/mov.py` |
| **Currency** | ✅ |
| **WF tool** | ✅ `MOV` — params: `index`, `sort`, `period`, `limit` |
| **Indices** | SPX, NDX, DJI, SX5E, DAX, FTSE, CAC, NKY, HSI |
| **Filters** | Index dropdown, period (1D-YTD), sort (contribution/gainers/losers), currency, column filters |

### `OMON` — Options Monitor

Full options chain for a single expiration with calculated Greeks
(delta, gamma, theta, vega via Black-Scholes). Calls and puts side
by side.

| Property | Value |
|---|---|
| **Type** | Security-specific (symbol bar + function badge) |
| **Data source** | yfinance |
| **Backend** | `functions/omon.py` — `/api/omon/expirations`, `/api/omon/chain` |
| **Currency** | ❌ (all USD currently; FX conversion planned) |
| **WF tool** | ✅ `OMON` — params: `symbol*`, `expiration`, `exchange` |
| **Toolbar** | Expiry pills (click to load chain), Greeks toggle, Vol Curve shortcut → IVOL |

### `IVOL` — Options Volatility

Implied volatility smile / skew across multiple expirations. OI-weighted
IV for each strike, with a per-expiration curve overlay so you can
visually compare term structure.

| Property | Value |
|---|---|
| **Type** | Security-specific |
| **Data source** | yfinance |
| **Backend** | `functions/omon.py` — `/api/omon/volatility` |
| **Currency** | N/A (IV is dimensionless) |
| **WF tool** | ✅ `IVOL` — params: `symbol*`, `exchange` |
| **Toolbar** | Expiry pills (multi-select), Chain shortcut → OMON |

### `DES` — Description (Overview)

Company fundamentals: price, market cap, sector, valuation multiples
(P/E, P/B, P/S, PEG), margins, earnings dates, beta, 52-week range.
The "front page" for any single name.

| Property | Value |
|---|---|
| **Type** | Security-specific (renders as the Overview tab) |
| **Data source** | yfinance |
| **Backend** | `server.py` — `/api/info/<symbol>` |
| **Currency** | ❌ (planned) |
| **WF tool** | ✅ `DES` (alias: `INFO`) |

### `FA` — Financial Analysis

Financial ratios: gross/operating/profit margins, ROE, ROA, earnings
growth, revenue growth, trailing/forward PE, PEG, dividend yield,
payout ratio, beta.

| Property | Value |
|---|---|
| **Type** | Security-specific (renders as the Financials tab) |
| **Data source** | yfinance `.info` (will be overhauled to full IS/BS/CF) |
| **Backend** | `server.py` — `/api/info/<symbol>` (shares the endpoint with DES) |
| **Currency** | ❌ (planned) |
| **WF tool** | ✅ `FA` |
| **Note** | Currently surfaces the ratio subset from yfinance's `.info`. A major overhaul is planned: full income statement, balance sheet, and cash flow with quarterly/annual period selection and custom-calculated ratios (ROIC, FCF yield, etc.) |

### `GP` — Graph / Price (Chart)

Full interactive price chart. When TradingView supports the exchange,
the chart is a live TradingView embed with all indicators, drawing
tools, and timeframes. For unsupported exchanges, a Lightweight Charts
fallback renders OHLCV candles from yfinance data.

| Property | Value |
|---|---|
| **Type** | Security-specific (renders as the Chart tab) |
| **Data source** | TradingView embed (live) or yfinance (fallback) |
| **Backend** | `server.py` — `/api/history/<symbol>` (for LW Charts fallback) |
| **WF tool** | ✅ `GP` (alias: `HIST`) — returns OHLCV candles + pct change + realized vol |

### `CN` — Company News

Recent news articles for a ticker — headlines, publishers, timestamps,
thumbnails, summaries. Includes an article reader modal that extracts
full text via trafilatura.

| Property | Value |
|---|---|
| **Type** | Security-specific (renders as the News tab) |
| **Data source** | yfinance `.news` |
| **Backend** | `server.py` — `/api/news/<symbol>`, `/api/article` (content extraction) |
| **WF tool** | ✅ `CN` (alias: `NEWS`) |

### `W` — Worksheet / Watchlist

Multi-worksheet support with custom symbol lists. Live enriched quotes
(price, change%, volume, relative volume, market cap, earnings date,
news heat). Split-view: clickable watchlist + chart for selected name.

| Property | Value |
|---|---|
| **Type** | Market-level (no security required; renders its own layout) |
| **Data source** | yfinance via `/api/watchlist/quotes` |
| **Backend** | `functions/watchlist.py` |
| **Currency** | ❌ (planned) |
| **WF tool** | ✅ `W` — reads the user's active worksheet from the run context. No params needed. |
| **Storage** | `localStorage` (per-browser, not synced via Supabase yet) |

---

## Planned / not yet implemented

Shown in autocomplete with a grey `SOON` badge:

| Code | Name | Status |
|---|---|---|
| `CMDTY` | Commodity Overview | Not started — needs a data source (TV scanner can query commodities) |
| `WEIF` | World Equity Futures | Not started |

---

## Adding a new function

### 1. Register in the frontend

Add an entry to the `FUNCTIONS` array in `app.js`:

```javascript
{
  code: 'DIV',
  name: 'Dividend Analysis',
  desc: 'Dividend history, yield trends, and payout sustainability',
  aliases: ['DIV', 'DIVIDEND', 'YIELD'],
  implemented: true,
  stockSpecific: true,    // requires a loaded ticker (omit for market-level)
},
```

`stockSpecific: true` means:
- The symbol bar stays visible (with a function badge)
- `Esc` first focuses the symbol selector
- The function won't open until a ticker is loaded

`stockSpecific: false` (or omitted) means:
- The symbol bar is hidden
- The function renders its own header (the "function hero" pattern)

### 2. Write the renderer

Add a `renderDividends(container)` function in `app.js` and wire it
into the `openFunction` switch:

```javascript
case 'DIV': renderDividends(dashboard); break;
```

Use EQS as a template for market-level functions, or OMON for
security-specific ones. The common building blocks are:

| CSS class | What it gives you |
|---|---|
| `.function-header` | Hero header with code badge + name |
| `.function-header__code` | Orange monospace badge ("DIV") |
| `.function-header__name` | Main title + subtitle |
| `.function-toolbar` | Toolbar row with filters and controls |
| `.country-btn` | Pill-shaped filter buttons |
| `.func-table` | Data table with sorting support |

### 3. Backend (if needed)

Create `functions/div.py` with a Flask Blueprint:

```python
from flask import Blueprint, jsonify, request
div_bp = Blueprint('div', __name__)

@div_bp.route('/api/dividends/<symbol>')
def get_dividends(symbol): ...
```

Register in `functions/__init__.py`:

```python
from functions.div import div_bp
ALL_BLUEPRINTS = [..., div_bp]
```

### 4. Currency support

If the function displays monetary values, add the currency dropdown
to the toolbar and call `/api/fx/rates` to convert. Follow the pattern
in `MOST` / `MOV`:

```javascript
// In the toolbar HTML:
<select class="currency-dropdown" onchange="...">
  <option value="">Local CCY</option>
  <option value="USD">USD</option>
  ...
</select>

// On change:
const rates = await fetch('/api/fx/rates').then(r => r.json());
const rate = rates.rates[targetCcy] / rates.rates[sourceCcy];
// Re-render monetary columns multiplied by rate
```

The FX module (`functions/fx.py`) provides:
- `get_rate(from_ccy, to_ccy)` — Python-side conversion
- `GET /api/fx/rates` — full ECB daily rate table (EUR-based)
- `GET /api/fx/convert?from=JPY&to=USD&amount=1000000` — single conversion

### 5. WF tool wrapper (if the function has a data endpoint)

Wrap it as a workflow tool in `functions/_wf_tools.py`:

```python
@register_tool(
    name="DIV",
    description="Dividend history, yield trends, and payout sustainability.",
    params_schema={
        "symbol": {"type": "string", "required": True},
    },
    category="fundamentals",
    stock_specific=True,
)
def wf_div(symbol: str) -> FunctionResult:
    payload = _flask_get_json(f"/api/dividends/{symbol}")
    ...
```

The tool appears in the WF builder dropdown automatically — no
frontend changes required. See [WORKFLOWS.md](WORKFLOWS.md) for the
full guide.

---

## File map

```
app.js                           # FUNCTIONS registry, openFunction(), per-function renderers
server.py                        # Stock info/search/news/history routes + blueprint registration
exchange_map.py                  # Yahoo ↔ TradingView ↔ yfinance symbol resolution

functions/
├── __init__.py                  # ALL_BLUEPRINTS list + shared /api/countries endpoint
├── _utils.py                    # cached() helper + TTL constants
├── _countries.py                # Country registry (flags, names, ECB/scanner/ECO codes)
├── _tv_scanner.py               # TradingView scanner API client (used by EVTS, MOST, MOV, EQS)
├── eco.py                       # ECO: country metadata (widget is client-side)
├── evts.py                      # EVTS: NASDAQ (US) + scanner (non-US) earnings
├── eqs.py                       # EQS: markets, fields, scan endpoints
├── most.py                      # MOST: gainers / losers / active / premarket
├── mov.py                       # MOV: index constituent attribution
├── omon.py                      # OMON + IVOL: options chain + volatility smile
├── fx.py                        # FX service: ECB rates, conversion endpoints
├── watchlist.py                 # W: batch quotes, relative volume, earnings proximity
│
│   ── Workflow layer ──
├── _workflow.py                 # FunctionResult contract, tool registry, context var
├── _schema.py                   # Field alias resolver (SYMBOL/PRICE/CHANGE_PCT/…)
├── _wf_tools.py                 # @register_tool adapters for all functions
├── _agent.py                    # litellm tool-use loop + scripted fallback
└── workflow.py                  # WF blueprint: /api/wf/* routes

workflows/                       # Saved workflow definitions (YAML)
├── macro_brief.yaml
├── single_name_deep_dive.yaml
├── earnings_vol_screen.yaml
└── watchlist_pulse.yaml

docs/
├── FUNCTIONS.md                 # This file
└── WORKFLOWS.md                 # Workflow user guide
```
