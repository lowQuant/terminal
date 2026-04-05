"""TradingView scanner API client.

Thin wrapper around the undocumented-but-publicly-accessible endpoint

    https://scanner.tradingview.com/{market}/scan   (POST, JSON body)

It powers TradingView's own country stock screeners on the web. We use
it in two ways:

1. **Universe selection** — fetch the top-N primary-listed stocks per
   country sorted by market cap, so EVTS doesn't need hand-maintained
   ticker lists. This is the main use case.

2. **Earnings metadata** — the scanner exposes ``earnings_release_next_date``
   and ``earnings_per_share_forecast_next_fq`` columns (when available),
   which we surface alongside the ticker so EVTS can enrich its rows
   without a per-ticker yfinance round-trip.

The response shape is consistent across markets::

    {
      "totalCount": 1234,
      "data": [
        {"s": "NASDAQ:AAPL", "d": [...column values...]},
        ...
      ]
    }

Each column's position in ``d`` matches its position in the request's
``columns`` array.

Network failures raise — callers should handle + fall back gracefully.
"""

import json
import urllib.request
from typing import List, Dict, Any, Optional


SCANNER_URL = 'https://scanner.tradingview.com/{market}/scan'

# User agent required by TradingView's edge — bare urllib UA is blocked.
_UA = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
                  'AppleWebKit/537.36 (KHTML, like Gecko) '
                  'Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Origin': 'https://www.tradingview.com',
    'Referer': 'https://www.tradingview.com/',
}


# ── Market slug → default yfinance ticker suffix ─────────────────────
# Each TradingView scanner country returns primary-listed stocks on
# that market's main exchange. Appending the matching yfinance suffix
# converts a scanner ticker (e.g. ``ASML``) into a Yahoo ticker
# (``ASML.AS``) usable by ``yfinance.Ticker.calendar``.
#
# Some markets host multiple exchanges (china → SSE/SZSE, india → NSE/BSE).
# For those the suffix is the dominant exchange; edge cases get resolved
# from the TV symbol's prefix in ``_yahoo_ticker_from_row``.
COUNTRY_YF_SUFFIX = {
    'america':      '',        # NASDAQ / NYSE / AMEX — no suffix
    'canada':       '.TO',     # TSX (also .V for TSX Venture)
    'mexico':       '.MX',
    'brazil':       '.SA',
    'uk':           '.L',      # LSE
    'germany':      '.DE',     # Xetra
    'france':       '.PA',     # Euronext Paris
    'netherlands':  '.AS',     # Euronext Amsterdam
    'belgium':      '.BR',     # Euronext Brussels
    'portugal':     '.LS',     # Euronext Lisbon
    'italy':        '.MI',     # Borsa Italiana
    'spain':        '.MC',     # BME
    'switzerland':  '.SW',     # SIX
    'austria':      '.VI',     # Wiener Börse
    'ireland':      '.IR',
    'denmark':      '.CO',     # NASDAQ Copenhagen
    'sweden':       '.ST',     # NASDAQ Stockholm
    'finland':      '.HE',     # NASDAQ Helsinki
    'norway':       '.OL',     # Oslo Børs
    'japan':        '.T',      # TSE
    'hongkong':     '.HK',     # HKEX
    'china':        '.SS',     # SSE (.SZ for Shenzhen — resolved per row)
    'taiwan':       '.TW',
    'korea':        '.KS',     # KOSPI (.KQ for KOSDAQ)
    'india':        '.NS',     # NSE (.BO for BSE)
    'australia':    '.AX',
    'new-zealand':  '.NZ',
    'singapore':    '.SI',
    'israel':       '.TA',
    'south-africa': '.JO',
    'turkey':       '.IS',
}


# TradingView exchange prefix → yfinance suffix override. Used when the
# scanner row's TV symbol prefix disambiguates the country's default
# (e.g. China's SSE vs SZSE, Korea's KOSPI vs KOSDAQ).
TV_EXCHANGE_YF_OVERRIDE = {
    'SZSE':   '.SZ',
    'HKEX':   '.HK',
    'TSXV':   '.V',
    'KOSDAQ': '.KQ',
    'BSE':    '.BO',
}


