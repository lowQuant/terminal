"""Workflow tool adapters — wraps existing function endpoints into the
``FunctionResult`` contract without touching the route handlers.

Each adapter imports the underlying data-fetching helper directly (rather
than going through Flask) so it stays cheap and testable. For tools where
the fetch logic is only exposed via a Flask view function, we call the
view with a temporary request context and parse its JSON response.

The goal here is **coverage breadth over cleverness**: get 5-6 of the
existing functions callable by the agent. Per-tool summarization is
deliberately simple — the agent reasons over structured ``data``, the
``summary`` just orients it.
"""

from __future__ import annotations

from typing import Any, Dict

from functions._workflow import FunctionResult, register_tool, get_run_context
from functions._schema import (
    field,
    resolve_columns,
    top_movers_blurb,
    fmt_cap,
    fmt_price,
)


# ═══════════════════════════════════════════════════════════════════
# Shared helpers
# ═══════════════════════════════════════════════════════════════════

def _flask_get_json(path: str) -> Any:
    """Call an internal Flask route via the test client and return JSON.

    This indirection lets the agent reuse existing route handlers without
    us refactoring every module to split fetch logic from HTTP handling.
    The server module is imported lazily to avoid circular imports.
    """
    from server import app
    with app.test_client() as client:
        resp = client.get(path)
        try:
            return resp.get_json() or {}
        except Exception:
            return {"error": f"Non-JSON response ({resp.status_code})"}


def _rows(payload: Any, key: str = "rows") -> list:
    if isinstance(payload, dict):
        val = payload.get(key, [])
        return val if isinstance(val, list) else []
    return []


# ═══════════════════════════════════════════════════════════════════
# EVTS — Corporate Events / Earnings calendar
# ═══════════════════════════════════════════════════════════════════

@register_tool(
    name="EVTS",
    description=(
        "Corporate events / earnings calendar. Returns companies reporting "
        "earnings in the next N days for a given country. Use this to find "
        "upcoming catalysts before running deeper per-ticker analysis."
    ),
    params_schema={
        "country": {
            "type": "string",
            "description": "Country code (US, DE, GB, JP, HK, etc.). Default US.",
            "default": "US",
        },
        "days": {
            "type": "integer",
            "description": "Window in days (1-45). Default 7.",
            "default": 7,
        },
        "limit": {
            "type": "integer",
            "description": "Max rows to return. Default 25.",
            "default": 25,
        },
    },
    category="calendar",
)
def wf_evts(country: str = "US", days: int = 7, limit: int = 25) -> FunctionResult:
    days = max(1, min(int(days), 45))
    limit = max(1, min(int(limit), 200))
    payload = _flask_get_json(f"/api/earnings-calendar?country={country}&days={days}")

    if "error" in payload:
        return FunctionResult(
            error=payload["error"],
            summary=f"EVTS failed for {country}",
        )

    rows = _rows(payload)[:limit]
    by_date: Dict[str, int] = {}
    for r in rows:
        d = field(r, "DATE", "?")
        by_date[d] = by_date.get(d, 0) + 1

    # Top 5 by market cap — purely schema-driven, no hardcoded keys
    top_caps = sorted(
        [r for r in rows if field(r, "MARKET_CAP")],
        key=lambda r: -(float(field(r, "MARKET_CAP") or 0)),
    )[:5]
    cap_blurb = ", ".join(
        f"{field(r, 'SYMBOL', '?')} ({fmt_cap(field(r, 'MARKET_CAP'))})"
        for r in top_caps
    )

    summary = (
        f"{len(rows)} {country} earnings over next {days} days. "
        f"Top by mcap: {cap_blurb or 'n/a'}."
    )

    return FunctionResult(
        data={
            "rows": rows,
            "country": country,
            "days": days,
            "by_date": by_date,
            "source": payload.get("source"),
        },
        summary=summary,
        widget={
            "type": "table",
            "title": f"Earnings calendar — {country} / next {days}d",
            # Semantic column request — resolve_columns picks the real keys
            "columns": resolve_columns(
                rows,
                preferred=["DATE", "SYMBOL", "NAME", "MARKET_CAP", "TIME", "EPS_EST"],
            ),
            "rows": rows,  # pass raw rows; frontend formats by key name
        },
    )


