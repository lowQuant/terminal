"""IBKR — Interactive Brokers portfolio via Flex Web Service.

Read-only bridge between the terminal and Interactive Brokers' Flex Web
Service — the same XML-over-HTTPS API that Sharesight, Kubera, Empower
and every other serious aggregator uses for IBKR. No TWS / IB Gateway
needed, no trading permissions, no local software: the user generates
a Flex Query + token in Account Management → Settings → Account
Reporting → Flex Web Service, pastes them into terminal Settings, and
we fetch positions / cash / NAV over plain HTTPS.

Why Flex (and not TWS API or Client Portal API)?

    • Works on PythonAnywhere with zero extra setup — it's HTTPS. The
      TWS API needs a running gateway on a reachable host, and CP Web
      API needs a per-user Java gateway with daily 2FA re-auth.
    • The Flex token is read-only *by design* — IBKR's own permission
      model scopes it to report generation. It cannot place, modify,
      or cancel orders; cannot transfer funds; cannot change account
      settings. Revocable in one click.
    • Works for every IBKR customer (retail + institutional), not just
      OAuth-registered third-party apps.

Security model (inherits the existing llm_keys pattern):

    • The Flex token is stored in ``profiles.broker_config.ibkr.flex``
      (Supabase JSONB, RLS-scoped so only the owning user can read it).
    • The browser reads it via RLS, passes it in the request body to
      /api/ibkr/flex/snapshot. The backend never persists the token
      and never logs it.
    • The cache key is a SHA-256 prefix of the token + query_id, never
      the raw value, so in-memory cache inspection cannot leak it.

Flex Web Service flow (two-step, documented at
``https://www.interactivebrokers.com/en/software/am/am/reports/
flex_web_service_version_3.htm``):

    1. SendRequest → returns a ReferenceCode once IBKR has accepted
       the job.
    2. GetStatement(ReferenceCode) → returns the XML statement once it
       has been generated server-side. Polled every ``POLL_INTERVAL``
       seconds up to ``POLL_TIMEOUT`` total; status "Warn" code 1019
       means "still working, try again".

Endpoint::

    POST /api/ibkr/flex/snapshot
        body: { "token": "...", "query_id": "123456" }
        -> {
             "account":   {"id": "U1234567", "fromDate": "...", "toDate": "..."},
             "positions": [{"symbol": ..., "qty": ..., ...}, ...],
             "cash":      [{"currency": "USD", "endingCash": ..., ...}, ...],
             "nav":       [{"reportDate": "...", "total": ...}, ...],
             "asOf":      "2025-04-19 16:30 (EOD)"
           }

The response is deliberately section-indifferent: if the user's Flex
Query doesn't include, say, ``CashReport``, ``cash`` is simply ``[]``
and the widget hides the cash tab. That way a single endpoint serves
any Flex Query shape the user configures.
"""

from __future__ import annotations

import hashlib
import time
import traceback
import xml.etree.ElementTree as ET
from typing import Any, Dict, List, Optional

import requests
from flask import Blueprint, jsonify, request

from functions._utils import cached


ibkr_bp = Blueprint("ibkr", __name__)


# ── Flex Web Service configuration ────────────────────────────────

FLEX_BASE = "https://gdcdyn.interactivebrokers.com/Universal/servlet"
FLEX_SEND_URL = f"{FLEX_BASE}/FlexStatementService.SendRequest"
FLEX_GET_URL = f"{FLEX_BASE}/FlexStatementService.GetStatement"
FLEX_VERSION = "3"

# Max time we'll wait for IBKR to assemble a statement. Most queries
# finish in 5-15s; the server-side generator occasionally takes longer
# for accounts with many instruments. 60s is the hard cap — beyond
# that we bail and surface a retry-able error to the UI.
POLL_INTERVAL = 2.0
POLL_TIMEOUT = 60.0

# Cache successful snapshots for 15 min. Flex data is EOD; there's no
# point re-fetching every time the user switches tabs. The cache key
# is derived from a hash of token+query so the raw token never appears
# in the cache key space.
SNAPSHOT_CACHE_TTL = 15 * 60

# A browser-like UA avoids occasional WAF blocks from IBKR's edge.
_UA = (
    "Mozilla/5.0 (compatible; TerminalApp/1.0; "
    "+https://www.lange-invest.com)"
)


# ── Token-safe cache key ──────────────────────────────────────────

