"""EQS — Equity Screener.

Custom screener built on TradingView's scanner API. Exposes:

    GET  /api/eqs/fields   — field catalog grouped by category
    POST /api/eqs/scan     — generic scan: accepts columns, filters, sort, market
    GET  /api/eqs/markets  — available markets

The field catalog powers the frontend's filter builder and column
picker. Presets (Overview, Performance, Valuation, …) are defined
here and served to the frontend so both sides stay in sync.
"""

import json
import traceback
import urllib.request

from flask import Blueprint, jsonify, request

from functions._utils import cached
from functions._countries import all_with_scanner, yf_suffix_for_name, by_tv_scanner


eqs_bp = Blueprint('eqs', __name__)


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


# ═════════════════════════════════════════
# Field catalog — grouped by category
# ═════════════════════════════════════════
# Each field: {key, label, type, category}
# type: 'number' | 'percent' | 'price' | 'text' | 'date'

FIELD_CATALOG = [
    # ── Price & Volume ──
    {'key': 'close',                          'label': 'Price',                  'type': 'price',   'category': 'Price & Volume'},
    {'key': 'change',                         'label': 'Change %',               'type': 'percent', 'category': 'Price & Volume'},
    {'key': 'change_abs',                     'label': 'Change (abs)',           'type': 'price',   'category': 'Price & Volume'},
    {'key': 'volume',                         'label': 'Volume',                 'type': 'number',  'category': 'Price & Volume'},
    {'key': 'relative_volume_10d_calc',       'label': 'Relative Volume (10D)',  'type': 'number',  'category': 'Price & Volume'},
    {'key': 'average_volume_10d_calc',        'label': 'Avg Volume (10D)',       'type': 'number',  'category': 'Price & Volume'},
    {'key': 'average_volume_30d_calc',        'label': 'Avg Volume (30D)',       'type': 'number',  'category': 'Price & Volume'},
    {'key': 'open',                           'label': 'Open',                   'type': 'price',   'category': 'Price & Volume'},
    {'key': 'high',                           'label': 'High',                   'type': 'price',   'category': 'Price & Volume'},
    {'key': 'low',                            'label': 'Low',                    'type': 'price',   'category': 'Price & Volume'},
    {'key': 'VWAP',                           'label': 'VWAP',                   'type': 'price',   'category': 'Price & Volume'},
    {'key': 'High.All',                       'label': '52W High',               'type': 'price',   'category': 'Price & Volume'},
    {'key': 'Low.All',                        'label': '52W Low',                'type': 'price',   'category': 'Price & Volume'},
    {'key': 'price_52_week_high',             'label': '52W High Price',         'type': 'price',   'category': 'Price & Volume'},
    {'key': 'price_52_week_low',              'label': '52W Low Price',          'type': 'price',   'category': 'Price & Volume'},
    {'key': 'gap',                            'label': 'Gap %',                  'type': 'percent', 'category': 'Price & Volume'},

    # ── Performance ──
    {'key': 'Perf.W',                         'label': '1 Week',                'type': 'percent', 'category': 'Performance'},
    {'key': 'Perf.1M',                        'label': '1 Month',               'type': 'percent', 'category': 'Performance'},
    {'key': 'Perf.3M',                        'label': '3 Months',              'type': 'percent', 'category': 'Performance'},
    {'key': 'Perf.6M',                        'label': '6 Months',              'type': 'percent', 'category': 'Performance'},
    {'key': 'Perf.Y',                         'label': '1 Year',                'type': 'percent', 'category': 'Performance'},
    {'key': 'Perf.YTD',                       'label': 'YTD',                   'type': 'percent', 'category': 'Performance'},
    {'key': 'Perf.5Y',                        'label': '5 Years',               'type': 'percent', 'category': 'Performance'},

    # ── Valuation ──
    {'key': 'market_cap_basic',               'label': 'Market Cap',             'type': 'number',  'category': 'Valuation'},
    {'key': 'price_earnings_ttm',             'label': 'P/E (TTM)',              'type': 'number',  'category': 'Valuation'},
    {'key': 'price_earnings_growth_ttm',      'label': 'PEG',                    'type': 'number',  'category': 'Valuation'},
    {'key': 'price_book_ratio',               'label': 'P/B',                    'type': 'number',  'category': 'Valuation'},
    {'key': 'price_sales_ratio',              'label': 'P/S',                    'type': 'number',  'category': 'Valuation'},
    {'key': 'price_free_cash_flow_ttm',       'label': 'P/FCF',                  'type': 'number',  'category': 'Valuation'},
    {'key': 'enterprise_value_ebitda_ttm',    'label': 'EV/EBITDA',              'type': 'number',  'category': 'Valuation'},
    {'key': 'enterprise_value_to_revenue_ttm','label': 'EV/Revenue',             'type': 'number',  'category': 'Valuation'},

    # ── Dividends ──
    {'key': 'dividend_yield_recent',          'label': 'Dividend Yield %',       'type': 'percent', 'category': 'Dividends'},
    {'key': 'dividends_per_share_fq',         'label': 'DPS (FQ)',               'type': 'price',   'category': 'Dividends'},
    {'key': 'dps_common_stock_prim_issue_fy', 'label': 'DPS (FY)',               'type': 'price',   'category': 'Dividends'},
    {'key': 'dividend_payout_ratio_ttm',      'label': 'Payout Ratio',           'type': 'percent', 'category': 'Dividends'},

    # ── Income ──
    {'key': 'earnings_per_share_diluted_ttm', 'label': 'EPS (diluted TTM)',      'type': 'price',   'category': 'Income'},
    {'key': 'earnings_per_share_diluted_yoy_growth_ttm', 'label': 'EPS Growth (YoY)', 'type': 'percent', 'category': 'Income'},
    {'key': 'revenue_per_share_ttm',          'label': 'Rev/Share (TTM)',        'type': 'price',   'category': 'Income'},
    {'key': 'total_revenue_ttm',              'label': 'Revenue (TTM)',          'type': 'number',  'category': 'Income'},
    {'key': 'net_income_ttm',                 'label': 'Net Income (TTM)',       'type': 'number',  'category': 'Income'},
    {'key': 'return_on_equity',               'label': 'ROE',                    'type': 'percent', 'category': 'Income'},
    {'key': 'return_on_assets',               'label': 'ROA',                    'type': 'percent', 'category': 'Income'},
    {'key': 'return_on_invested_capital',     'label': 'ROIC',                   'type': 'percent', 'category': 'Income'},

    # ── Margins ──
    {'key': 'gross_margin',                   'label': 'Gross Margin',           'type': 'percent', 'category': 'Margins'},
    {'key': 'operating_margin',               'label': 'Operating Margin',       'type': 'percent', 'category': 'Margins'},
    {'key': 'net_margin',                     'label': 'Net Margin',             'type': 'percent', 'category': 'Margins'},
    {'key': 'pre_tax_margin',                 'label': 'Pre-Tax Margin',         'type': 'percent', 'category': 'Margins'},
    {'key': 'free_cash_flow_margin',          'label': 'FCF Margin',             'type': 'percent', 'category': 'Margins'},

    # ── Balance Sheet ──
    {'key': 'total_assets',                   'label': 'Total Assets',           'type': 'number',  'category': 'Balance Sheet'},
    {'key': 'total_debt',                     'label': 'Total Debt',             'type': 'number',  'category': 'Balance Sheet'},
    {'key': 'total_current_assets',           'label': 'Current Assets',         'type': 'number',  'category': 'Balance Sheet'},
    {'key': 'debt_to_equity',                 'label': 'Debt/Equity',            'type': 'number',  'category': 'Balance Sheet'},
    {'key': 'current_ratio',                  'label': 'Current Ratio',          'type': 'number',  'category': 'Balance Sheet'},
    {'key': 'quick_ratio',                    'label': 'Quick Ratio',            'type': 'number',  'category': 'Balance Sheet'},

    # ── Cash Flow ──
    {'key': 'free_cash_flow',                 'label': 'Free Cash Flow',         'type': 'number',  'category': 'Cash Flow'},
    {'key': 'cash_f_operating_activities_ttm','label': 'Operating CF (TTM)',     'type': 'number',  'category': 'Cash Flow'},

    # ── Technicals ──
    {'key': 'RSI',                            'label': 'RSI (14)',               'type': 'number',  'category': 'Technicals'},
    {'key': 'RSI7',                           'label': 'RSI (7)',                'type': 'number',  'category': 'Technicals'},
    {'key': 'MACD.macd',                      'label': 'MACD',                   'type': 'number',  'category': 'Technicals'},
    {'key': 'MACD.signal',                    'label': 'MACD Signal',            'type': 'number',  'category': 'Technicals'},
    {'key': 'ATR',                            'label': 'ATR (14)',               'type': 'number',  'category': 'Technicals'},
    {'key': 'ADX',                            'label': 'ADX (14)',               'type': 'number',  'category': 'Technicals'},
    {'key': 'Stoch.K',                        'label': 'Stochastic %K',         'type': 'number',  'category': 'Technicals'},
    {'key': 'CCI20',                          'label': 'CCI (20)',               'type': 'number',  'category': 'Technicals'},
    {'key': 'SMA20',                          'label': 'SMA 20',                 'type': 'price',   'category': 'Technicals'},
    {'key': 'SMA50',                          'label': 'SMA 50',                 'type': 'price',   'category': 'Technicals'},
    {'key': 'SMA200',                         'label': 'SMA 200',                'type': 'price',   'category': 'Technicals'},
    {'key': 'EMA20',                          'label': 'EMA 20',                 'type': 'price',   'category': 'Technicals'},
    {'key': 'EMA50',                          'label': 'EMA 50',                 'type': 'price',   'category': 'Technicals'},
    {'key': 'EMA200',                         'label': 'EMA 200',                'type': 'price',   'category': 'Technicals'},
    {'key': 'BB.upper',                       'label': 'BB Upper',               'type': 'price',   'category': 'Technicals'},
    {'key': 'BB.lower',                       'label': 'BB Lower',               'type': 'price',   'category': 'Technicals'},
    {'key': 'Recommend.All',                  'label': 'Technical Rating',       'type': 'number',  'category': 'Technicals'},
    {'key': 'Recommend.MA',                   'label': 'MA Rating',              'type': 'number',  'category': 'Technicals'},

    # ── Pre-Market (US only) ──
    {'key': 'premarket_change',               'label': 'Pre-Market Change %',    'type': 'percent', 'category': 'Pre-Market'},
    {'key': 'premarket_volume',               'label': 'Pre-Market Volume',      'type': 'number',  'category': 'Pre-Market'},
    {'key': 'premarket_gap',                  'label': 'Pre-Market Gap %',       'type': 'percent', 'category': 'Pre-Market'},
    {'key': 'premarket_close',                'label': 'Pre-Market Close',       'type': 'price',   'category': 'Pre-Market'},

    # ── Earnings ──
    {'key': 'earnings_release_next_date',     'label': 'Next Earnings Date',     'type': 'date',    'category': 'Earnings'},
    {'key': 'earnings_per_share_forecast_next_fq', 'label': 'EPS Forecast (FQ)', 'type': 'price',  'category': 'Earnings'},

    # ── Classification ──
    {'key': 'sector',                         'label': 'Sector',                 'type': 'text',    'category': 'Classification'},
    {'key': 'industry',                       'label': 'Industry',               'type': 'text',    'category': 'Classification'},
    {'key': 'country',                        'label': 'Country',                'type': 'text',    'category': 'Classification'},
    {'key': 'exchange',                       'label': 'Exchange',               'type': 'text',    'category': 'Classification'},
]