# ═══════════════════════════════════════════════════════════════════
# MOST — Top movers
# ═══════════════════════════════════════════════════════════════════

@register_tool(
    name="MOST",
    description=(
        "Top movers for a region — gainers, losers, most active, or premarket. "
        "Returns market-cap-filtered tickers sorted by the chosen view. Use "
        "this for a quick market temperature check."
    ),
    params_schema={
        "country": {"type": "string", "default": "US"},
        "view": {
            "type": "string",
            "enum": ["gainers", "losers", "active", "premarket"],
            "default": "gainers",
        },
        "limit": {"type": "integer", "default": 15},
    },
    category="market",
)
def wf_most(country: str = "US", view: str = "gainers", limit: int = 15) -> FunctionResult:
    limit = max(1, min(int(limit), 100))
    payload = _flask_get_json(f"/api/movers?country={country}&view={view}&limit={limit}")
    if isinstance(payload, dict) and "error" in payload:
        return FunctionResult(error=payload["error"], summary=f"MOST failed for {country}/{view}")

    rows = _rows(payload)[:limit]
    # Don't re-sort for "losers" — the upstream already sorted. Just use
    # the provided order for the summary blurb; direction is baked in.
    top_blurb = top_movers_blurb(rows, n=5, reverse=False)
    summary = f"Top {view} in {country}: {top_blurb}."

    return FunctionResult(
        data={"rows": rows, "country": country, "view": view},
        summary=summary,
        widget={
            "type": "table",
            "title": f"{view.title()} — {country}",
            # Semantic columns — resolver picks whatever keys the feed uses
            "columns": resolve_columns(
                rows,
                preferred=[
                    "SYMBOL", "NAME", "CHANGE_PCT", "PRICE",
                    "VOLUME", "MARKET_CAP", "SECTOR",
                ],
            ),
            "rows": rows,
        },
    )


# ═══════════════════════════════════════════════════════════════════
# OMON — Options chain
# ═══════════════════════════════════════════════════════════════════

@register_tool(
    name="OMON",
    description=(
        "Options chain for a ticker at a specific expiration, with Greeks "
        "and P/C ratios. Returns calls, puts, and summary stats. Useful for "
        "per-ticker options analysis after identifying a catalyst."
    ),
    params_schema={
        "symbol": {"type": "string", "description": "Ticker symbol, e.g. AAPL", "required": True},
        "expiration": {
            "type": "string",
            "description": "YYYY-MM-DD. Omit to use the nearest expiry.",
        },
        "exchange": {"type": "string", "default": ""},
    },
    category="options",
    stock_specific=True,
)
def wf_omon(symbol: str, expiration: str = "", exchange: str = "") -> FunctionResult:
    if not symbol:
        return FunctionResult(error="symbol required", summary="OMON: no symbol")

    # Resolve expiration if not given
    if not expiration:
        exp_payload = _flask_get_json(
            f"/api/omon/expirations/{symbol}?exchange={exchange}"
        )
        exps = (exp_payload.get("expirations") or [])
        if not exps:
            return FunctionResult(
                error=exp_payload.get("error") or "No expirations available",
                summary=f"OMON {symbol}: no options data",
            )
        expiration = exps[0]["date"]

    payload = _flask_get_json(
        f"/api/omon/chain/{symbol}?expiration={expiration}&exchange={exchange}"
    )
    if isinstance(payload, dict) and "error" in payload:
        return FunctionResult(error=payload["error"], summary=f"OMON {symbol} failed")

    s = (payload.get("summary") if isinstance(payload, dict) else None) or {}
    px = payload.get("underlyingPrice") if isinstance(payload, dict) else None
    dte = payload.get("daysToExpiry") if isinstance(payload, dict) else None
    pc = s.get("pcRatio")
    summary = (
        f"{symbol} @ {fmt_price(px)} / exp {expiration} ({dte}d). "
        f"Call vol {s.get('callVolume', 0):,}, put vol {s.get('putVolume', 0):,}, "
        f"P/C {pc if pc is not None else 'n/a'}."
    )

    return FunctionResult(
        data=payload,
        summary=summary,
        widget={
            "type": "omon",
            "title": f"{symbol} options — {expiration}",
            "payload": payload,
        },
    )


