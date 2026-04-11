"""Schema-agnostic helpers for WF tool adapters.

The core design trade-off here: terminal functions each have their own
backend (yfinance / TradingView scanner / NASDAQ / ...), and each source
uses different field names for the same concepts. ``change`` vs
``change_pct`` vs ``percentChange``, ``ticker`` vs ``symbol``, ``close``
vs ``price`` vs ``lastPrice``. Hardcoding a specific spelling inside each
WF adapter means every new function breaks the abstraction.

This module centralizes the mapping. Adapters never look at raw keys
directly — they ask for semantic fields (``SYMBOL``, ``CHANGE_PCT``,
``PRICE``) and the resolver handles aliases. When a new upstream adds a
new spelling, we add it once here and every adapter picks it up.

The frontend table widget mirrors this: if an adapter doesn't specify
columns, the widget infers them from the row keys, formats headers via
snake_case → Title Case, and formats values based on key-name
heuristics (anything with ``cap`` renders as $B/T, anything with ``pct``
as +X.X%, etc.). The net effect: **add a new function, drop it into
the tool registry, and it just renders.**
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence


# ═══════════════════════════════════════════════════════════════════
# Semantic field aliases
#
# Ordered from most preferred to least — the resolver returns the
# first non-None / non-missing alias it finds. "Preferred" here means
# "most descriptive name", not "most common" — we'd rather pick the
# unambiguous ``change_pct`` over the shorter ``change`` when both
# exist, even if only one upstream uses the longer name.
# ═══════════════════════════════════════════════════════════════════

FIELD_ALIASES: Dict[str, List[str]] = {
    "SYMBOL":        ["symbol", "ticker", "tvSymbol", "tv_symbol", "code"],
    "NAME":          ["name", "longName", "longname", "shortName", "company_name"],
    "PRICE":         ["price", "lastPrice", "last_price", "currentPrice",
                      "regularMarketPrice", "close", "last"],
    "CHANGE_PCT":    ["change_pct", "changePct", "percentChange",
                      "regularMarketChangePercent", "pct_change",
                      "change"],  # last-ditch — some feeds use "change" for pct
    "CHANGE_ABS":    ["change_abs", "changeAbs", "regularMarketChange"],
    "VOLUME":        ["volume", "regularMarketVolume", "totalVolume"],
    "REL_VOLUME":    ["rel_volume", "relativeVolume", "volRatio"],
    "MARKET_CAP":    ["market_cap", "marketCap", "mcap"],
    "SECTOR":        ["sector", "gicsSector"],
    "INDUSTRY":      ["industry", "gicsIndustry"],
    "DATE":          ["date", "day", "reportDate"],
    "TIME":          ["time", "when", "hour", "session"],
    "EPS_EST":       ["eps_estimate", "epsEstimate", "epsForecast"],
    "COUNTRY":       ["country"],
    "EXCHANGE":      ["exchange", "yfExchange", "tvPrefix"],
    "FISCAL_Q":      ["fiscal_quarter", "fiscalQuarter", "quarter"],
    "HIGH":          ["high", "regularMarketDayHigh", "dayHigh"],
    "LOW":           ["low", "regularMarketDayLow", "dayLow"],
    "OPEN":          ["open", "regularMarketOpen", "openPrice"],
    "TITLE":         ["title", "headline"],
    "PUBLISHER":     ["publisher", "source", "provider"],
    "URL":           ["link", "url", "canonicalUrl"],
}


def field(row: Any, semantic: str, default: Any = None) -> Any:
    """Look up a semantic field on a row via aliases.

    >>> field({"ticker": "AAPL", "close": 180}, "SYMBOL")
    'AAPL'
    >>> field({"ticker": "AAPL", "close": 180}, "PRICE")
    180
    """
    if not isinstance(row, dict):
        return default
    for key in FIELD_ALIASES.get(semantic, [semantic.lower()]):
        if key in row and row[key] is not None:
            return row[key]
    return default


def fields(row: Any, *semantics: str) -> Dict[str, Any]:
    """Pull multiple semantic fields at once into a clean dict.

    >>> fields({"ticker": "AAPL", "close": 180}, "SYMBOL", "PRICE")
    {'SYMBOL': 'AAPL', 'PRICE': 180}
    """
    return {s: field(row, s) for s in semantics}


def first_available_alias(sample_row: Any, semantic: str) -> Optional[str]:
    """Return the actual key name used by this upstream for a semantic field.

    Useful when the frontend needs to render columns and wants to know
    which raw key to pull — e.g., "this feed calls it ``close``, tell me
    so I can label the column properly."
    """
    if not isinstance(sample_row, dict):
        return None
    for key in FIELD_ALIASES.get(semantic, []):
        if key in sample_row:
            return key
    return None


# ═══════════════════════════════════════════════════════════════════
# Smart table columns
#
# Adapters declare their preferred semantic columns (e.g. ``["SYMBOL",
# "NAME", "CHANGE_PCT", "PRICE", "VOLUME"]``). ``resolve_columns`` maps
# those to the actual keys present in the first row, drops ones not
# available, and optionally backfills with any leftover columns from
# the row (capped) so the user sees everything.
# ═══════════════════════════════════════════════════════════════════

def resolve_columns(
    rows: Sequence[Dict[str, Any]],
    preferred: Sequence[str],
    fill: bool = False,
    max_cols: int = 8,
) -> List[Dict[str, str]]:
    """Pick the columns to render, in order, with nice display names.

    Returns a list of ``{"key": raw_key, "semantic": sem, "display": label}``.
    Adapters pass this to the widget as ``widget["columns"]``, so the
    frontend doesn't have to duplicate the alias logic.

    If ``fill`` is True, any raw keys present in the first row that
    weren't covered by ``preferred`` are appended at the end — handy
    for "show everything we've got" widgets.
    """
    if not rows:
        return []
    sample = rows[0]
    if not isinstance(sample, dict):
        return []

    cols: List[Dict[str, str]] = []
    used_keys: set = set()

    for sem in preferred:
        key = first_available_alias(sample, sem)
        if key and key not in used_keys:
            cols.append({
                "key": key,
                "semantic": sem,
                "display": _display_name(sem, key),
            })
            used_keys.add(key)

    if fill:
        for key in sample.keys():
            if key in used_keys or len(cols) >= max_cols:
                continue
            cols.append({
                "key": key,
                "semantic": "",
                "display": _title_case(key),
            })
            used_keys.add(key)

    return cols[:max_cols]


# ═══════════════════════════════════════════════════════════════════
# Display helpers
# ═══════════════════════════════════════════════════════════════════

SEMANTIC_LABELS: Dict[str, str] = {
    "SYMBOL":      "Symbol",
    "NAME":        "Name",
    "PRICE":       "Price",
    "CHANGE_PCT":  "Chg %",
    "CHANGE_ABS":  "Chg",
    "VOLUME":      "Volume",
    "REL_VOLUME":  "Rel Vol",
    "MARKET_CAP":  "Mkt Cap",
    "SECTOR":      "Sector",
    "INDUSTRY":    "Industry",
    "DATE":        "Date",
    "TIME":        "Time",
    "EPS_EST":     "EPS Est",
    "COUNTRY":     "Country",
    "EXCHANGE":    "Exchange",
    "FISCAL_Q":    "Fiscal Q",
    "HIGH":        "High",
    "LOW":         "Low",
    "OPEN":        "Open",
    "TITLE":       "Title",
    "PUBLISHER":   "Publisher",
    "URL":         "URL",
}


def _display_name(semantic: str, raw_key: str) -> str:
    if semantic and semantic in SEMANTIC_LABELS:
        return SEMANTIC_LABELS[semantic]
    return _title_case(raw_key)


def _title_case(key: str) -> str:
    """snake_case / camelCase → Title Case."""
    # camelCase → camel_case
    out: List[str] = []
    for i, ch in enumerate(key):
        if ch.isupper() and i > 0 and not key[i - 1].isupper():
            out.append("_")
        out.append(ch)
    normalized = "".join(out).replace("-", "_")
    parts = [p for p in normalized.split("_") if p]
    return " ".join(p.capitalize() for p in parts) if parts else key


# ═══════════════════════════════════════════════════════════════════
# Summary helpers
#
# Every adapter needs a one-liner summary for the agent. These helpers
# handle the common "top N by metric" + "top N movers" patterns so
# adapters don't reinvent the string-formatting each time.
# ═══════════════════════════════════════════════════════════════════

def fmt_cap(n: Any) -> str:
    try:
        n = float(n)
    except (TypeError, ValueError):
        return "n/a"
    if n <= 0:
        return "n/a"
    if n >= 1e12:
        return f"${n/1e12:.1f}T"
    if n >= 1e9:
        return f"${n/1e9:.1f}B"
    if n >= 1e6:
        return f"${n/1e6:.0f}M"
    return f"${int(n)}"


def fmt_pct(n: Any, signed: bool = True) -> str:
    try:
        v = float(n)
    except (TypeError, ValueError):
        return "n/a"
    return f"{v:+.1f}%" if signed else f"{v:.1f}%"


def fmt_price(n: Any) -> str:
    try:
        return f"${float(n):.2f}"
    except (TypeError, ValueError):
        return "n/a"


def top_movers_blurb(
    rows: Sequence[Dict[str, Any]],
    n: int = 5,
    sort_by: str = "CHANGE_PCT",
    reverse: bool = True,
) -> str:
    """Build a compact 'top N movers' string for a summary line."""
    def key(r):
        v = field(r, sort_by)
        try:
            return float(v)
        except (TypeError, ValueError):
            return 0.0

    ranked = sorted(rows, key=key, reverse=reverse)[:n]
    parts = []
    for r in ranked:
        sym = field(r, "SYMBOL", "?")
        name = field(r, "NAME", sym)
        chg = field(r, "CHANGE_PCT")
        label = name if isinstance(name, str) and len(name) < 30 else sym
        parts.append(f"{label} ({fmt_pct(chg)})")
    return ", ".join(parts)
