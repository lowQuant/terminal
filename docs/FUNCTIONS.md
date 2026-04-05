# Terminal Functions

Terminal supports **Bloomberg-style function codes** that open dedicated,
full-screen analytical views independent of the currently loaded ticker.
Functions are invoked from the global search bar — just type the code
(e.g. `ECO`, `EVTS`) and press Enter, or pick it from the autocomplete
dropdown where functions always rank above ticker matches.

Press **`Esc`** from any function view to return to Home.

---

## Concept

Functions live alongside the stock-context tabs (Overview, Chart, News,
Financials, Profile, Watchlist) but operate at a different level:

| | Stock tabs | Functions |
|---|---|---|
| Scope | A single loaded ticker | Global / market-wide |
| Activated by | Loading a symbol | Typing the function code |
| Nav bar | Numbered tabs `1`–`6` | Hidden |
| Symbol bar | Shown | Hidden |
| Return to Home | `Esc` | `Esc` |

Each function is registered in the `FUNCTIONS` array in `app.js`:

```js
{
  code: 'ECO',
  name: 'Economic Calendar',
  desc: 'Economic data releases & events',
  aliases: ['ECO', 'ECON', 'ECONOMIC', 'CALENDAR'],
  implemented: true,
}
```

- **`code`** — the canonical short code shown in UI
- **`aliases`** — all strings that should prefix-match in search
- **`implemented: false`** displays the function as a "SOON" teaser
  in the dropdown but refuses to open it (shows a toast)

---

## Search & Autocomplete

1. Focus the search (`/` or `⌘K`) and start typing.
2. Matches come in two sections, **functions first**:
   - **FUNCTIONS** — all registered functions whose code or aliases
     prefix-match the query
   - **SEARCH RESULTS** — ticker matches from the `/api/search` backend
     (yfinance search)
3. **Enter** opens the first match. If the raw input exactly equals a
   function code (e.g. you typed `ECO` and press Enter), the function
   opens immediately — tickers are only checked if no function matches.

Function entries show an orange **`FN`** badge. Unimplemented ones show
a grey **`SOON`** badge.

---

## Implemented Functions

### `ECO` — Economic Calendar

**What it does:** Shows macro economic data releases with impact
ratings and Actual / Forecast / Previous values, grouped by day.

**Data source:** TradingView's free embeddable *events* widget
(`embed-widget-events.js`). No API key required. The widget renders
its own table; we overlay a 3-column header bar (**Actual · Forecast ·
Prior**) because the widget doesn't expose column labels natively.

**Controls:**
- **Country filter** — 19 countries with flag buttons (US, EU, GB, DE,
  FR, IT, ES, CH, JP, CN, IN, KR, AU, NZ, CA, MX, BR, TR, ZA). Click
  to toggle. Default: US.
- **Presets** — `All` / `G7` / `Clear`
- The widget re-injects whenever the country selection changes.

**Status-bar attribution:** `Data: TradingView`

**Aliases:** `ECO`, `ECON`, `ECONOMIC`, `CALENDAR`

---

### `EVTS` — Corporate Events (Earnings Calendar)

**What it does:** Upcoming earnings releases across major world
regions, grouped by date, with EPS estimate, last-year EPS, and market
cap. Rows click-through to the ticker's Overview tab.

**Data sources:**
| Country | Source | Universe |
|---|---|---|
| **US** 🇺🇸 | NASDAQ public API (`api.nasdaq.com/api/calendar/earnings`) — no API key | **Full daily market coverage** (every US-listed company reporting that day) |
| **EU** 🇪🇺 | yfinance `Ticker.calendar` polled in parallel | **STOXX Europe 600** — ~150 top constituents across Germany, France, Netherlands, Italy, Spain, Switzerland, Benelux, Nordics, and the UK (FTSE 100) |
| **JP** 🇯🇵 | yfinance | **Nikkei 225** top constituents (~55) |
| **HK** 🇭🇰 | yfinance | **Hang Seng Index** constituents (~50) |

The US path is exhaustive — NASDAQ's API returns every symbol
reporting on each requested date. For non-US regions there is no
equivalent free market-wide feed, so we poll `yfinance.Ticker.calendar`
across the benchmark index constituents. Each regional universe is
ordered by market cap so megacaps surface first.

Responses are cached server-side for 30 minutes.

**Controls:**
- **Country** — US / EU / JP / HK. Changing the country triggers a
  refetch. The "All" scope button relabels to the underlying universe
  (e.g. "All US Companies" → "STOXX Europe 600").
