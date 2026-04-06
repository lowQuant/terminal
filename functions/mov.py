"""MOV — Index Movers.

Shows which stocks are driving a selected index up or down, ranked by
their contribution to the index's move. Bloomberg-style ``INDU <INDEX>
MOV <GO>`` equivalent.

Uses the TradingView scanner to fetch constituent data (change%, market
cap, close) for the index's market, then estimates each stock's
contribution as ``change% × market_cap_weight``.

True index-point contributions require the exact index methodology
(divisor, free-float, capping rules) which varies per index and isn't
publicly available. Our market-cap-weighted approximation is close
enough for the top/bottom movers ranking.
"""

import json
import traceback
import urllib.request
from typing import List, Dict, Any

from flask import Blueprint, jsonify, request

from functions._utils import cached
from functions._countries import region_scanner_slugs, yf_suffix_for_name, by_tv_scanner


mov_bp = Blueprint('mov', __name__)


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

# Major indices mapped to their scanner market + a readable label.
# The scanner returns all stocks for that market; we approximate
# the index by taking the top N by market cap (a reasonable proxy
# for index constituents in cap-weighted indices).
INDICES = {
    # US
    'SPX':   {'market': 'america', 'label': 'S&P 500',          'top_n': 500},
    'NDX':   {'market': 'america', 'label': 'NASDAQ 100',       'top_n': 100},
    'DJI':   {'market': 'america', 'label': 'Dow Jones 30',     'top_n': 30},
    # Europe
    'SX5E':  {'market': 'germany', 'label': 'Euro Stoxx 50',    'top_n': 50,  'markets': ['germany', 'france', 'netherlands', 'italy', 'spain']},
    'DAX':   {'market': 'germany', 'label': 'DAX 40',           'top_n': 40},
    'FTSE':  {'market': 'uk',      'label': 'FTSE 100',         'top_n': 100},
    'CAC':   {'market': 'france',  'label': 'CAC 40',           'top_n': 40},
    # Asia
    'NKY':   {'market': 'japan',   'label': 'Nikkei 225',       'top_n': 225},
    'HSI':   {'market': 'hongkong','label': 'Hang Seng',        'top_n': 80},
}

# Scanner column for each time period
PERIOD_COLUMNS = {
    '1D':  'change',
    '1W':  'Perf.W',
    '1M':  'Perf.1M',
    '3M':  'Perf.3M',
    '6M':  'Perf.6M',
    'YTD': 'Perf.YTD',
    '1Y':  'Perf.Y',
}


def _build_columns(period: str) -> List[str]:
    perf_col = PERIOD_COLUMNS.get(period, 'change')
    return [
        'name',                        # 0
        'description',                 # 1
        'close',                       # 2
        perf_col,                      # 3  (% change for selected period)
        'change_abs',                  # 4  (absolute price change — 1D)
        'volume',                      # 5
        'market_cap_basic',            # 6
        'sector',                      # 7
        'country',                     # 8
    ]


def _fetch_index_movers(index_key: str, period: str = '1D') -> List[Dict]:
    cfg = INDICES.get(index_key)
    if not cfg:
        return []

    markets = cfg.get('markets', [cfg['market']])
    top_n = cfg.get('top_n', 100)

    columns = _build_columns(period)

    def _fetch_market(slug):
        body = {
            'filter': [
                {'left': 'type',       'operation': 'equal',    'right': 'stock'},
                {'left': 'subtype',    'operation': 'in_range',
                    'right': ['common', 'foreign-issuer']},
                {'left': 'is_primary', 'operation': 'equal',    'right': True},
                {'left': 'market_cap_basic', 'operation': 'greater', 'right': 50_000_000},
            ],
            'columns': columns,
            'sort':    {'sortBy': 'market_cap_basic', 'sortOrder': 'desc'},
            'range':   [0, top_n if len(markets) == 1 else top_n // len(markets) + 20],
        }
        data = json.dumps(body).encode('utf-8')
        req = urllib.request.Request(
            SCANNER_URL.format(market=slug),
            data=data, headers=_UA, method='POST',
        )
        with urllib.request.urlopen(req, timeout=20) as resp:
            payload = json.loads(resp.read().decode('utf-8'))
        return payload.get('data') or []

    from concurrent.futures import ThreadPoolExecutor

    all_raw = []
    with ThreadPoolExecutor(max_workers=min(8, len(markets))) as ex:
        for rows in ex.map(_fetch_market, markets):
            all_raw.extend(rows)

    # Sort by market cap desc, take top_n
    parsed = []
    for row in all_raw:
        tv_sym = row.get('s') or ''
        d = row.get('d') or []
        if len(d) < 9 or not tv_sym:
            continue
        mcap = d[6] if isinstance(d[6], (int, float)) else 0
        chg = d[3] if isinstance(d[3], (int, float)) else 0
        parsed.append({
            'tv_symbol': tv_sym,
            'd': d,
            'mcap': mcap,
            'change': chg,
        })

    parsed.sort(key=lambda r: -r['mcap'])
    parsed = parsed[:top_n]

    # Compute contribution = change% × weight (market-cap weighted)
    total_mcap = sum(r['mcap'] for r in parsed) or 1
    results = []
    for r in parsed:
        d = r['d']
        tv_name = (d[0] or '').replace('_', '-')
        country_name = d[8] or ''
        suffix = yf_suffix_for_name(country_name)

        weight = r['mcap'] / total_mcap
        contribution = r['change'] * weight  # approx index-point contribution

        results.append({
            'ticker':       f'{tv_name}{suffix}',
            'tv_symbol':    r['tv_symbol'],
            'name':         (d[1] or tv_name).strip(),
            'close':        d[2] if isinstance(d[2], (int, float)) else None,
            'change':       r['change'],
            'change_abs':   d[4] if isinstance(d[4], (int, float)) else None,
            'volume':       d[5] if isinstance(d[5], (int, float)) else None,
            'market_cap':   r['mcap'],
            'sector':       d[7] or '',
            'country':      country_name,
            'weight':       round(weight * 100, 2),        # % of index
            'contribution': round(contribution, 4),         # approx index contribution
        })

    # Sort by absolute contribution desc (biggest movers first)
    results.sort(key=lambda r: -abs(r['contribution']))
    return results


@mov_bp.route('/api/index-movers')
def index_movers():
    """Return index movers for a given index.

    Query params:
      index — SPX | NDX | DJI | SX5E | DAX | FTSE | CAC | NKY | HSI
      sort  — contribution (default) | gainers | losers
    """
    index_key = (request.args.get('index') or 'SPX').upper()
    sort_mode = (request.args.get('sort') or 'contribution').lower()
    period = (request.args.get('period') or '1D').upper()
    if period not in PERIOD_COLUMNS:
        period = '1D'

    if index_key not in INDICES:
        return jsonify({'error': f'Unknown index: {index_key}',
                        'available': list(INDICES.keys())}), 400

    def fetch():
        return _fetch_index_movers(index_key, period=period)

    try:
        data = cached(f'index_movers_{index_key}_{period}', fetch, ttl=120)

        # Apply sort
        if sort_mode == 'gainers':
            data = sorted(data, key=lambda r: -(r.get('contribution') or 0))
        elif sort_mode == 'losers':
            data = sorted(data, key=lambda r: r.get('contribution') or 0)
        # else: default is already by absolute contribution

        return jsonify({
            'rows':   data,
            'source': 'TradingView',
            'index':  index_key,
            'label':  INDICES[index_key]['label'],
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500