# ═══════════════════════════════════════════════════════════════════
# IVOL — Volatility smile
# ═══════════════════════════════════════════════════════════════════

@register_tool(
    name="IVOL",
    description=(
        "Implied volatility smile/skew across expirations for a ticker. "
        "Returns IV-vs-strike curves. Use to assess how the market is "
        "pricing tail risk for a specific name."
    ),
    params_schema={
        "symbol": {"type": "string", "required": True},
        "exchange": {"type": "string", "default": ""},
    },
    category="options",
    stock_specific=True,
)
def wf_ivol(symbol: str, exchange: str = "") -> FunctionResult:
    if not symbol:
        return FunctionResult(error="symbol required", summary="IVOL: no symbol")
    payload = _flask_get_json(
        f"/api/omon/volatility/{symbol}?exchange={exchange}"
    )
    curves = (payload.get("curves") if isinstance(payload, dict) else None) or []
    if not curves:
        err = payload.get("error") if isinstance(payload, dict) else None
        return FunctionResult(
            error=err or "No volatility data",
            summary=f"IVOL {symbol}: no data",
        )

    # Compute ATM IV for each curve as a rough surface snapshot
    px = payload.get("underlyingPrice", 0)
    atm_ivs = []
    for c in curves:
        points = c.get("points", [])
        if not points or not px:
            continue
        closest = min(points, key=lambda p: abs(p.get("strike", 0) - px))
        atm_ivs.append({
            "expiration": c.get("expiration"),
            "days": c.get("days"),
            "atm_iv": closest.get("iv"),
        })

    if atm_ivs:
        atm_desc = ", ".join(f"{a['days']}d={a['atm_iv']}%" for a in atm_ivs)
    else:
        atm_desc = "n/a"

    summary = f"{symbol} ATM IV term structure: {atm_desc}. Px ${px}."
    return FunctionResult(
        data={"underlyingPrice": px, "curves": curves, "atm_term": atm_ivs},
        summary=summary,
        widget={
            "type": "ivol",
            "title": f"{symbol} IV smile",
            "payload": {"underlyingPrice": px, "curves": curves},
        },
    )


# ═══════════════════════════════════════════════════════════════════
# DES — Description / Company overview
#
# Bloomberg's ``DES`` is the "description" function — a company's
# overview: who they are, sector, size, next catalyst, key ratios.
# Here it also surfaces as the back-end for the INFO alias so
# existing workflows that referenced ``INFO`` keep working.
# ═══════════════════════════════════════════════════════════════════

@register_tool(
    name="DES",
    description=(
        "Company description, fundamentals and key metrics for a ticker. "
        "Returns price, valuation multiples, margins, earnings dates, "
        "sector, and business summary. Use as the first step when "
        "analyzing a specific company."
    ),
    params_schema={
        "symbol": {"type": "string", "description": "Ticker symbol, e.g. AAPL", "required": True},
        "exchange": {"type": "string", "description": "Optional exchange prefix (NASDAQ, NYSE, LSE, etc.)", "default": ""},
    },
    category="fundamentals",
    stock_specific=True,
    aliases=["INFO"],  # back-compat for existing workflows
)
def wf_des(symbol: str, exchange: str = "") -> FunctionResult:
    if not symbol:
        return FunctionResult(error="symbol required", summary="INFO: no symbol")
    payload = _flask_get_json(f"/api/info/{symbol}?exchange={exchange}")
    if isinstance(payload, dict) and "error" in payload:
        return FunctionResult(error=payload["error"], summary=f"INFO {symbol} failed")

    name = field(payload, "NAME", symbol)
    px = field(payload, "PRICE")
    pe = payload.get("trailingPE") if isinstance(payload, dict) else None
    mcap = fmt_cap(field(payload, "MARKET_CAP"))
    sector = field(payload, "SECTOR")
    next_ern = payload.get("nextEarningsDate") if isinstance(payload, dict) else None
    summary = (
        f"{name} ({symbol}) — {sector or 'n/a'} / {mcap}. "
        f"Px {fmt_price(px)}, P/E {pe or 'n/a'}. Next earnings {next_ern or 'n/a'}."
    )
    return FunctionResult(
        data=payload,
        summary=summary,
        widget={"type": "info", "title": f"{symbol} fundamentals", "payload": payload},
    )