- **Scope** — `All` vs. `My Watchlist` (client-side filter against
  `state.watchlist`, applies on top of the fetched rows).
- **Window** — `Next 7 days` / `Next 14 days` / `Next 30 days`. Changes
  trigger a refetch (US only — regional responses are computed over
  the cutoff client-side).
- **Refresh** — bypasses cache and refetches.

**Row columns:** Date · Time (BMO/AMC) · Ticker · Company · EPS Est. ·
Last Yr · Mkt Cap

**Status-bar attribution:**
- US → `Data: NASDAQ`
- EU / JP / HK → `Data: Yahoo Finance`

**Aliases:** `EVTS`, `EVENTS`, `EARN`, `EARNINGS`

**Future work:** For exhaustive global coverage, the upgrade path is a
third-party provider with a worldwide feed — **Finnhub** or
**Financial Modeling Prep**, both offer free API-key tiers. Drop-in
replacements for `_fetch_regional_earnings` would keep the frontend
unchanged.

---

## Teaser Functions (Not Yet Implemented)

Shown in autocomplete with a grey `SOON` badge. Clicking any of these
triggers a toast; they're placeholders for future work.

| Code | Name | Planned Description |
|---|---|---|
| `CMDTY` | Commodity Overview | Major commodities snapshot (energy, metals, ags, softs) |
| `FX` | Currency Cross Rates | Major / minor / exotic FX cross-rate matrix |
| `WEIF` | World Equity Futures | Global index futures dashboard |
| `MOV` | Top Movers | Gainers & losers by session / market-cap bucket |
| `WL` | Watchlist | Personal watchlist manager (persisted per user) |

---

## Adding a New Function (Developer Guide)

Minimal checklist to ship a new function:

### 1. Register in `app.js`

```js
// In the FUNCTIONS array
{
  code: 'MOV',
  name: 'Top Movers',
  desc: 'Gainers & losers',
  aliases: ['MOV', 'MOVERS', 'GAINERS', 'LOSERS'],
  implemented: true,       // flip to true when the renderer is ready
}
```

### 2. Route the renderer

In `openFunction(code)`:

```js
switch (code) {
  case 'ECO':  renderEcoCalendar(dashboard); break;
  case 'EVTS': renderEventsCalendar(dashboard); break;
  case 'MOV':  renderTopMovers(dashboard); break;      // new
}
```

### 3. Write the renderer

Function views should:

- Set `container.className = 'dashboard dashboard--function'`
- Use the shared layout skeleton (`.function-wrapper` →
  `.function-header` → `.function-toolbar` → `.panel.function-panel`)
- Call `setDataSource('<provider>')` so the status bar shows the
  correct attribution
- Use `.country-btn` for filter buttons (the shared styling)

Reference implementation: see `renderEcoCalendar` and
`renderEventsCalendar` in `app.js`.

### 4. Backend endpoint (if needed)

If the function needs server-side data, add a new route in
`server.py` following the existing pattern:

```python
@app.route('/api/my-function')
def my_function():
    def fetch():
        # ... call external API / yfinance, transform data
        return rows

    try:
        data = cached('my_function_key', fetch, ttl=300)
        return jsonify({'rows': data, 'source': 'MyProvider'})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500
```

Use the `cached(key, fetch_fn, ttl)` helper for in-memory caching.

### 5. Add styles

Function-specific styles live in `styles.css` under the `FUNCTION
VIEWS` section. Reuse existing components (`.country-btn`,
`.function-toolbar`, `.evts-table`, `.panel`) where possible.

### 6. Update this doc

Add an entry under "Implemented Functions" with the data source,
controls, and any notable design decisions.

---

## Keyboard Reference

| Key | Action |
|---|---|
| `/` or `⌘K` | Focus search |
| `Enter` | Open top match (function wins over ticker) |
| `Esc` | Close search / close modal / return to Home |
| `↑` / `↓` | Navigate dropdown results |
| `1`–`6` | Switch stock-context tab (requires a loaded symbol) |

---

## File Map

| File | Responsibility |
|---|---|
| `app.js` — `FUNCTIONS` array | Registry of all function codes and metadata |
| `app.js` — `openFunction()` | Entry point; hides stock UI, dispatches to renderer |
| `app.js` — `renderEcoCalendar`, `renderEventsCalendar`, … | Per-function view renderers |
| `app.js` — `setDataSource()` | Updates the status-bar attribution |
| `server.py` — `/api/earnings-calendar` | EVTS backend (NASDAQ + yfinance) |
| `styles.css` — `FUNCTION VIEWS` section | Shared function layout styling |