def _cache_key(token: str, query_id: str) -> str:
    """Return a cache key that doesn't embed the raw token.

    We hash token+query together so two users on the same query id with
    different tokens get separate cache entries, but neither the token
    nor even a hash of it alone appears in the process memory outside
    this helper.
    """
    digest = hashlib.sha256(
        f"{token}::{query_id}".encode("utf-8")
    ).hexdigest()
    return f"ibkr_flex_{digest[:16]}"


# ── Low-level Flex Web Service client ─────────────────────────────

class FlexError(Exception):
    """Raised for any Flex Web Service failure with a user-safe message."""


def _parse_flex_status(xml_text: str) -> Dict[str, str]:
    """Parse a FlexStatementResponse envelope (SendRequest / early GetStatement).

    Returns dict with ``status`` / ``code`` / ``message`` / ``reference`` keys.
    Unparseable responses raise FlexError.
    """
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as e:
        raise FlexError(f"Could not parse Flex response: {e}") from e

    def txt(tag: str) -> str:
        el = root.find(tag)
        return (el.text or "").strip() if el is not None and el.text else ""

    return {
        "status": txt("Status"),
        "code": txt("ErrorCode"),
        "message": txt("ErrorMessage"),
        "reference": txt("ReferenceCode"),
    }


def _flex_send_request(token: str, query_id: str) -> str:
    """Step 1 — ask IBKR to start generating the statement.

    Returns the ReferenceCode that Step 2 polls for.
    """
    resp = requests.get(
        FLEX_SEND_URL,
        params={"t": token, "q": query_id, "v": FLEX_VERSION},
        headers={"User-Agent": _UA, "Accept": "application/xml"},
        timeout=20,
    )
    if resp.status_code != 200:
        raise FlexError(
            f"IBKR Flex rejected the request ({resp.status_code}). "
            "Check that your token and Query ID are correct."
        )

    parsed = _parse_flex_status(resp.text)
    if parsed["status"] != "Success" or not parsed["reference"]:
        # Translate the most common IBKR error codes to clearer messages.
        # Full list: https://www.interactivebrokers.com/en/software/am/am/reports/flex_web_service_error_codes.htm
        msg_map = {
            "1003": "Statement is not yet available — try again in a moment.",
            "1004": "Invalid request format.",
            "1005": "Invalid Flex token — regenerate it in Account Management.",
            "1006": "Invalid Query ID — check the ID in your Flex Queries list.",
            "1007": "Invalid Flex Query — edit and save the query again.",
            "1008": "Flex service is undergoing maintenance.",
            "1010": "Flex Web Service is not enabled on your IBKR account.",
            "1012": "Flex token has expired — regenerate it in Account Management.",
            "1018": "Too many requests — IBKR is throttling; wait a minute and retry.",
            "1020": "Invalid statement format version.",
            "1021": "Subscription required for this report.",
        }
        friendly = msg_map.get(parsed["code"], parsed["message"] or "Unknown IBKR error")
        raise FlexError(f"IBKR Flex error {parsed['code']}: {friendly}")

    return parsed["reference"]


def _flex_get_statement(token: str, reference: str) -> str:
    """Step 2 — poll IBKR for the assembled statement XML.

    Returns the raw XML of a FlexQueryResponse on success. On
    persistent "statement in progress" (code 1019), times out after
    POLL_TIMEOUT and raises FlexError.
    """
    deadline = time.time() + POLL_TIMEOUT

    while True:
        resp = requests.get(
            FLEX_GET_URL,
            params={"t": token, "q": reference, "v": FLEX_VERSION},
            headers={"User-Agent": _UA, "Accept": "application/xml"},
            timeout=30,
        )
        if resp.status_code != 200:
            raise FlexError(f"IBKR Flex returned HTTP {resp.status_code} on GetStatement.")

        xml_text = resp.text
        # A successful statement is <FlexQueryResponse ...>. An in-progress
        # or errored poll is <FlexStatementResponse ...> with a Status code.
        if xml_text.lstrip().startswith("<FlexQueryResponse"):
            return xml_text

        parsed = _parse_flex_status(xml_text)
        if parsed["status"] == "Warn" and parsed["code"] == "1019":
            # Still generating — wait and retry.
            if time.time() > deadline:
                raise FlexError(
                    "IBKR took too long to generate the statement. "
                    "Try again in a moment; large accounts may exceed 60s."
                )
            time.sleep(POLL_INTERVAL)
            continue

        raise FlexError(
            f"IBKR Flex error {parsed['code']}: "
            f"{parsed['message'] or 'Could not retrieve statement'}"
        )