# ═══════════════════════════════════════════════════════════════════
# CN — Company News
#
# Bloomberg's ``CN`` surfaces a ticker's news flow. Here it aliases
# to ``NEWS`` for back-compat.
# ═══════════════════════════════════════════════════════════════════

@register_tool(
    name="CN",
    description=(
        "Company News — recent articles for a ticker with publishers, "
        "links, and timestamps. Use for qualitative context when "
        "investigating a name or looking for catalysts the numbers "
        "haven't captured yet."
    ),
    params_schema={
        "symbol": {"type": "string", "description": "Ticker symbol", "required": True},
        "limit": {"type": "integer", "description": "Max articles (1-30)", "default": 10},
        "exchange": {"type": "string", "default": ""},
    },
    category="news",
    stock_specific=True,
    aliases=["NEWS"],
)
def wf_cn(symbol: str, limit: int = 10, exchange: str = "") -> FunctionResult:
    payload = _flask_get_json(f"/api/news/{symbol}?exchange={exchange}")
    if isinstance(payload, dict) and "error" in payload:
        return FunctionResult(error=payload["error"], summary=f"NEWS {symbol} failed")
    raw_articles: list = list(payload) if isinstance(payload, list) else []
    lim = max(1, min(int(limit), 30))
    articles: list = raw_articles[:lim]
    headlines = "; ".join(str(a.get("title", ""))[:90] for a in articles[:3] if isinstance(a, dict))
    summary = f"{len(articles)} recent headlines for {symbol}. Top: {headlines[:280]}"
    return FunctionResult(
        data={"articles": articles, "symbol": symbol},
        summary=summary,
        widget={
            "type": "news",
            "title": f"{symbol} news",
            "articles": articles,
        },
    )


# ═══════════════════════════════════════════════════════════════════
# GP — Graph / Price (OHLCV history)
#
# Bloomberg's ``GP`` is the price-chart function. We return OHLCV
# candles + a tail-window pct change + realized vol so the agent can
# answer "has it already run?" without another request. ``HIST`` is
# kept as an alias for existing workflows.
# ═══════════════════════════════════════════════════════════════════

@register_tool(
    name="GP",
    description=(
        "Graph / Price — daily OHLCV history for a ticker plus computed "
        "percent change and realized volatility over the window. Use to "
        "contextualize a catalyst (has it already run?) and to compare "
        "realized vs implied vol."
    ),
    params_schema={
        "symbol": {"type": "string", "description": "Ticker symbol", "required": True},
        "period": {
            "type": "string",
            "description": "Window size",
            "enum": ["1mo", "3mo", "6mo", "1y"],
            "default": "3mo",
        },
        "exchange": {"type": "string", "default": ""},
    },
    category="price",
    stock_specific=True,
    aliases=["HIST"],
)
def wf_gp(symbol: str, period: str = "3mo", exchange: str = "") -> FunctionResult:
    payload = _flask_get_json(
        f"/api/history/{symbol}?period={period}&exchange={exchange}"
    )
    candles = payload.get("candles", []) if isinstance(payload, dict) else []
    if not candles:
        return FunctionResult(
            error=payload.get("error") if isinstance(payload, dict) else "no data",
            summary=f"HIST {symbol}: no data",
        )

    first_px = candles[0].get("close")
    last_px = candles[-1].get("close")
    pct = None
    if first_px and last_px:
        pct = (last_px - first_px) / first_px * 100.0

    # Simple realized vol estimate (daily log returns, annualized)
    import math
    closes = [c.get("close") for c in candles if c.get("close")]
    rets = []
    for i in range(1, len(closes)):
        if closes[i - 1] > 0:
            rets.append(math.log(closes[i] / closes[i - 1]))
    rv_ann = None
    if len(rets) > 5:
        mean = sum(rets) / len(rets)
        var = sum((r - mean) ** 2 for r in rets) / (len(rets) - 1)
        rv_ann = math.sqrt(var * 252) * 100

    summary = (
        f"{symbol} over {period}: {pct:+.1f}% "
        f"({first_px:.2f} → {last_px:.2f}). "
        f"Realized vol ~{rv_ann:.0f}%." if pct is not None and rv_ann else f"{symbol} history"
    )
    return FunctionResult(
        data={
            "symbol": symbol,
            "period": period,
            "candles": candles,
            "pct_change": round(pct, 2) if pct is not None else None,
            "realized_vol_ann_pct": round(rv_ann, 1) if rv_ann is not None else None,
        },
        summary=summary,
        widget={
            "type": "candles",
            "title": f"{symbol} — {period}",
            "candles": candles,
        },
    )


