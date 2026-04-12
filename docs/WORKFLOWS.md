# Workflows (WF)

Agentic research workflows for the terminal. A workflow is an ordered
set of tool calls (each tool is a wrapper around a registered terminal
function) plus a **focus** statement that describes what the agent
should optimize for. When you run a workflow:

1. The backend dispatches the steps — either **scripted** (deterministic
   order from the YAML) or **agentic** (handed to Claude / GPT / Gemini
   as a tool-use loop so the model can decide the order and branch on
   intermediate results).
2. Every tool returns **structured data** + a **widget spec** — the
   widgets render live in the center pane and are automatically
   screenshotted into the final report.
3. An LLM (or a deterministic template) writes the final analysis
   grounded in the numbers the tools returned, framed by the focus
   statement you wrote.

Workflows are the "skills" that sit on top of the raw functions. They
turn a 10-click research loop into a one-click, reproducible, shareable
artifact.

---

## Quick start

Open the terminal, type `WF` in the search bar (or press `/` and type
`WF`), and pick one of the saved workflows on the left. For a fully
agentic run, open **⚙ Settings** first, pick a provider, and paste
your API key — without one, workflows fall back to scripted mode
(which still works, just without LLM-written analysis).

Three ways to create a workflow:

1. **Natural language** — paste a description in the left sidebar's
   "Describe a workflow" box and click **Compile → Edit**. An LLM
   compiles it into a structured spec that you can tweak before saving.
2. **From scratch** — click **+ New workflow** to open the builder with
   one blank step.
3. **Edit an existing one** — hover any saved card and click the ✎
   (pencil) icon.

---

## The workflow spec

A workflow is a YAML (or JSON) file in the `workflows/` directory.
Here's the structure:

```yaml
name: Watchlist Pulse
description: >
  A quick health check of your active worksheet — live quotes + top
  movers + any upcoming earnings in the names you're tracking.
focus: >
  Surface which of the user's names are leading and lagging today,
  flag upcoming earnings that could explain outsized moves, and
  highlight anything in news flow worth reacting to. Ground every
  claim in concrete numbers.

inputs:
  country:
    type: string
    default: US

steps:
  - id: watchlist
    tool: W
    label: Live watchlist quotes

  - id: earnings
    tool: EVTS
    label: Earnings on deck
    params:
      country: "{{inputs.country}}"
      days: 14
      limit: 40

tags:
  - daily
  - portfolio
```

### Top-level fields

| Field | Type | Required | Purpose |
|---|---|---|---|
| `name` | string | ✓ | Human-readable title shown in the sidebar |
| `description` | string | optional | One-line summary for the sidebar card |
| `focus` | string | recommended | **What the agent should optimize for.** This is the single most important field — it's the only thing that tells the LLM what angle to take when there are many possible ones. Short, specific, outcome-oriented. |
| `inputs` | object | optional | Parameters the user fills in at run time. Each entry is `{type, default, required}`. |
| `steps` | list | ✓ | Ordered tool calls. See below. |
| `tags` | list of strings | optional | Shown on the sidebar card for grouping |

### Steps

Each step must have:

```yaml
- id: step1              # unique within the workflow
  tool: DES              # name of a registered tool (see "Tools" below)
  label: Company snapshot  # what this step is for — shown in the stream UI
  params:                # keyword args passed to the tool
    symbol: AAPL
    exchange: NASDAQ
```

Optional per-step fields:

- **`depends_on`** — list of step ids. This step won't run until its
  dependencies have all completed. Use for "fan-out then fan-in"
  patterns where a later step needs data from an earlier one.
- **`parallel_group`** — steps that share the same group value are
  launched concurrently (up to 4 workers per batch). If omitted, steps
  run sequentially.

### Parameter templating

Params can reference:

- **Workflow inputs** — `"{{inputs.symbol}}"` — substituted at run time.
- **Prior step data** — `"{{steps.earnings.data.rows.0.symbol}}"` —
  pulls from a completed step's structured result. The path is
  dotted; use integer indices for list elements.

A whole-value template returns the native type:

```yaml
params:
  limit: "{{inputs.limit}}"    # becomes the integer 10, not "10"
```

Mixed strings interpolate to text:

