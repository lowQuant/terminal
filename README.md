# Terminal — Agentic Market Research in Your Browser

A Bloomberg-inspired, browser-based market terminal with **agentic
AI workflows** built in. Chain financial functions into reusable
research recipes, run them against Claude / GPT-4 / Gemini / OpenRouter,
and get a live-streaming report with screenshots and analysis —
grounded in real market data, not hallucinations.

> **Live demo:** [www.lange-invest.com](https://www.lange-invest.com)

---

## Why this exists

Bloomberg charges $24k/year for a terminal and still makes you
copy-paste between functions manually. This project is the opposite:

- **Free, self-hosted, browser-only** — no native app, no license, no VPN.
- **Agentic by default.** Every function is callable by an LLM tool
  loop. Instead of clicking through `EVTS → OMON → IVOL → GP → CN`
  for every name, you describe the analysis once and let the agent
  run the chain.
- **Bring your own model.** Settings UI accepts API keys for
  Anthropic, OpenAI, Gemini, Perplexity, and OpenRouter (400+ models
  searchable with live pricing). Your keys, your tokens, your bill.
- **Your data is yours.** Keys live in your Supabase row, encrypted
  at rest. The server never holds a master LLM key.

If you've ever thought "I wish Bloomberg let me script this" — that's
the whole pitch.

---

## Features

### 🤖 Agentic Workflows

A **workflow** is an ordered chain of function calls plus a "focus"
statement that tells the agent what to optimize for. Build them in
three ways:

1. **Natural language** — describe what you want, an LLM compiles it
   into a structured spec, you tweak it, then save.
2. **Visual builder** — add steps, pick tools from a live dropdown
   of every registered function, fill in JSON params, save.
3. **YAML on disk** — workflows are `.yaml` files in `workflows/`;
   version-control them, share them, fork them.

When you run one, you get:

- **Live streaming execution** — tool calls light up as they run,
  with spinners, elapsed time, and inline widget rendering (tables,
  sparklines, vol smiles, option chains)
- **LLM reasoning** — the model decides branching based on intermediate
  results, or falls back to scripted execution if no key is set
- **Auto-captured report** — on completion, screenshots of every
  widget plus the agent's final analysis are packaged into a
  printable HTML document. One click → vector PDF.

See [docs/WORKFLOWS.md](docs/WORKFLOWS.md) for the full user guide.

### 🏦 Multi-provider LLM support

Any agent workflow can run on:

| Provider | Tool use | Notes |
|---|---|---|
| **Anthropic** (Claude 3.5 Sonnet, Opus, Haiku, Sonnet 4.5) | ✓ native | Best tool-use reliability |
| **OpenAI** (GPT-4o, GPT-4 Turbo, o1) | ✓ native | Widest model selection |
| **Google Gemini** (2.5 Pro, 2.5 Flash, 1.5 Pro) | ✓ native | Fast + cheap |
| **Perplexity** (Sonar, Sonar Pro, Sonar Reasoning) | partial | Good for web-grounded research |
| **OpenRouter** (400+ models from all providers) | ✓ routed | Searchable catalog with live pricing |

Pick your primary provider in **⚙ Settings**, paste the key once
(stored encrypted per-user in Supabase with row-level security), and
every workflow run uses it. Switch providers on the fly — the
agent loop is provider-agnostic thanks to [litellm](https://github.com/BerriAI/litellm).

### 📊 Bloomberg-style functions

Type a short code in the global search bar (or press `/`) to jump
to a function. All functions are callable from workflows:

| Code | Function | What it does |
|---|---|---|
| `DES` | Description | Company fundamentals + overview (alias: `INFO`) |
| `FA` | Financial Analysis | Margins, growth, profitability, leverage ratios |
| `GP` | Graph / Price | Interactive price chart + OHLCV history (alias: `HIST`) |
| `CN` | Company News | Article feed with summaries (alias: `NEWS`) |
| `OMON` | Options Monitor | Full options chain with Greeks |
| `IVOL` | Options Volatility | IV smile and term structure |
| `EVTS` | Corporate Events | Earnings calendar (US + 20+ markets) |
| `ECO` | Economic Calendar | Macro data releases |
| `MOST` | Top Movers | Gainers / losers / active / premarket |
| `MOV` | Index Movers | Which constituents are driving SPX, NDX, DAX, etc. |
| `EQS` | Equity Screener | Custom multi-factor screening |
| `W` | Worksheet | Your watchlist with live quotes + news heat |
| `SEARCH` | Ticker lookup | Resolve company names to symbols |

See [docs/FUNCTIONS.md](docs/FUNCTIONS.md) for the full list, and
[docs/WORKFLOWS.md](docs/WORKFLOWS.md#tools) for which ones are
currently exposed as WF tools.

### 📈 Professional charting & data

- **TradingView embed** — full interactive candlestick charts with
  every indicator and drawing tool, when the exchange supports it
- **Lightweight Charts fallback** — clean OHLCV charts powered by
  yfinance data for exchanges TV doesn't cover
- **Multi-region coverage** — US (NASDAQ, NYSE, AMEX) + 20+ international
  exchanges including LSE, XETRA, TSE, HKEX, SIX, BIT
- **Live ticker tape** — headline indices, FX crosses, and crypto
  scrolling across the top
- **Persistent watchlists** — multi-worksheet support with live quotes,
  relative volume, earnings dates, and news heat

### 🎨 Dark-first Bloomberg aesthetic

- Monospace grids with orange accents
- Keyboard-first navigation (`/` to search, `1`-`6` for tabs, `Esc` to close)
- Collapsible panes so you can dedicate the full window to one job
- Responsive layout down to tablet width

---

## Quickstart

### Run locally

```bash
git clone https://github.com/lowQuant/terminal.git
cd terminal

# Python backend — yfinance, TradingView scanner, workflow runtime
pip install -r requirements.txt

# Optional: enable agentic mode
pip install litellm

python server.py
# Open http://localhost:8888
```

Authentication is handled via Supabase. For local dev you can either
set up a Supabase project (see `supabase_migration.sql`) or modify
`auth.js` to bypass auth.

### Deploy to PythonAnywhere

The live demo runs on PythonAnywhere. After every `git pull`:

1. Go to the **Web** tab in the PA dashboard
2. Click the green **Reload** button
3. Make sure dependencies are installed: `pip install --user litellm PyYAML`

If you skip the reload, WSGI keeps running the old Python process and
new tools / workflow files / routes won't be visible even though they're
on disk. This is the single most common "why is WF empty?" footgun.

### Configure agent mode

1. Open the terminal, log in
2. Click **⚙ Settings** in the top-right
3. Pick a **Primary Provider**
4. Pick a **Model** (OpenRouter shows all 400+ with live pricing)
5. Paste your **API Key** for that provider
6. Click **Save Settings**

Keys are stored in the Supabase `profiles.llm_keys` JSONB column with
row-level security — you can only read your own keys, and the frontend
never shows the full key after save (only a `● set` indicator).

---

## Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                     Browser (single page)                     │
│                                                                │
│  index.html + app.js + wf.js + auth.js + styles.css            │
│                                                                │
│  ┌──────────┐  ┌───────────────┐  ┌──────────┐  ┌──────────┐ │
│  │ Overview │  │   WF Hub      │  │ Settings │  │  ⌘K bar  │ │
│  │ Chart    │  │  ├─ Builder   │  │  ⚙       │  │  search  │ │
│  │ News     │  │  ├─ Run       │  │ Keys +   │  │          │ │
│  │ ...      │  │  └─ Report    │  │ Provider │  │          │ │
│  └──────────┘  └───────────────┘  └──────────┘  └──────────┘ │
└─────────────────────────────┬──────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────┐
│                     Flask backend (server.py)                  │
│                                                                │
│  functions/                                                    │
│   ├─ eco.py / evts.py / omon.py / most.py / mov.py / eqs.py   │
│   │    → Data fetchers (yfinance, TradingView scanner, NASDAQ) │
│   ├─ _wf_tools.py                                              │
│   │    → @register_tool adapters (DES, FA, GP, CN, OMON,       │
│   │      IVOL, EVTS, MOST, MOV, W, SEARCH)                     │
│   ├─ _workflow.py                                              │
│   │    → FunctionResult contract, tool registry, run context   │
│   ├─ _schema.py                                                │
│   │    → Field alias resolver (SYMBOL/PRICE/CHANGE_PCT/…)      │
│   ├─ _agent.py                                                 │
│   │    → litellm tool-use loop (Claude/GPT/Gemini/Perplexity/  │
│   │      OpenRouter) + scripted fallback                       │
│   └─ workflow.py                                               │
│        → /api/wf/list, /run, /stream/<id>, /save, …            │
└─────────────────────────────┬──────────────────────────────────┘
                              │
                              ▼
        ┌─────────────────┬──────────────┬─────────────────┐
        │   yfinance      │  TradingView │   Supabase      │
        │  OHLCV, info    │    scanner   │  auth + keys    │
        │   news, chain   │  scr/evts    │   (RLS)         │
        └─────────────────┴──────────────┴─────────────────┘
```

### Workflow execution flow

1. User clicks **Run** on a workflow in the WF hub
2. Frontend POSTs `/api/wf/run` with `workflow_id`, `inputs`,
   `llm_keys`, and `user_context` (watchlist + display name)
3. Backend spawns a background thread that calls `run_workflow`
4. A `contextvars.ContextVar` is populated with the user context so
   tools like `W` can read the watchlist without it leaking into the
   LLM's tool schema
5. Either:
   - **Scripted mode** (no key set) — steps run in topological order
     via a `ThreadPoolExecutor` for parallel batches
   - **Agentic mode** (key set) — tools are serialized to litellm's
     OpenAI-compatible format and handed to the LLM in a tool-use
     loop. The model decides order, branches on results, and writes
     the final analysis grounded in the returned data
6. Events stream back over Server-Sent Events (`/api/wf/stream/<id>`):
   `workflow_start`, `step_start`, `step_result`, `agent_thought`,
   `final_report`, `done`
7. Frontend renders each event live — widgets light up as results
   arrive, html2canvas snapshots them for the report
8. On `done`, the right pane slides in with the analysis + snapshots

---

## Tech stack

| Layer | Tech | Notes |
|---|---|---|
| **Frontend shell** | HTML + vanilla JS | No framework, no build step |
| **Charting** | TradingView widgets + Lightweight Charts | TV for supported exchanges, LW as fallback |
| **Styling** | Hand-written CSS | Custom design system, JetBrains Mono + system sans |
| **Auth** | Supabase | Row-level security for per-user data |
| **Backend** | Flask 3 | Blueprints per function, SSE for live runs |
| **Data** | yfinance + TradingView scanner + NASDAQ | Free, no API keys |
| **LLM layer** | [litellm](https://github.com/BerriAI/litellm) | Unified OpenAI-compatible interface for 100+ providers |
| **Workflows** | YAML on disk | Plain text, version-controllable, human-editable |
| **Hosting** | PythonAnywhere | Free tier works fine |

---

## Documentation

- **[docs/WORKFLOWS.md](docs/WORKFLOWS.md)** — complete guide to
  creating, editing, running, and registering workflows and tools
- **[docs/FUNCTIONS.md](docs/FUNCTIONS.md)** — Bloomberg-style function
  codes and their data sources

---

## Roadmap

### In flight
- [x] FunctionResult contract + tool registry
- [x] Agentic workflows with multi-provider LLM support
- [x] Visual workflow builder (create / edit / delete / NL compile)
- [x] Live-streaming run view with inline widgets
- [x] HTML/PDF report export with screenshots
- [x] Per-user API key storage in Supabase

### Next up
- [ ] **Scheduled workflow runs** — cron triggers for daily briefs,
      weekly screens, earnings-day alerts. "Every Monday at 8am, run
      macro_brief and email me the PDF."
- [ ] **Shared workflow library** — public workflows with fork/clone,
      community-contributed research recipes
- [ ] **FA overhaul** — full income statement, balance sheet, cash
      flow with quarterly/annual period selection and custom ratios
- [ ] **More asset classes** — commodity, FX, and crypto canonical
      function families (DES/FA/GP/CN are the stock family; other
      classes get their own)
- [ ] **Currency object layer** (`FX`) — cross-cutting service so
      every function can render in the user's base currency
- [ ] **Per-run cost tracking** — token usage + provider cost per
      workflow, aggregated per user
- [ ] **Streaming widgets** — table rows that update in place as
      data arrives, not just at step completion

### Longer term
- [ ] Portfolio tracking + P&L reconciliation
- [ ] Backtesting harness for signal workflows
- [ ] Alerts and notifications
- [ ] Mobile-native layout

---

## Contributing

Pull requests welcome. The repo is small and the cleanest way to
contribute is to add a new tool wrapper:

1. Build a data endpoint in `functions/<your_function>.py` (follow
   the pattern of the existing blueprints)
2. Register it in `functions/__init__.py` → `ALL_BLUEPRINTS`
3. Wrap it as a WF tool in `functions/_wf_tools.py` — copy the
   pattern from `wf_evts` or `wf_most` (~25 lines)
4. Add a workflow that uses it in `workflows/`
5. Open a PR

The tool is automatically available in the WF builder dropdown, the
LLM tool schema, and the saved workflow library — no frontend changes
required.

---

## License

MIT. Use it, fork it, sell it. Not financial advice; not affiliated
with Bloomberg.

## Credits

- [TradingView](https://www.tradingview.com/widget/) — free embeddable charts
- [yfinance](https://github.com/ranaroussi/yfinance) — market data
- [litellm](https://github.com/BerriAI/litellm) — unified LLM interface
- [Supabase](https://supabase.com) — auth + RLS
- [Anthropic Claude](https://anthropic.com) — for the agentic loop
  and for helping build this thing