# ═══════════════════════════════════════════════════════════════════
# SEARCH — Ticker lookup (so agents can resolve names)
# ═══════════════════════════════════════════════════════════════════

@register_tool(
    name="SEARCH",
    description=(
        "Search for tickers by company name or symbol. Returns up to 12 "
        "matches with exchange info. Use when you have a company name but "
        "not the ticker symbol."
    ),
    params_schema={
        "query": {"type": "string", "required": True},
    },
    category="lookup",
)
def wf_search(query: str) -> FunctionResult:
    payload = _flask_get_json(f"/api/search?q={query}")
    results = payload if isinstance(payload, list) else []
    if not results:
        return FunctionResult(data={"results": []}, summary=f"No matches for {query!r}")
    top = results[:5]
    blurb = ", ".join(f"{r.get('symbol')} ({r.get('exchange')})" for r in top)
    return FunctionResult(
        data={"results": results, "query": query},
        summary=f"{len(results)} matches for {query!r}: {blurb}",
        widget={"type": "search", "results": results},
    )


# ═══════════════════════════════════════════════════════════════════
# MOV — Index movers / contribution attribution
# ═══════════════════════════════════════════════════════════════════

@register_tool(
    name="MOV",
    description=(
        "Index attribution — which constituents are driving a major "
        "index up or down today, weighted by index contribution. "
        "Supports SPX, NDX, DJI, SX5E, DAX, FTSE, CAC, NKY, HSI. "
        "Use when you want to know why the market moved, not just that it did."
    ),
    params_schema={
        "index": {
            "type": "string",
            "description": "Index code: SPX, NDX, DJI, SX5E, DAX, FTSE, CAC, NKY, HSI",
            "default": "SPX",
            "required": True,
        },
        "sort": {
            "type": "string",
            "enum": ["contribution", "gainers", "losers"],
            "default": "contribution",
        },
        "period": {
            "type": "string",
            "enum": ["1D", "1W", "1M", "YTD"],
            "default": "1D",
        },
        "limit": {"type": "integer", "default": 15},
    },
    category="market",
)
def wf_mov(index: str = "SPX", sort: str = "contribution",
           period: str = "1D", limit: int = 15) -> FunctionResult:
    payload = _flask_get_json(
        f"/api/index-movers?index={index}&sort={sort}&period={period}"
    )
    if isinstance(payload, dict) and "error" in payload:
        return FunctionResult(
            error=payload["error"],
            summary=f"MOV {index}: {payload['error']}",
        )

    rows = _rows(payload)
    limit = max(1, min(int(limit), 50))
    rows = rows[:limit]

    # Top contributors up/down for a tight summary
    gainers = [r for r in rows if (r.get("contribution") or 0) > 0][:3]
    losers = [r for r in rows if (r.get("contribution") or 0) < 0][:3]

    def fmt(r):
        sym = field(r, "SYMBOL", "?")
        contrib = r.get("contribution", 0) or 0
        return f"{sym} ({contrib:+.1f}bps)"

    label = payload.get("label", index) if isinstance(payload, dict) else index
    parts = []
    if gainers:
        parts.append("up: " + ", ".join(fmt(r) for r in gainers))
    if losers:
        parts.append("down: " + ", ".join(fmt(r) for r in losers))
    summary = f"{label} movers ({period}): " + "; ".join(parts) if parts else f"{label}: no movers"

    return FunctionResult(
        data={"rows": rows, "index": index, "period": period, "label": label},
        summary=summary,
        widget={
            "type": "table",
            "title": f"{label} — movers ({period})",
            "columns": resolve_columns(
                rows,
                preferred=["SYMBOL", "NAME", "CHANGE_PCT", "PRICE", "VOLUME", "SECTOR"],
                fill=True,
            ),
            "rows": rows,
        },
    )


