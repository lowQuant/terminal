"""TradingView scanner API client.

Thin wrapper around the publicly-accessible endpoint

    POST https://scanner.tradingview.com/{market}/scan

Used by EVTS to build dynamic earnings calendars. The scanner's
``earnings_release_next_date`` column gives us the next earnings date
directly — no per-ticker yfinance round-trips.

Country → Yahoo suffix mapping is sourced from the canonical registry
in ``functions._countries`` (single source of truth).
"""

import json
import urllib.request
from datetime import datetime, date, timedelta
from typing import List, Dict, Any

from functions._countries import yf_suffix_for_name, by_tv_scanner


SCANNER_URL = 'https://scanner.tradingview.com/{market}/scan'

_UA = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
                  'AppleWebKit/537.36 (KHTML, like Gecko) '
                  'Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Origin': 'https://www.tradingview.com',
    'Referer': 'https://www.tradingview.com/',
}


def _to_yahoo_ticker(tv_name: str, country_name: str, market_slug: str) -> str:
    """Convert a TradingView ticker to a Yahoo Finance ticker.

    - Replaces underscores with hyphens (``SEB_A`` → ``SEB-A``).
    - Looks up the suffix from the country registry.
    """
    base = tv_name.replace('_', '-')
    suffix = yf_suffix_for_name(country_name)
    if not suffix:
        # Fallback: derive from the market slug via the registry
        c = by_tv_scanner(market_slug)
        suffix = c.yf_suffix if c else ''
    return f'{base}{suffix}'


def _post_scanner(market: str, columns: List[str], top_n: int = 10000,
                  timeout: int = 20) -> List[Dict]:
    """Raw POST to the scanner endpoint. Returns the ``data`` array.

    ``top_n`` defaults to 10 000 — effectively "all stocks". The scanner
    returns at most as many as exist for that market; we never want to
    artificially truncate since date-window filtering happens later.
    """
    body = {
        'filter': [
            {'left': 'type',       'operation': 'equal',    'right': 'stock'},
            {'left': 'subtype',    'operation': 'in_range',
                'right': ['common', 'foreign-issuer']},
            {'left': 'is_primary', 'operation': 'equal',    'right': True},
        ],
        'columns': columns,
        'sort':    {'sortBy': 'market_cap_basic', 'sortOrder': 'desc'},
        'range':   [0, top_n],
    }
    data = json.dumps(body).encode('utf-8')
    req = urllib.request.Request(
        SCANNER_URL.format(market=market),
        data=data, headers=_UA, method='POST',
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        payload = json.loads(resp.read().decode('utf-8'))
    return payload.get('data') or []


def fetch_earnings_calendar(
    markets: List[str],
    days: int = 14,
) -> List[Dict[str, Any]]:
    """Fetch upcoming earnings from the TV scanner in a single call per market.

    Returns a list of row dicts compatible with EVTS's frontend shape.
    """
    from concurrent.futures import ThreadPoolExecutor

    columns = [
        'name',                                     # 0 — ticker base
        'description',                              # 1 — company name
        'market_cap_basic',                          # 2
        'earnings_release_next_date',                # 3 — Unix timestamp
        'earnings_per_share_forecast_next_fq',       # 4 — EPS estimate
        'earnings_per_share_basic_ttm',              # 5 — trailing EPS
        'country',                                   # 6
    ]

    today = date.today()
    cutoff = today + timedelta(days=days)

    def _process_market(market_slug):
        try:
            rows = _post_scanner(market_slug, columns)
        except Exception as e:
            print(f'[tv-scanner] {market_slug} failed: {e}')
            return []

        out = []
        for row in rows:
            tv_sym = row.get('s') or ''
            d = row.get('d') or []
            if len(d) < 7 or not tv_sym:
                continue

            raw_date = d[3]
            if not raw_date or not isinstance(raw_date, (int, float)):
                continue
            try:
                ed = datetime.utcfromtimestamp(raw_date).date()
            except (OSError, ValueError, OverflowError):
                continue

            if ed < today or ed > cutoff:
                continue

            tv_name  = d[0] or ''
            country  = d[6] or ''
            yf_ticker = _to_yahoo_ticker(tv_name, country, market_slug)

            out.append({
                'date':          ed.isoformat(),
                'ticker':        yf_ticker,
                'tv_symbol':     tv_sym,
                'name':          (d[1] or tv_name).strip(),
                'eps_estimate':  d[4] if isinstance(d[4], (int, float)) else None,
                'last_year_eps': d[5] if isinstance(d[5], (int, float)) else None,
                'market_cap':    d[2] if isinstance(d[2], (int, float)) else None,
                'num_estimates': None,
                'time':          '',
                'fiscal_quarter': '',
                'country':       country,
            })
        return out

    all_rows: list = []
    with ThreadPoolExecutor(max_workers=min(8, len(markets))) as ex:
        for rows in ex.map(_process_market, markets):
            all_rows.extend(rows)

    all_rows.sort(key=lambda r: (r['date'], -(r.get('market_cap') or 0)))
    return all_rows