# ── XML → JSON statement parsers ──────────────────────────────────

def _as_float(s: Optional[str]) -> Optional[float]:
    if s is None or s == "":
        return None
    try:
        return float(s)
    except ValueError:
        return None


def _parse_statement(xml_text: str) -> Dict[str, Any]:
    """Extract positions / cash / NAV from a FlexQueryResponse document.

    The parser is defensive: it looks up known tag names but never
    fails if a section is missing — the user's Flex Query configures
    what sections to include. Unknown attributes are ignored.
    """
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as e:
        raise FlexError(f"Could not parse Flex statement XML: {e}") from e

    # <FlexQueryResponse><FlexStatements><FlexStatement ...>
    flex_statement = root.find(".//FlexStatement")
    account: Dict[str, Any] = {}
    if flex_statement is not None:
        account = {
            "id": flex_statement.get("accountId", ""),
            "fromDate": flex_statement.get("fromDate", ""),
            "toDate": flex_statement.get("toDate", ""),
            "period": flex_statement.get("period", ""),
        }

    positions = _parse_positions(root)
    cash = _parse_cash(root)
    nav = _parse_nav(root)

    # Base currency lives on EquitySummaryByReportDateInBase rows. The
    # frontend uses it to format every monetary column; without it, the
    # PORT view falls back to USD which silently mis-labels EUR / GBP /
    # CHF accounts. Fall back to USD only when NAV is genuinely empty.
    base_ccy = "USD"
    for row in nav:
        ccy = (row.get("currency") or "").strip()
        if ccy and ccy != "BASE":
            base_ccy = ccy
            break
    account["baseCurrency"] = base_ccy

    return {"account": account, "positions": positions, "cash": cash, "nav": nav}


# Columns that land in the ``positions`` table on the frontend. Keep
# this list aligned with render logic in app.js (renderPortfolio()).
# The order here is also the preferred-column order for the widget.
#
# Currency note: ``positionValue``, ``costBasisMoney`` and
# ``fifoPnlUnrealized`` come from IBKR in the *position's* local
# currency. IBKR provides ``positionValueInBase`` natively but no
# matching ``costBasisMoneyInBase`` / ``fifoPnlUnrealizedInBase``, so
# we use ``fxRateToBase`` (also on every OpenPosition row) to convert
# cost basis and P&L ourselves below. Without this, multi-currency
# accounts see mixed-currency totals and per-position weights that
# don't sum to 100%.
POSITION_FIELDS = [
    ("symbol", "symbol"),
    ("description", "description"),
    ("assetCategory", "assetCategory"),
    ("currency", "currency"),
    ("listingExchange", "exchange"),
    ("position", "qty"),
    ("markPrice", "mark"),
    ("positionValue", "value"),
    ("positionValueInBase", "valueInBase"),
    ("fxRateToBase", "fxRateToBase"),
    ("costBasisPrice", "costPrice"),
    ("costBasisMoney", "costBasis"),
    ("fifoPnlUnrealized", "unrealizedPnl"),
    ("percentOfNAV", "pctOfNav"),
]

_FLOAT_POSITION_ATTRS = {
    "position", "markPrice", "positionValue", "positionValueInBase",
    "fxRateToBase", "costBasisPrice", "costBasisMoney",
    "fifoPnlUnrealized", "percentOfNAV",
}


def _parse_positions(root: ET.Element) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    for pos in root.iter("OpenPosition"):
        row: Dict[str, Any] = {}
        for flex_key, out_key in POSITION_FIELDS:
            val = pos.get(flex_key)
            if val is None:
                continue
            if flex_key in _FLOAT_POSITION_ATTRS:
                row[out_key] = _as_float(val)
            else:
                row[out_key] = val
        if not row:
            continue

        # Derive base-currency value / cost basis / P&L. Prefer IBKR's
        # native InBase field where present (positionValueInBase); fall
        # back to local × fxRateToBase. fxRateToBase missing → assume
        # the position is already in base, matching IBKR's behaviour
        # for single-currency accounts.
        fx = row.get("fxRateToBase")
        if fx is None or fx == 0:
            fx = 1.0
        if row.get("valueInBase") is None and row.get("value") is not None:
            row["valueInBase"] = row["value"] * fx
        if row.get("costBasis") is not None:
            row["costBasisInBase"] = row["costBasis"] * fx
        if row.get("unrealizedPnl") is not None:
            row["unrealizedPnlInBase"] = row["unrealizedPnl"] * fx

        rows.append(row)
    # Largest positions first so the top of the table is the user's
    # biggest exposures. Sort by base-currency value so EUR + USD
    # positions order correctly.
    rows.sort(
        key=lambda r: abs(r.get("valueInBase") or r.get("value") or 0),
        reverse=True,
    )
    return rows