# ═══════════════════════════════════════════════════════════════════
# FA — Financial Analysis
#
# Bloomberg's ``FA`` is the financial statements + ratio function.
# The terminal does not yet have a dedicated financials endpoint
# (noted as "will get a major overhaul" by the product), so for now
# FA delegates to /api/info and surfaces the subset of ratios that
# yfinance exposes: margins, growth, returns, leverage, coverage.
#
# When the real /api/financials endpoint lands, swap the fetch line
# and the tool's contract stays the same.
# ═══════════════════════════════════════════════════════════════════

@register_tool(
    name="FA",
    description=(
        "Financial Analysis — margins, growth, profitability, and "
        "balance-sheet ratios for a ticker. Use when you want to "
        "compare profitability or leverage across names, not just "
        "prices. (Currently backed by the /api/info metrics; will "
        "expand to full statements in a future update.)"
    ),
    params_schema={
        "symbol": {"type": "string", "description": "Ticker symbol", "required": True},
        "exchange": {"type": "string", "default": ""},
    },
    category="fundamentals",
    stock_specific=True,
)
def wf_fa(symbol: str, exchange: str = "") -> FunctionResult:
    if not symbol:
        return FunctionResult(error="symbol required", summary="FA: no symbol")
    payload = _flask_get_json(f"/api/info/{symbol}?exchange={exchange}")
    if isinstance(payload, dict) and "error" in payload:
        return FunctionResult(error=payload["error"], summary=f"FA {symbol} failed")

    p = payload if isinstance(payload, dict) else {}
    name = p.get("name", symbol)

    # Pull the financial-ratio subset
    ratios = {
        "grossMargins":     p.get("grossMargins"),
        "operatingMargins": p.get("operatingMargins"),
        "profitMargins":    p.get("profitMargins"),
        "returnOnEquity":   p.get("returnOnEquity"),
        "returnOnAssets":   p.get("returnOnAssets"),
        "earningsGrowth":   p.get("earningsGrowth"),
        "revenueGrowth":    p.get("revenueGrowth"),
        "trailingPE":       p.get("trailingPE"),
        "forwardPE":        p.get("forwardPE"),
        "pegRatio":         p.get("pegRatio"),
        "priceToBook":      p.get("priceToBook"),
        "priceToSalesTrailing12Months": p.get("priceToSalesTrailing12Months"),
        "dividendYield":    p.get("dividendYield"),
        "payoutRatio":      p.get("payoutRatio"),
        "beta":             p.get("beta"),
        "trailingEps":      p.get("trailingEps"),
        "forwardEps":       p.get("forwardEps"),
    }

    def pct(v):
        if v is None:
            return "n/a"
        try:
            return f"{float(v) * 100:.1f}%"
        except (TypeError, ValueError):
            return str(v)

    summary = (
        f"{name} ({symbol}) — "
        f"gross margin {pct(ratios['grossMargins'])}, "
        f"operating margin {pct(ratios['operatingMargins'])}, "
        f"ROE {pct(ratios['returnOnEquity'])}, "
        f"rev growth {pct(ratios['revenueGrowth'])}, "
        f"fwd P/E {ratios['forwardPE'] or 'n/a'}."
    )

    return FunctionResult(
        data={"symbol": symbol, "name": name, "ratios": ratios},
        summary=summary,
        widget={
            "type": "info",
            "title": f"{symbol} financial analysis",
            # Re-use the existing ``info`` widget renderer — it already
            # knows how to display a key/value grid
            "payload": p,
        },
    )


# ═══════════════════════════════════════════════════════════════════
# W — Worksheet / Watchlist
#
# The watchlist lives in the browser (localStorage worksheets). The
# frontend injects the active worksheet into the workflow run's
# ``user_context`` when kicking off a run, and this tool reads it via
# ``get_run_context()``. The tool then enriches each symbol with a
# live quote from /api/watchlist/quotes so the agent sees current
# prices + relative volume.
#
# If the frontend didn't pass a watchlist (e.g. server-side cron run
# or a stale session), the tool falls back to returning an empty list
# with a helpful message — not an error.
# ═══════════════════════════════════════════════════════════════════

