"""WEIF — World Equity Futures.

Snapshot of major global equity index futures (and underlying spot
indices where a liquid Yahoo-listed future is unavailable). Bloomberg's
``WEIF <GO>`` equivalent — a one-screen view of how risk is priced
across regions in the overnight / pre-open session.

Data source: yfinance ``fast_info`` (single round-trip per instrument).
Results are cached for 30 seconds so the page stays cheap while still
feeling live.
"""

from __future__ import annotations

import math
import traceback
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, List

import yfinance as yf
from flask import Blueprint, jsonify, request

from functions._utils import cached


weif_bp = Blueprint('weif', __name__)


# Curated universe of global equity-index futures and benchmark spot
# indices, grouped by region. Order within each region is by relevance
# (most-watched first). Tickers are Yahoo Finance symbols.
GLOBAL_FUTURES: List[Dict[str, str]] = [
    # ── Americas ──
    {'symbol': 'ES=F',     'name': 'S&P 500 E-mini',     'region': 'Americas',     'kind': 'Future', 'currency': 'USD'},
    {'symbol': 'NQ=F',     'name': 'NASDAQ 100 E-mini',  'region': 'Americas',     'kind': 'Future', 'currency': 'USD'},
    {'symbol': 'YM=F',     'name': 'Dow E-mini',          'region': 'Americas',     'kind': 'Future', 'currency': 'USD'},
    {'symbol': 'RTY=F',    'name': 'Russell 2000 E-mini', 'region': 'Americas',     'kind': 'Future', 'currency': 'USD'},
    {'symbol': 'MES=F',    'name': 'Micro S&P 500',       'region': 'Americas',     'kind': 'Future', 'currency': 'USD'},
    {'symbol': '^GSPTSE',  'name': 'S&P/TSX Composite',   'region': 'Americas',     'kind': 'Index',  'currency': 'CAD'},
    {'symbol': '^BVSP',    'name': 'Bovespa',              'region': 'Americas',     'kind': 'Index',  'currency': 'BRL'},
    {'symbol': '^MXX',     'name': 'IPC Mexico',           'region': 'Americas',     'kind': 'Index',  'currency': 'MXN'},

    # ── EMEA ──
    {'symbol': '^STOXX50E','name': 'Euro Stoxx 50',       'region': 'EMEA',         'kind': 'Index',  'currency': 'EUR'},
    {'symbol': '^GDAXI',   'name': 'DAX 40',               'region': 'EMEA',         'kind': 'Index',  'currency': 'EUR'},
    {'symbol': '^FCHI',    'name': 'CAC 40',               'region': 'EMEA',         'kind': 'Index',  'currency': 'EUR'},
    {'symbol': '^FTSE',    'name': 'FTSE 100',             'region': 'EMEA',         'kind': 'Index',  'currency': 'GBP'},
    {'symbol': '^IBEX',    'name': 'IBEX 35',              'region': 'EMEA',         'kind': 'Index',  'currency': 'EUR'},
    {'symbol': '^SSMI',    'name': 'SMI Switzerland',      'region': 'EMEA',         'kind': 'Index',  'currency': 'CHF'},
    {'symbol': 'FTSEMIB.MI','name': 'FTSE MIB',            'region': 'EMEA',         'kind': 'Index',  'currency': 'EUR'},
    {'symbol': '^AEX',     'name': 'AEX Netherlands',      'region': 'EMEA',         'kind': 'Index',  'currency': 'EUR'},
    {'symbol': '^OMX',     'name': 'OMX Stockholm 30',     'region': 'EMEA',         'kind': 'Index',  'currency': 'SEK'},

    # ── Asia / Pacific ──
    {'symbol': '^N225',    'name': 'Nikkei 225',           'region': 'Asia/Pacific', 'kind': 'Index',  'currency': 'JPY'},
    {'symbol': 'NKD=F',    'name': 'Nikkei 225 USD Fut',   'region': 'Asia/Pacific', 'kind': 'Future', 'currency': 'USD'},
    {'symbol': '^HSI',     'name': 'Hang Seng',            'region': 'Asia/Pacific', 'kind': 'Index',  'currency': 'HKD'},
    {'symbol': '000001.SS','name': 'Shanghai Composite',   'region': 'Asia/Pacific', 'kind': 'Index',  'currency': 'CNY'},
    {'symbol': '399001.SZ','name': 'Shenzhen Component',   'region': 'Asia/Pacific', 'kind': 'Index',  'currency': 'CNY'},
    {'symbol': '^STI',     'name': 'Straits Times',         'region': 'Asia/Pacific', 'kind': 'Index',  'currency': 'SGD'},
    {'symbol': '^KS11',    'name': 'KOSPI',                 'region': 'Asia/Pacific', 'kind': 'Index',  'currency': 'KRW'},
    {'symbol': '^TWII',    'name': 'TAIEX Taiwan',          'region': 'Asia/Pacific', 'kind': 'Index',  'currency': 'TWD'},
    {'symbol': '^BSESN',   'name': 'BSE Sensex',            'region': 'Asia/Pacific', 'kind': 'Index',  'currency': 'INR'},
    {'symbol': '^NSEI',    'name': 'Nifty 50',              'region': 'Asia/Pacific', 'kind': 'Index',  'currency': 'INR'},
    {'symbol': '^AXJO',    'name': 'S&P/ASX 200',           'region': 'Asia/Pacific', 'kind': 'Index',  'currency': 'AUD'},
]