# Build a fast lookup
_FIELD_MAP = {f['key']: f for f in FIELD_CATALOG}
_CATEGORIES = sorted(set(f['category'] for f in FIELD_CATALOG),
                      key=['Price & Volume', 'Performance', 'Valuation', 'Dividends',
                           'Income', 'Margins', 'Balance Sheet', 'Cash Flow',
                           'Technicals', 'Pre-Market', 'Earnings', 'Classification'].index)


# ═════════════════════════════════════════
# Preset column groups
# ═════════════════════════════════════════

PRESETS = {
    'overview':    {'label': 'Overview',     'columns': ['close', 'change', 'volume', 'market_cap_basic', 'price_earnings_ttm', 'earnings_per_share_diluted_ttm', 'sector']},
    'performance': {'label': 'Performance',  'columns': ['close', 'change', 'Perf.W', 'Perf.1M', 'Perf.3M', 'Perf.6M', 'Perf.Y', 'Perf.YTD']},
    'valuation':   {'label': 'Valuation',    'columns': ['close', 'market_cap_basic', 'price_earnings_ttm', 'price_book_ratio', 'price_sales_ratio', 'enterprise_value_ebitda_ttm', 'price_free_cash_flow_ttm']},
    'dividends':   {'label': 'Dividends',    'columns': ['close', 'dividend_yield_recent', 'dividends_per_share_fq', 'dividend_payout_ratio_ttm', 'market_cap_basic', 'sector']},
    'income':      {'label': 'Income',       'columns': ['close', 'earnings_per_share_diluted_ttm', 'earnings_per_share_diluted_yoy_growth_ttm', 'return_on_equity', 'return_on_assets', 'net_margin', 'total_revenue_ttm']},
    'balance':     {'label': 'Balance Sheet', 'columns': ['close', 'market_cap_basic', 'total_assets', 'total_debt', 'debt_to_equity', 'current_ratio', 'quick_ratio']},
    'technicals':  {'label': 'Technicals',   'columns': ['close', 'change', 'RSI', 'MACD.macd', 'SMA50', 'SMA200', 'ATR', 'Recommend.All']},
}