@register_tool(
    name="W",
    description=(
        "Worksheet / Watchlist — the user's currently-active saved "
        "symbols with live quotes, change %, volume, and relative "
        "volume. Use this first when the user asks 'what's my "
        "watchlist doing' or 'how are my names performing'. No "
        "parameters: the list comes from the run's user context."
    ),
    params_schema={
        "limit": {
            "type": "integer",
            "description": "Max symbols to enrich (default 50)",
            "default": 50,
        },
    },
    category="portfolio",
)
def wf_w(limit: int = 50) -> FunctionResult:
    ctx = get_run_context()
    watchlist = ctx.get("watchlist") or []

    if not watchlist:
        return FunctionResult(
            data={"rows": [], "source": "empty"},
            summary=(
                "No watchlist in run context. Ask the user to select an "
                "active worksheet in the terminal before running."
            ),
            widget={"type": "table", "title": "Watchlist (empty)", "rows": []},
        )

    # Normalize — the frontend sends [{symbol, exchange, name}, ...]
    limit = max(1, min(int(limit), 100))
    items = watchlist[:limit]
    tickers_csv = ",".join(
        (it.get("symbol") or "") for it in items if it.get("symbol")
    )

    # Batch quotes
    quotes_payload = _flask_get_json(f"/api/watchlist/quotes?tickers={tickers_csv}")
    quotes_list = []
    if isinstance(quotes_payload, dict):
        quotes_list = quotes_payload.get("quotes") or []
    elif isinstance(quotes_payload, list):
        quotes_list = quotes_payload

    # Merge watchlist entries with their live quote rows. Pass RAW
    # quote fields through (camelCase like ``changePct``,
    # ``relativeVolume``) — the field-alias resolver + the frontend's
    # smart formatter handle them. No manual field re-mapping here
    # means adding new quote fields automatically flows to the UI.
    by_symbol = {q.get("symbol"): q for q in quotes_list if isinstance(q, dict)}
    rows = []
    for it in items:
        sym = it.get("symbol")
        if not sym:
            continue
        q = by_symbol.get(sym) or {}
        merged = {
            "symbol":   sym,
            "name":     it.get("name") or sym,
            "exchange": it.get("exchange"),
        }
        merged.update(q)  # raw quote fields last — they always win
        rows.append(merged)

    # Quick summary — up vs down + two biggest movers either way.
    # ``field()`` handles both changePct and change_pct via aliases.
    def pct_of(r):
        v = field(r, "CHANGE_PCT")
        try:
            return float(v) if v is not None else 0.0
        except (TypeError, ValueError):
            return 0.0

    ups = [r for r in rows if pct_of(r) > 0]
    downs = [r for r in rows if pct_of(r) < 0]
    top_ups = sorted(ups, key=lambda r: -pct_of(r))[:2]
    top_downs = sorted(downs, key=lambda r: pct_of(r))[:2]

    def fmt(r):
        pct = pct_of(r)
        sign = "+" if pct >= 0 else ""
        return f"{r['symbol']} ({sign}{pct:.1f}%)"

    summary_bits = [f"{len(rows)} symbols"]
    if ups or downs:
        summary_bits.append(f"{len(ups)} up / {len(downs)} down")
    if top_ups:
        summary_bits.append("leaders: " + ", ".join(fmt(r) for r in top_ups))
    if top_downs:
        summary_bits.append("laggards: " + ", ".join(fmt(r) for r in top_downs))
    summary = "Watchlist — " + "; ".join(summary_bits) + "."

    return FunctionResult(
        data={"rows": rows, "source": "worksheet"},
        summary=summary,
        widget={
            "type": "table",
            "title": f"Watchlist ({len(rows)})",
            "columns": resolve_columns(
                rows,
                preferred=[
                    "SYMBOL", "NAME", "CHANGE_PCT", "PRICE",
                    "VOLUME", "REL_VOLUME", "MARKET_CAP", "EXCHANGE",
                ],
            ),
            "rows": rows,
        },
    )


# Import side effect — make sure all @register_tool decorators run.
def _ensure_registered():
    """No-op helper so callers can force-import this module."""
    return True