REGION_ORDER = ['Americas', 'EMEA', 'Asia/Pacific']


def _safe_float(val: Any) -> float | None:
    if val is None:
        return None
    try:
        f = float(val)
        return None if math.isnan(f) else f
    except (TypeError, ValueError):
        return None


def _safe_int(val: Any) -> int | None:
    if val is None:
        return None
    try:
        return int(float(val))
    except (TypeError, ValueError):
        return None


def _fetch_quote(meta: Dict[str, str]) -> Dict[str, Any]:
    """Fetch a single futures / index quote via yfinance fast_info."""
    out: Dict[str, Any] = dict(meta)
    out.update({
        'last': None, 'prev_close': None, 'change': None,
        'change_pct': None, 'open': None, 'day_high': None,
        'day_low': None, 'volume': None,
    })
    try:
        tkr = yf.Ticker(meta['symbol'])
        info = tkr.fast_info

        last = _safe_float(getattr(info, 'last_price', None))
        prev = _safe_float(getattr(info, 'previous_close', None))
        out['last'] = last
        out['prev_close'] = prev
        if last is not None and prev not in (None, 0):
            change = last - prev
            out['change'] = round(change, 4)
            out['change_pct'] = round((change / prev) * 100, 3)

        out['open']     = _safe_float(getattr(info, 'open', None))
        out['day_high'] = _safe_float(getattr(info, 'day_high', None))
        out['day_low']  = _safe_float(getattr(info, 'day_low', None))
        out['volume']   = _safe_int(getattr(info, 'last_volume', None))
    except Exception as e:
        out['error'] = str(e)
    return out


def _fetch_all() -> List[Dict[str, Any]]:
    with ThreadPoolExecutor(max_workers=min(12, len(GLOBAL_FUTURES))) as ex:
        rows = list(ex.map(_fetch_quote, GLOBAL_FUTURES))

    region_rank = {r: i for i, r in enumerate(REGION_ORDER)}
    rows.sort(key=lambda r: (region_rank.get(r.get('region', ''), 99), 0))
    return rows


@weif_bp.route('/api/weif')
def world_equity_futures():
    """Return a global snapshot of equity index futures + indices.

    Query params:
      region — optional filter: Americas | EMEA | Asia/Pacific
    """
    region = (request.args.get('region') or '').strip()

    try:
        rows = cached('weif_snapshot', _fetch_all, ttl=30)
        if region:
            rows = [r for r in rows if r.get('region', '').lower() == region.lower()]
        return jsonify({
            'rows':    rows,
            'regions': REGION_ORDER,
            'source':  'Yahoo Finance',
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500