def _parse_cash(root: ET.Element) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    seen = set()  # dedupe if both summary + per-currency rows are present

    for tag in ("CashReportCurrency", "CashReportRow"):
        for el in root.iter(tag):
            ccy = el.get("currency", "")
            # Flex emits a "BASE_SUMMARY" synthetic row that aggregates
            # all currencies into the base — useful for a single "total
            # cash" number, kept alongside the per-currency rows.
            ending = _as_float(el.get("endingCash"))
            if ending is None:
                continue
            key = (ccy, ending)
            if key in seen:
                continue
            seen.add(key)
            rows.append({
                "currency": ccy,
                "endingCash": ending,
                "startingCash": _as_float(el.get("startingCash")),
                "endingSettledCash": _as_float(el.get("endingSettledCash")),
            })

    # Put BASE_SUMMARY first so the top row is the user's consolidated
    # cash in base currency; then the rest sorted by magnitude.
    def sort_key(r: Dict[str, Any]):
        is_base = r.get("currency") == "BASE_SUMMARY"
        mag = abs(r.get("endingCash") or 0)
        return (0 if is_base else 1, -mag)

    rows.sort(key=sort_key)
    return rows


def _parse_nav(root: ET.Element) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    for tag in ("EquitySummaryByReportDateInBase", "EquitySummaryInBase"):
        for el in root.iter(tag):
            total = _as_float(el.get("total"))
            if total is None:
                continue
            rows.append({
                "reportDate": el.get("reportDate") or el.get("fromDate") or "",
                "currency": el.get("currency", "BASE"),
                "cash": _as_float(el.get("cash")),
                "stock": _as_float(el.get("stock")),
                "options": _as_float(el.get("options")),
                "bonds": _as_float(el.get("bond")),
                "funds": _as_float(el.get("fund")),
                "total": total,
            })
    # Chronological; oldest → newest so line charts render left→right
    rows.sort(key=lambda r: r.get("reportDate") or "")
    return rows


# ── Public helper for other modules (workflow tools) ──────────────

def fetch_flex_snapshot(token: str, query_id: str) -> Dict[str, Any]:
    """Fetch + parse a Flex snapshot, cached by (token, query_id).

    Raises FlexError on any IBKR-side failure with a user-safe message.
    The raw token is never stored in the cache key; we hash it first.
    """
    if not token or not query_id:
        raise FlexError("Both token and Query ID are required.")

    def _fetch() -> Dict[str, Any]:
        reference = _flex_send_request(token, query_id)
        xml_text = _flex_get_statement(token, reference)
        parsed = _parse_statement(xml_text)
        parsed["asOf"] = time.strftime("%Y-%m-%d %H:%M UTC (EOD)", time.gmtime())
        return parsed

    return cached(_cache_key(token, query_id), _fetch, ttl=SNAPSHOT_CACHE_TTL)


# ── Flask endpoint ────────────────────────────────────────────────

@ibkr_bp.route("/api/ibkr/flex/snapshot", methods=["POST"])
def api_flex_snapshot():
    """Fetch an IBKR Flex statement and return parsed positions / cash / NAV.

    Body (JSON)::

        { "token": "<FlexToken>", "query_id": "<QueryId>" }

    We require POST (not GET) so the token never lands in URL query
    strings — those can end up in access logs, browser history, and
    HTTP Referer headers.
    """
    body = request.get_json(silent=True) or {}
    token = (body.get("token") or "").strip()
    query_id = (body.get("query_id") or "").strip()

    if not token or not query_id:
        return jsonify({
            "error": "Both 'token' and 'query_id' are required.",
        }), 400

    try:
        data = fetch_flex_snapshot(token, query_id)
        return jsonify(data)
    except FlexError as e:
        # FlexError messages are already user-safe; surface them verbatim.
        return jsonify({"error": str(e)}), 502
    except requests.RequestException as e:
        # Don't let the raw exception leak URL+params (which may include
        # the token if requests appends them to the error message).
        return jsonify({
            "error": f"Network error reaching IBKR Flex ({type(e).__name__}). Retry in a moment.",
        }), 502
    except Exception as e:  # noqa: BLE001
        traceback.print_exc()
        return jsonify({"error": f"Unexpected error: {type(e).__name__}"}), 500