```yaml
params:
  note: "Run for {{inputs.country}} over {{inputs.days}} days"
```

Unresolved references are left as literal `{{...}}` so typos surface
loudly instead of silently becoming empty strings.

---

## Tools

Every step's `tool` must be a registered WF tool. Tools are Python
adapters around the existing Flask endpoints, registered via
`@register_tool` in `functions/_wf_tools.py`. The live catalogue is
always available at `GET /api/wf/tools` and is what the builder's tool
dropdown shows.

### Current tools

| Code | Category | Description | Key params |
|---|---|---|---|
| **DES** *(alias: INFO)* | fundamentals | Company description, fundamentals, valuation multiples, margins, next earnings | `symbol*`, `exchange` |
| **FA** | fundamentals | Financial Analysis — margins, growth, profitability, balance-sheet ratios | `symbol*`, `exchange` |
| **GP** *(alias: HIST)* | price | Graph/Price — daily OHLCV + pct change + realized vol over the window | `symbol*`, `period`, `exchange` |
| **CN** *(alias: NEWS)* | news | Company News — recent articles with publishers, links, summaries | `symbol*`, `limit`, `exchange` |
| **OMON** | options | Options chain for an expiration with Greeks and P/C ratios | `symbol*`, `expiration`, `exchange` |
| **IVOL** | options | IV smile/skew across expirations, ATM term structure | `symbol*`, `exchange` |
| **EVTS** | calendar | Earnings calendar — companies reporting in the next N days | `country`, `days`, `limit` |
| **MOST** | market | Top movers for a region (gainers / losers / active / premarket) | `country`, `view`, `limit` |
| **MOV** | market | Index attribution — which constituents are driving a major index | `index*`, `sort`, `period`, `limit` |
| **W** | portfolio | Worksheet / Watchlist — user's active symbols with live quotes (reads from run context, no params) | `limit` |
| **SEARCH** | lookup | Search for tickers by company name. Agents call this to resolve names → symbols | `query*` |

`*` = required. Aliases resolve to the same executor, so existing
workflows that reference `INFO`, `HIST`, or `NEWS` keep working.

### Why not every terminal function is a WF tool

Short answer: a tool needs a server-side **data endpoint** to wrap.
Functions that are pure client-side widgets (TradingView embeds) have
no data to return:

- **`ECO`** (Economic Calendar) — rendered entirely by TradingView's
  `embed-widget-events` widget. No server endpoint exists, so there's
  nothing for a tool to return.
- **`FX`** — planned as an object layer for currency conversion across
  other functions, not as a function that returns data itself. It will
  eventually live as a cross-cutting service, not a WF tool.
- **`CMDTY`**, **`WEIF`** — not yet implemented on the backend.