# ═════════════════════════════════════════
# Routes
# ═════════════════════════════════════════

@eqs_bp.route('/api/eqs/markets')
def markets():
    """Return markets available for the screener."""
    return jsonify([
        {'code': c.code, 'name': c.name, 'flag': c.flag,
         'region': c.region, 'tv_scanner': c.tv_scanner}
        for c in all_with_scanner()
    ])


@eqs_bp.route('/api/eqs/fields')
def fields():
    """Return the full field catalog grouped by category."""
    grouped = {}
    for f in FIELD_CATALOG:
        cat = f['category']
        if cat not in grouped:
            grouped[cat] = []
        grouped[cat].append({'key': f['key'], 'label': f['label'], 'type': f['type']})
    return jsonify({
        'categories': _CATEGORIES,
        'fields': grouped,
        'presets': {k: v for k, v in PRESETS.items()},
    })


@eqs_bp.route('/api/eqs/scan', methods=['POST'])
def scan():
    """Run a custom screen.

    JSON body:
      market   — scanner slug ('america', 'germany', …)
      columns  — list of field keys to return
      filters  — list of {field, op, value} where op is
                 'greater'|'less'|'egreater'|'eless'|'in_range'|'equal'
      sort     — {field, order} where order is 'asc'|'desc'
      limit    — max results (default 100, max 500)
    """
    body = request.get_json(force=True, silent=True) or {}
    market = body.get('market', 'america')
    columns = body.get('columns', ['name', 'description', 'close', 'change', 'volume', 'market_cap_basic'])
    user_filters = body.get('filters', [])
    sort_cfg = body.get('sort', {'field': 'market_cap_basic', 'order': 'desc'})
    limit = min(int(body.get('limit', 100)), 500)

    # Always include name + description for display
    req_columns = ['name', 'description'] + [c for c in columns if c not in ('name', 'description')]

    # Build scanner filters
    scanner_filters = [
        {'left': 'type',       'operation': 'equal',    'right': 'stock'},
        {'left': 'is_primary', 'operation': 'equal',    'right': True},
    ]
    for f in user_filters:
        field = f.get('field', '')
        op = f.get('op', 'greater')
        val = f.get('value')
        if not field or val is None:
            continue
        # in_range expects [min, max]
        if op == 'in_range' and isinstance(val, list) and len(val) == 2:
            scanner_filters.append({'left': field, 'operation': 'in_range', 'right': val})
        else:
            try:
                val = float(val)
            except (ValueError, TypeError):
                pass
            scanner_filters.append({'left': field, 'operation': op, 'right': val})

    scanner_body = {
        'filter':  scanner_filters,
        'columns': req_columns,
        'sort':    {'sortBy': sort_cfg.get('field', 'market_cap_basic'),
                    'sortOrder': sort_cfg.get('order', 'desc')},
        'range':   [0, limit],
    }

    cache_key = f"eqs_{market}_{hash(json.dumps(scanner_body, sort_keys=True))}"

    def fetch():
        data = json.dumps(scanner_body).encode('utf-8')
        req = urllib.request.Request(
            SCANNER_URL.format(market=market),
            data=data, headers=_UA, method='POST',
        )
        with urllib.request.urlopen(req, timeout=20) as resp:
            payload = json.loads(resp.read().decode('utf-8'))

        rows_raw = payload.get('data') or []
        results = []
        for row in rows_raw:
            tv_sym = row.get('s') or ''
            d = row.get('d') or []
            if not tv_sym or len(d) < 2:
                continue

            ticker_base = (d[0] or '').replace('_', '-')
            # Map columns: d[0]=name, d[1]=description, d[2..]=user columns
            entry = {
                'tv_symbol': tv_sym,
                'ticker':    ticker_base,
                'name':      (d[1] or ticker_base).strip(),
            }
            for i, col_key in enumerate(req_columns[2:], start=2):
                entry[col_key] = d[i] if i < len(d) else None

            results.append(entry)
        return results

    try:
        data = cached(cache_key, fetch, ttl=60)  # 1-min cache
        return jsonify({
            'rows':    data,
            'columns': req_columns,
            'total':   len(data),
            'source':  'TradingView',
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500
