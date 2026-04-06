"""MOV — Top Movers (Gainers, Losers, Most Active, Pre-Market).

Uses the TradingView scanner API to fetch daily movers in a single call
per market. Four views are supported:

    gainers    — sorted by change% descending
    losers     — sorted by change% ascending
    active     — sorted by relative volume descending
    premarket  — sorted by premarket change% (US only)

Each view returns the top N stocks by the relevant metric, filtered to
primary-listed equities with a minimum market cap.
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

# Columns requested per view. Order matters — position maps to d[i].
BASE_COLUMNS = [
    'name',                        # 0
    'description',                 # 1
    'close',                       # 2
    'change',                      # 3  (% change today)
    'volume',                      # 4
    'relative_volume_10d_calc',    # 5
    'market_cap_basic',            # 6
    'sector',                      # 7
    'country',                     # 8
]

PREMARKET_COLUMNS = BASE_COLUMNS + [
    'premarket_change',            # 9   (pre-market % change)
    'premarket_volume',            # 10
    'premarket_gap',               # 11  (gap from prior close %)
    'premarket_close',             # 12
]

# Sort key per view
VIEW_CONFIG = {
    'gainers':   {'sort': 'change',                    'order': 'desc', 'premarket': False},
    'losers':    {'sort': 'change',                    'order': 'asc',  'premarket': False},
    'active':    {'sort': 'relative_volume_10d_calc',  'order': 'desc', 'premarket': False},
    'premarket': {'sort': 'premarket_change',          'order': 'desc', 'premarket': True},
}

MIN_MCAP = 50_000_000  # $50M floor to filter penny stocks


def _fetch_movers(market_slug: str, view: str, limit: int = 100) -> List[Dict]:
    cfg = VIEW_CONFIG.get(view, VIEW_CONFIG['gainers'])
    columns = PREMARKET_COLUMNS if cfg['premarket'] else BASE_COLUMNS

    filters = [
        {'left': 'type',       'operation': 'equal',    'right': 'stock'},
        {'left': 'subtype',    'operation': 'in_range',
            'right': ['common', 'foreign-issuer']},
        {'left': 'is_primary', 'operation': 'equal',    'right': True},
        {'left': 'market_cap_basic', 'operation': 'greater', 'right': MIN_MCAP},
    ]
    # For losers, only show negative change
    if view == 'losers':
        filters.append({'left': 'change', 'operation': 'less', 'right': 0})
    # For gainers, only positive
    elif view == 'gainers':
        filters.append({'left': 'change', 'operation': 'greater', 'right': 0})
    # Premarket: need a value
    elif view == 'premarket':
        filters.append({'left': 'premarket_change', 'operation': 'nempty'})

    body = {
        'filter':  filters,
        'columns': columns,
        'sort':    {'sortBy': cfg['sort'], 'sortOrder': cfg['order']},
        'range':   [0, limit],
    }

    data = json.dumps(body).encode('utf-8')
    req = urllib.request.Request(
        SCANNER_URL.format(market=market_slug),
        data=data, headers=_UA, method='POST',
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        payload = json.loads(resp.read().decode('utf-8'))

    rows = payload.get('data') or []
    out = []
    for row in rows:
        tv_sym = row.get('s') or ''
        d = row.get('d') or []
        if len(d) < 9 or not tv_sym:
            continue

        tv_name = (d[0] or '').replace('_', '-')
        country_name = d[8] or ''
        suffix = yf_suffix_for_name(country_name)
        if not suffix:
            c = by_tv_scanner(market_slug)
            suffix = c.yf_suffix if c else ''

        entry = {
            'ticker':        f'{tv_name}{suffix}',
            'tv_symbol':     tv_sym,
            'name':          (d[1] or tv_name).strip(),
            'close':         d[2] if isinstance(d[2], (int, float)) else None,
            'change':        d[3] if isinstance(d[3], (int, float)) else None,
            'volume':        d[4] if isinstance(d[4], (int, float)) else None,
            'rel_volume':    d[5] if isinstance(d[5], (int, float)) else None,
            'market_cap':    d[6] if isinstance(d[6], (int, float)) else None,
            'sector':        d[7] or '',
            'country':       country_name,
        }

        # Pre-market fields (only present in premarket view)
        if cfg['premarket'] and len(d) > 12:
            entry['premarket_change'] = d[9] if isinstance(d[9], (int, float)) else None
            entry['premarket_volume'] = d[10] if isinstance(d[10], (int, float)) else None
            entry['premarket_gap']    = d[11] if isinstance(d[11], (int, float)) else None
            entry['premarket_close']  = d[12] if isinstance(d[12], (int, float)) else None

        out.append(entry)
    return out


def _fetch_region_movers(country_code: str, view: str, limit: int) -> List[Dict]:
    """Fetch movers for a region (may span multiple scanner slugs)."""
    from concurrent.futures import ThreadPoolExecutor

    slugs = region_scanner_slugs(country_code)
    if not slugs:
        return []

    def _safe(slug):
        try:
            return _fetch_movers(slug, view, limit=limit)
        except Exception as e:
            print(f'[mov] {slug}/{view} failed: {e}')
            return []

    all_rows = []
    with ThreadPoolExecutor(max_workers=min(8, len(slugs))) as ex:
        for rows in ex.map(_safe, slugs):
            all_rows.extend(rows)

    # Re-sort the merged results by the view's sort key
    cfg = VIEW_CONFIG.get(view, VIEW_CONFIG['gainers'])
    sort_key = cfg['sort']
    reverse = cfg['order'] == 'desc'
    all_rows.sort(key=lambda r: r.get(sort_key) or 0, reverse=reverse)
    return all_rows[:limit]


@mov_bp.route('/api/movers')
def movers():
    """Return top movers for a region/view.

    Query params:
      country — US | EU | JP | HK | DE | GB | … (default US)
      view    — gainers | losers | active | premarket (default gainers)
      limit   — max results (1-200, default 50)
    """
    country = (request.args.get('country') or 'US').upper()
    view = (request.args.get('view') or 'gainers').lower()
    try:
        limit = int(request.args.get('limit', 50))
    except ValueError:
        limit = 50
    limit = max(1, min(limit, 200))

    if view not in VIEW_CONFIG:
        return jsonify({'error': f'Unknown view: {view}'}), 400

    # Pre-market is US-only
    if view == 'premarket' and country != 'US':
        return jsonify({
            'rows': [], 'source': 'TradingView', 'country': country,
            'view': view, 'note': 'Pre-market data is US-only',
        })

    def fetch():
        return _fetch_region_movers(country, view, limit)

    try:
        data = cached(f'movers_{country}_{view}_{limit}', fetch, ttl=120)  # 2-min cache
        return jsonify({
            'rows':    data,
            'source':  'TradingView',
            'country': country,
            'view':    view,
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500