As soon as any of these get a real `/api/...` endpoint, adding them as
a WF tool is a ~20-line wrapper (see [Registering a new tool](#registering-a-new-tool)).

---

## Run context

Some tools need user-specific state that **does not belong in the LLM's
tool schema** — typically because it's large, user-specific, or
sensitive. The W tool is the canonical example: it needs the user's
active watchlist, which is browser-side state.

The frontend attaches this data as `user_context` in every
`/api/wf/run` request:

```json
{
  "workflow_id": "watchlist_pulse",
  "inputs": {},
  "llm_keys": { "provider": "...", "..." : "..." },
  "user_context": {
    "watchlist": [
      { "symbol": "AAPL", "exchange": "NASDAQ", "name": "Apple Inc." },
      ...
    ],
    "display_name": "..."
  }
}
```

The backend installs this as a `contextvars.ContextVar` at the start
of the run (propagated to parallel worker threads via
`contextvars.copy_context()`). Tools read it through
`get_run_context()`:

```python
from functions._workflow import get_run_context

def wf_w(limit: int = 50) -> FunctionResult:
    ctx = get_run_context()
    watchlist = ctx.get("watchlist") or []
    # ...
```

The LLM never sees this data as a callable parameter — the tool's
`params_schema` only declares things the model should actually choose
(like `limit`). That keeps the LLM's context clean and stops it from
hallucinating a "pass me a watchlist" invocation.

---

## Creating, editing, deleting workflows (UI)

### Create a new workflow

1. Click **+ New workflow** in the left sidebar.
2. Fill in **Name**, **Description**, and the all-important **Focus**.
3. Add steps — each row has:
   - **Tool** — dropdown of all registered tools, updates the hint line below
   - **Label** — what the step is for (shown in the live stream)
   - **Params JSON** — a JSON object of keyword args (the hint line shows which params the tool takes and their types)
4. Click **+ Add step** for more, ✕ to remove.
5. Three action buttons:
   - **Save & run** — persists to disk and starts the run immediately
   - **Save** — persists only
   - **Run without saving** — one-off ad-hoc run, doesn't touch the
     saved list. Perfect for experimenting with NL-compiled drafts.

### Edit an existing workflow

Hover any saved card in the sidebar — a ✎ icon appears top-right.
Click it to open the builder pre-filled with the full spec. Save
overwrites the existing YAML file.

### Delete a workflow

Hover and click the ✕ icon. A confirmation dialog appears; confirming
deletes the YAML file from `workflows/` and reloads the in-memory
registry.

### Natural language → workflow

Type a description in the "Describe a workflow" textarea in the left
sidebar and click **Compile → Edit**. An LLM (whichever provider is
set as primary in ⚙ Settings) converts your description into a
structured spec and opens the builder so you can tweak tool choices,
params, labels, and focus before saving.

Examples that compile well:

- *"Find US names reporting earnings next week with elevated IV skew
  and pull their recent news flow."*
- *"Watchlist pulse — which of my names are up / down, any earnings
  coming up in the next two weeks."*
- *"Take one ticker, pull fundamentals, price history, vol surface
  and option chain — focus on whether implied moves look rich vs
  realized."*

---

## Running a workflow

The run panel (center pane) shows:

- **Inputs** — fields for each parameter the workflow declares, prefilled with defaults
- **Plan** — a preview of the steps in order, with their tool + label
- **▶ Run workflow** — kicks off an SSE stream

As the run progresses you see, per step:

- A **spinner** → orange bar while running, green bar when done, red on error
- The tool name, label, and the exact params that were resolved after
  templating
- The summary line the tool returned
- The widget (table / info grid / sparkline / vol smile) rendered
  inline

Once the run completes:

- The header flips from **Running ·** to **Completed ·** (or **Failed ·**)
  with the elapsed time
- The right pane (which was hidden during the run) slides in with the
  final report — the LLM's analysis, step summaries, and screenshots
  of every widget captured during the run

### Export to PDF

Click **Export** in the right pane's header. A new tab opens with the
full report (analysis + step summaries + inlined widget screenshots)
in a printable layout. Click **Save as PDF** in the toolbar of that
tab to use the browser's native print-to-PDF — you get a real vector
PDF, not rasterized.

---

## Registering a new tool

When you add a new terminal function with a data endpoint, wrap it as
a WF tool so it becomes callable from workflows. The whole pattern is
~25 lines in `functions/_wf_tools.py`:

```python
from functions._workflow import FunctionResult, register_tool
from functions._schema import field, resolve_columns

@register_tool(
    name="DIV",
    description=(
        "Dividend history and yield metrics for a ticker. Use to "
        "screen for sustainable dividend growth or payout risk."
    ),
    params_schema={
        "symbol": {"type": "string", "description": "Ticker", "required": True},
        "years":  {"type": "integer", "default": 5},
    },
    category="fundamentals",
    stock_specific=True,
)
def wf_div(symbol: str, years: int = 5) -> FunctionResult:
    payload = _flask_get_json(f"/api/dividends/{symbol}?years={years}")
    rows = payload.get("rows", [])

    return FunctionResult(
        data={"symbol": symbol, "rows": rows},
        summary=f"{symbol}: {len(rows)} dividends over {years}y, yield {payload.get('yield')}%",
        widget={
            "type": "table",
            "title": f"{symbol} dividends",
            # Semantic column request — the schema resolver picks the
            # right raw keys and the frontend formats them correctly
            "columns": resolve_columns(rows, preferred=["DATE", "PRICE"]),
            "rows": rows,
        },
    )
```

Points to note:

- **`register_tool`** is a decorator. The tool is available in every
  workflow as soon as the module is imported — the builder dropdown
  picks it up automatically, no frontend changes.
- **`params_schema`** uses our internal shape with `type`, `description`,
  `default`, and the custom `required` flag. Before being sent to the
  LLM, the schema is sanitized (via `_schema_object` in `_workflow.py`)
  to strip custom keys like `required`/`default` — the parent-level
  `required: [...]` array is rebuilt from them. This keeps Gemini and
  other strict validators happy.
- **`FunctionResult`** is the dual-output contract: `data` is for the
  agent to reason over, `summary` is the compact text the LLM reads,
  `widget` is the render spec the frontend turns into DOM.
- **`aliases=[...]`** (optional, 4th arg) — if you're renaming a tool,
  keep the old name as an alias so existing workflows don't break:
  `aliases=["DIVIDEND"]`.

### Reading run context from a tool

For tools that need user-specific state (watchlist, display name,
locale, preferences):

```python
from functions._workflow import get_run_context

def wf_my_tool():
    ctx = get_run_context()
    user_watchlist = ctx.get("watchlist", [])
    # ...
```

Don't add user-specific state to `params_schema` — the LLM would then
try to invoke the tool with a "watchlist" argument and get confused.
Context is ambient.

---

## Deployment notes

### Local development

```bash
pip install -r requirements.txt
python server.py
```

The server auto-reloads on file changes (Flask debug mode) — new
workflow YAMLs and new tools show up on the next page refresh.

### PythonAnywhere

After a `git pull`:

1. Go to the **Web** tab
2. Click the green **Reload** button for your app (or `touch` the
   `/var/www/<user>_pythonanywhere_com_wsgi.py` file)

Without this, the WSGI process keeps running the OLD Python code —
new tools, workflow files, and endpoint routes are all on disk but
the server hasn't imported them. Classic symptom: you pulled fresh
YAML workflows but the `WF` hub says "No workflows saved".

If you add new Python dependencies (like `litellm`, `PyYAML`),
install them in the PA console first:

```bash
pip install --user litellm PyYAML anthropic
```

…then reload the web app.

---

## API reference

| Method | Path | Purpose |
|---|---|---|
| `GET`    | `/api/wf/list`                | All loaded workflows (summary) |
| `GET`    | `/api/wf/tools`               | Registered tool catalog with schemas |
| `GET`    | `/api/wf/<id>`                | Full spec of one workflow (for edit) |
| `POST`   | `/api/wf/save`                | Create or update a workflow (body: full spec) |
| `DELETE` | `/api/wf/<id>`                | Delete a saved workflow |
| `POST`   | `/api/wf/run`                 | Start a run, returns `{run_id, ...}` |
| `GET`    | `/api/wf/stream/<run_id>`     | Server-Sent Events stream for a run |
| `POST`   | `/api/wf/nl`                  | Natural language → compiled spec |
| `POST`   | `/api/wf/reload`              | Force reload of the `workflows/` directory |
| `GET`    | `/api/wf/agent_status`        | Whether agentic mode is available |
| `GET`    | `/api/wf/openrouter/models`   | Live OpenRouter model catalogue (~400 models) |

### SSE event types

A run emits these events (in order):

- `workflow_start` — `{workflow, inputs, mode}`
- `step_start` — `{step_id, tool, params, label}`
- `step_result` — `{step_id, result}` where `result` is the full `FunctionResult.to_json()`
- `agent_thought` — `{text}` — only in agentic mode, one per LLM text block
- `final_report` — `{text, steps}` — final analysis + all step results
- `error` — `{message}` — recoverable; run may still finish
- `done` — `{}` — always fires last, even on errors

---

## Coming soon

- **Scheduled runs** — cron-style triggers for daily briefs, weekly
  screens, earnings-day alerts
- **Per-user workflows** — scoped to `auth.uid()` in Supabase, shareable
  links, "fork this workflow" from a public library
- **More tools** — DIV, BS (balance sheet), CS (cash statement),
  CORR (correlations), SCREEN (custom EQS from inside a workflow)
- **Asset-class-aware shortcuts** — the `DES / FA / GP / CN` set are
  the stock-asset-class tool family; commodity, FX, and crypto
  classes will get their own canonical short codes
- **Multi-step cost tracking** — token usage + provider cost per run,
  aggregated per workflow and per user