def _yahoo_ticker_from_row(tv_symbol: str, country_slug: str) -> str:
    """Convert a TradingView scanner symbol to a Yahoo Finance ticker."""
    # tv_symbol looks like "NASDAQ:AAPL" or "EURONEXT:ASML"
    if ':' in tv_symbol:
        prefix, base = tv_symbol.split(':', 1)
    else:
        prefix, base = '', tv_symbol

    suffix = TV_EXCHANGE_YF_OVERRIDE.get(prefix, COUNTRY_YF_SUFFIX.get(country_slug, ''))
    return f'{base}{suffix}'


def fetch_country_universe(
    country: str,
    top_n: int = 200,
    columns: Optional[List[str]] = None,
    timeout: int = 15,
) -> List[Dict[str, Any]]:
    """Fetch the top-N primary-listed stocks for a scanner country.

    Args:
        country:  scanner slug (e.g. ``'netherlands'``, ``'japan'``)
        top_n:    max results to return (sorted by market cap desc)
        columns:  extra columns to request. ``name``, ``description`` and
                  ``market_cap_basic`` are always included.
        timeout:  HTTP timeout in seconds

    Returns:
        List of dicts: ``{yahoo_ticker, tv_symbol, name, market_cap, extras}``
        where ``extras`` maps the requested extra column names to values.
    """
    base_cols = ['name', 'description', 'market_cap_basic']
    extra_cols = [c for c in (columns or []) if c not in base_cols]
    all_cols = base_cols + extra_cols

    body = {
        'filter': [
            {'left': 'type',       'operation': 'equal',  'right': 'stock'},
            {'left': 'subtype',    'operation': 'in_range',
                'right': ['common', 'foreign-issuer']},
            {'left': 'is_primary', 'operation': 'equal',  'right': True},
        ],
        'columns': all_cols,
        'sort':    {'sortBy': 'market_cap_basic', 'sortOrder': 'desc'},
        'range':   [0, max(1, min(top_n, 500))],
    }

    data = json.dumps(body).encode('utf-8')
    req = urllib.request.Request(
        SCANNER_URL.format(market=country),
        data=data,
        headers=_UA,
        method='POST',
    )

    with urllib.request.urlopen(req, timeout=timeout) as resp:
        payload = json.loads(resp.read().decode('utf-8'))

    rows = payload.get('data') or []
    out = []
    for row in rows:
        tv_symbol = row.get('s') or ''
        d = row.get('d') or []
        if not tv_symbol or len(d) < 3:
            continue

        name        = d[0] or ''
        description = d[1] or name
        market_cap  = d[2]

        extras = {col: d[3 + i] if 3 + i < len(d) else None
                  for i, col in enumerate(extra_cols)}

        out.append({
            'yahoo_ticker': _yahoo_ticker_from_row(tv_symbol, country),
            'tv_symbol':    tv_symbol,
            'name':         description,
            'market_cap':   market_cap,
            'extras':       extras,
        })
    return out


def fetch_aggregated_universe(
    countries: List[str],
    per_country: int = 60,
    total_cap: int = 250,
    columns: Optional[List[str]] = None,
) -> List[Dict[str, Any]]:
    """Fetch several countries' universes and merge, sorted by market cap.

    Used for multi-country regions like ``EU`` that span many scanner
    slugs (germany, france, netherlands, italy, spain, switzerland, …).
    """
    from concurrent.futures import ThreadPoolExecutor

    def _safe(c):
        try:
            return fetch_country_universe(c, top_n=per_country, columns=columns)
        except Exception as e:
            print(f'[tv-scanner] {c} failed: {e}')
            return []

    merged: List[Dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=min(8, len(countries))) as ex:
        for rows in ex.map(_safe, countries):
            merged.extend(rows)

    merged.sort(key=lambda r: -(r.get('market_cap') or 0))
    return merged[:total_cap]
