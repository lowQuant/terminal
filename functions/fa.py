"""FA — Financial Analysis.

Serves fundamental financial data for a security: Income Statement,
Balance Sheet, Cash Flow, plus derived ratios and highlights.

Data source: Yahoo Finance's **fundamentals-timeseries** endpoint —
the same backend yfinance uses internally, but called directly so we
can request up to 10+ years of annual history (and 40+ quarters of
quarterly history) in a single request. yfinance's convenience
properties (`.income_stmt`, `.quarterly_income_stmt`, …) only return
the last 4 periods, which is not enough for a Bloomberg-style FA view.

Raw URL pattern::

    https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/<SYMBOL>
        ?symbol=<SYMBOL>
        &type=annualTotalRevenue,annualGrossProfit,...
        &period1=<unix-start>
        &period2=<unix-end>

Response shape (abbreviated)::

    {"timeseries": {"result": [
        {"meta": {"symbol": "AAPL", "type": ["annualTotalRevenue"]},
         "timestamp": [1411862400, ...],
         "annualTotalRevenue": [
             {"dataId": 20100, "asOfDate": "2014-09-30", "periodType": "12M",
              "currencyCode": "USD", "reportedValue": {"raw": 182795000000}},
             ...
         ]}
    ]}}

We unify all row arrays into a single chronologically-sorted
(oldest-first) JSON shape the frontend can render without any pandas
knowledge::

    {
      "symbol": "AAPL",
      "period": "annual" | "quarterly",
      "currency": "USD",
      "displayCurrency": "USD",
      "periods": ["2014-09-30", "2015-09-26", ..., "2024-09-28"],
      "income":   [{"label": "Total Revenue", "key": "TotalRevenue", "values": [...]}],
      "balance":  [...],
      "cashflow": [...],
      "highlights": {...},   # TTM snapshot ratios from yfinance .info
    }

Currency conversion: figures are returned in the security's native
financial currency by default. Pass `?ccy=USD` (or any ECB currency) to
have the backend scale monetary rows using rates from ``functions.fx``.

Endpoints::

    GET /api/fa/statements/<symbol>?exchange=&period=annual|quarterly&ccy=USD
    GET /api/fa/currencies
"""

import copy
import time
import traceback
from datetime import datetime
from typing import Dict, List, Optional, Tuple

import requests
import yfinance as yf
from flask import Blueprint, jsonify, request

from exchange_map import to_yfinance_ticker
from functions._utils import cached
from functions.fx import get_rate, get_rates


fa_bp = Blueprint('fa', __name__)


# ── Statement row definitions ──────────────────────────────────────
#
# Each entry is (label, row_type, yahoo_field_base).
#
# row_type:
#   'data'    – a real Yahoo metric; fetched from the timeseries API
#   'header'  – a visual section break (no data, rendered as a subtitle row)
#   'computed' – derived on the frontend (growth %, margin %, etc.); we
#               still include it so the row order is deterministic.
#
# yahoo_field_base is the field name WITHOUT the frequency prefix. We
# prepend `annual`, `quarterly`, or `trailing` at request time.
#
# Ordered list — the frontend renders rows in the order we give them.

INCOME_ROWS: List[Tuple[str, str, Optional[str]]] = [
    ('Total Revenue',               'data',     'TotalRevenue'),
    ('Revenue Growth YoY',          'computed', 'growth:TotalRevenue'),
    ('Cost of Revenue',             'data',     'CostOfRevenue'),
    ('Gross Profit',                'data',     'GrossProfit'),
    ('Gross Margin',                'computed', 'margin:GrossProfit/TotalRevenue'),
    ('— OPERATING EXPENSES —',      'header',   None),
    ('Research & Development',      'data',     'ResearchAndDevelopment'),
    ('Selling, General & Admin.',   'data',     'SellingGeneralAndAdministration'),
    ('Other Operating Expenses',    'data',     'OtherOperatingExpenses'),
    ('Total Operating Expenses',    'data',     'OperatingExpense'),
    ('Operating Income',            'data',     'OperatingIncome'),
    ('Operating Margin',            'computed', 'margin:OperatingIncome/TotalRevenue'),
    ('— NON-OPERATING —',           'header',   None),
    ('Interest Income',             'data',     'InterestIncome'),
    ('Interest Expense',            'data',     'InterestExpense'),
    ('Other Income (Expense)',      'data',     'OtherNonOperatingIncomeExpenses'),
    ('Pretax Income',               'data',     'PretaxIncome'),
    ('Tax Provision',               'data',     'TaxProvision'),
    ('Effective Tax Rate',          'computed', 'ratio:TaxProvision/PretaxIncome'),
    ('— NET INCOME —',              'header',   None),
    ('Net Income Cont. Ops',        'data',     'NetIncomeContinuousOperations'),
    ('Net Income',                  'data',     'NetIncome'),
    ('Net Income Growth YoY',       'computed', 'growth:NetIncome'),
    ('Net Margin',                  'computed', 'margin:NetIncome/TotalRevenue'),
    ('EBIT',                        'data',     'EBIT'),
    ('EBITDA',                      'data',     'EBITDA'),
    ('EBITDA Margin',               'computed', 'margin:EBITDA/TotalRevenue'),
    ('— PER SHARE —',               'header',   None),
    ('Basic EPS',                   'data',     'BasicEPS'),
    ('Diluted EPS',                 'data',     'DilutedEPS'),
    ('EPS Growth YoY',              'computed', 'growth:DilutedEPS'),
    ('Basic Shares Outstanding',    'data',     'BasicAverageShares'),
    ('Diluted Shares Outstanding',  'data',     'DilutedAverageShares'),
]


BALANCE_ROWS: List[Tuple[str, str, Optional[str]]] = [
    ('— CURRENT ASSETS —',              'header',   None),
    ('Cash & Cash Equivalents',         'data',     'CashAndCashEquivalents'),
    ('Short-Term Investments',          'data',     'OtherShortTermInvestments'),
    ('Cash & Short-Term Invest.',       'data',     'CashCashEquivalentsAndShortTermInvestments'),
    ('Receivables',                     'data',     'Receivables'),
    ('Inventory',                       'data',     'Inventory'),
    ('Prepaid Assets',                  'data',     'PrepaidAssets'),
    ('Other Current Assets',            'data',     'OtherCurrentAssets'),
    ('Total Current Assets',            'data',     'CurrentAssets'),
    ('— NON-CURRENT ASSETS —',          'header',   None),
    ('Net PPE',                         'data',     'NetPPE'),
    ('Goodwill',                        'data',     'Goodwill'),
    ('Other Intangibles',               'data',     'OtherIntangibleAssets'),
    ('Long-Term Investments',           'data',     'InvestmentsAndAdvances'),
    ('Other Non-Current Assets',        'data',     'OtherNonCurrentAssets'),
    ('Total Non-Current Assets',        'data',     'TotalNonCurrentAssets'),
    ('TOTAL ASSETS',                    'data',     'TotalAssets'),
    ('— CURRENT LIABILITIES —',         'header',   None),
    ('Accounts Payable',                'data',     'AccountsPayable'),
    ('Short-Term Debt',                 'data',     'CurrentDebt'),
    ('Current Deferred Liabilities',    'data',     'CurrentDeferredLiabilities'),
    ('Other Current Liabilities',       'data',     'OtherCurrentLiabilities'),
    ('Total Current Liabilities',       'data',     'CurrentLiabilities'),
    ('— NON-CURRENT LIABILITIES —',     'header',   None),
    ('Long-Term Debt',                  'data',     'LongTermDebt'),
    ('Non-Current Deferred Liab.',      'data',     'NonCurrentDeferredLiabilities'),
    ('Other Non-Current Liabilities',   'data',     'OtherNonCurrentLiabilities'),
    ('Total Non-Current Liabilities',   'data',     'TotalNonCurrentLiabilitiesNetMinorityInterest'),
    ('TOTAL LIABILITIES',               'data',     'TotalLiabilitiesNetMinorityInterest'),
    ('— EQUITY —',                      'header',   None),
    ('Common Stock',                    'data',     'CommonStock'),
    ('Retained Earnings',               'data',     'RetainedEarnings'),
    ('TOTAL EQUITY',                    'data',     'StockholdersEquity'),
    ('— DEBT & LIQUIDITY —',            'header',   None),
    ('Total Debt',                      'data',     'TotalDebt'),
    ('Net Debt',                        'data',     'NetDebt'),
    ('Working Capital',                 'data',     'WorkingCapital'),
    ('Shares Issued',                   'data',     'ShareIssued'),
    ('Book Value / Share',              'computed', 'ratio:StockholdersEquity/ShareIssued'),
]


CASHFLOW_ROWS: List[Tuple[str, str, Optional[str]]] = [
    ('— OPERATING ACTIVITIES —',        'header',   None),
    ('Net Income (CF)',                 'data',     'NetIncomeFromContinuingOperations'),
    ('Depreciation & Amortization',     'data',     'DepreciationAmortizationDepletion'),
    ('Stock-Based Compensation',        'data',     'StockBasedCompensation'),
    ('Change in Working Capital',       'data',     'ChangeInWorkingCapital'),
    ('Operating Cash Flow',             'data',     'OperatingCashFlow'),
    ('— INVESTING ACTIVITIES —',        'header',   None),
    ('Capital Expenditure',             'data',     'CapitalExpenditure'),
    ('Net Investment Purchase & Sale',  'data',     'NetInvestmentPurchaseAndSale'),
    ('Net Business Purchase & Sale',    'data',     'NetBusinessPurchaseAndSale'),
    ('Investing Cash Flow',             'data',     'InvestingCashFlow'),
    ('— FINANCING ACTIVITIES —',        'header',   None),
    ('Net Debt Issuance',               'data',     'NetIssuancePaymentsOfDebt'),
    ('Stock Repurchases',               'data',     'RepurchaseOfCapitalStock'),
    ('Stock Issuance',                  'data',     'IssuanceOfCapitalStock'),
    ('Cash Dividends Paid',             'data',     'CashDividendsPaid'),
    ('Financing Cash Flow',             'data',     'FinancingCashFlow'),
    ('— SUMMARY —',                     'header',   None),
    ('Net Change in Cash',              'data',     'ChangesInCash'),
    ('End Cash Position',               'data',     'EndCashPosition'),
    ('Free Cash Flow',                  'data',     'FreeCashFlow'),
    ('FCF Margin',                      'computed', 'margin:FreeCashFlow/TotalRevenue'),
]


# Fields we actually need to fetch from Yahoo — flatten the three lists
# plus any fields referenced by computed rows.
def _all_fetched_fields() -> List[str]:
    fields: set = set()
    for rows in (INCOME_ROWS, BALANCE_ROWS, CASHFLOW_ROWS):
        for label, kind, key in rows:
            if kind == 'data' and key:
                fields.add(key)
            elif kind == 'computed' and key:
                # Strip the directive prefix → field names
                _, rest = key.split(':', 1)
                for part in rest.split('/'):
                    fields.add(part.strip())
    return sorted(fields)


_ALL_FIELDS = _all_fetched_fields()


# Fields that are non-monetary (counts, ratios) — not scaled by FX.
NON_MONETARY_KEYS = {
    'BasicAverageShares', 'DilutedAverageShares', 'ShareIssued',
    'OrdinarySharesNumber',
}


# ── Yahoo timeseries fetcher ───────────────────────────────────────

_YAHOO_URL = 'https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/{symbol}'

# Yahoo wants a browser-like user agent or it may 429
_YAHOO_HEADERS = {
    'User-Agent': (
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
        'AppleWebKit/537.36 (KHTML, like Gecko) '
        'Chrome/124.0.0.0 Safari/537.36'
    ),
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
}


def _fetch_timeseries(symbol: str, freq: str, fields: List[str]) -> Dict[str, Dict[str, float]]:
    """Fetch Yahoo fundamentals-timeseries for a symbol.

    Args:
        symbol: yfinance-style ticker (e.g. 'AAPL', 'TM', '7203.T')
        freq: 'annual' or 'quarterly'
        fields: base field names without prefix (e.g. 'TotalRevenue')

    Returns:
        {asOfDate (str): {field_base: raw_value}}

        Where asOfDate is 'YYYY-MM-DD'. Fields missing from a period
        simply aren't present in its inner dict. Periods sorted
        oldest-first.
    """
    prefix_map = {'annual': 'annual', 'quarterly': 'quarterly'}
    prefix = prefix_map.get(freq, 'annual')
    typed = [prefix + f for f in fields]

    # Yahoo's timeseries endpoint requires a window. Going back 12 years
    # gives enough room for 10+ annual periods or 40+ quarters.
    now_ts = int(time.time())
    start_ts = now_ts - (12 * 365 * 86_400)

    # Yahoo enforces a max URL length; chunk the type list in groups of 20.
    periods: Dict[str, Dict[str, float]] = {}

    for chunk_start in range(0, len(typed), 20):
        chunk = typed[chunk_start:chunk_start + 20]
        params = {
            'symbol': symbol,
            'type': ','.join(chunk),
            'period1': start_ts,
            'period2': now_ts,
        }

        resp = requests.get(
            _YAHOO_URL.format(symbol=symbol),
            params=params,
            headers=_YAHOO_HEADERS,
            timeout=15,
        )
        if resp.status_code != 200:
            continue

        try:
            body = resp.json()
        except ValueError:
            continue

        results = (body.get('timeseries') or {}).get('result') or []
        for entry in results:
            meta = entry.get('meta') or {}
            types = meta.get('type') or []
            typed_key = types[0] if types else None
            if not typed_key:
                continue

            # Extract the field base (strip 'annual' / 'quarterly' prefix)
            if typed_key.startswith(prefix):
                field_base = typed_key[len(prefix):]
            else:
                field_base = typed_key

            # The data points are under a key that matches typed_key
            points = entry.get(typed_key) or []
            for point in points:
                if not point:
                    continue
                as_of = point.get('asOfDate')
                rv = point.get('reportedValue') or {}
                raw = rv.get('raw')
                if as_of is None or raw is None:
                    continue
                try:
                    raw = float(raw)
                    if raw != raw:  # NaN
                        continue
                except (TypeError, ValueError):
                    continue
                periods.setdefault(as_of, {})[field_base] = raw

    return periods


def _build_payload(symbol: str, freq: str) -> dict:
    """Fetch + shape the full FA payload (no FX conversion applied)."""
    periods_map = _fetch_timeseries(symbol, freq, _ALL_FIELDS)

    # Chronological order: oldest → newest (Bloomberg convention)
    period_dates = sorted(periods_map.keys())

    def build_rows(defs: List[Tuple[str, str, Optional[str]]]):
        out = []
        for label, kind, key in defs:
            if kind == 'header':
                out.append({'label': label, 'kind': 'header'})
            elif kind == 'data':
                values = [periods_map.get(p, {}).get(key) for p in period_dates]
                # Only include the row if at least one period has data,
                # to keep tables tight for companies with sparse coverage.
                if any(v is not None for v in values):
                    out.append({
                        'label': label,
                        'kind': 'data',
                        'key': key,
                        'values': values,
                    })
            elif kind == 'computed':
                out.append({
                    'label': label,
                    'kind': 'computed',
                    'key': key,  # e.g. 'margin:GrossProfit/TotalRevenue'
                })
        return out

    income = build_rows(INCOME_ROWS)
    balance = build_rows(BALANCE_ROWS)
    cashflow = build_rows(CASHFLOW_ROWS)

    # Highlights via yfinance .info (TTM snapshot ratios)
    info = {}
    try:
        info = yf.Ticker(symbol).info or {}
    except Exception:
        info = {}

    native_ccy = (info.get('financialCurrency') or info.get('currency') or 'USD').upper()

    def g(key):
        v = info.get(key)
        try:
            if v is None:
                return None
            fv = float(v)
            if fv != fv:
                return None
            return fv
        except (TypeError, ValueError):
            return v

    highlights = {
        # Valuation
        'marketCap': g('marketCap'),
        'enterpriseValue': g('enterpriseValue'),
        'trailingPE': g('trailingPE'),
        'forwardPE': g('forwardPE'),
        'pegRatio': g('pegRatio'),
        'priceToBook': g('priceToBook'),
        'priceToSales': g('priceToSalesTrailing12Months'),
        'evToRevenue': g('enterpriseToRevenue'),
        'evToEbitda': g('enterpriseToEbitda'),
        # Profitability
        'grossMargins': g('grossMargins'),
        'operatingMargins': g('operatingMargins'),
        'profitMargins': g('profitMargins'),
        'returnOnEquity': g('returnOnEquity'),
        'returnOnAssets': g('returnOnAssets'),
        # Growth
        'revenueGrowth': g('revenueGrowth'),
        'earningsGrowth': g('earningsGrowth'),
        'earningsQuarterlyGrowth': g('earningsQuarterlyGrowth'),
        # Financial health
        'totalCash': g('totalCash'),
        'totalDebt': g('totalDebt'),
        'debtToEquity': g('debtToEquity'),
        'currentRatio': g('currentRatio'),
        'quickRatio': g('quickRatio'),
        # Shareholder
        'dividendYield': g('dividendYield'),
        'payoutRatio': g('payoutRatio'),
        # Per-share / TTM
        'trailingEps': g('trailingEps'),
        'forwardEps': g('forwardEps'),
        'bookValue': g('bookValue'),
        'revenue': g('totalRevenue'),
        'netIncome': g('netIncomeToCommon'),
        'ebitda': g('ebitda'),
        'freeCashFlow': g('freeCashflow'),
        'operatingCashFlow': g('operatingCashflow'),
        # Identity
        'sharesOutstanding': g('sharesOutstanding'),
        'floatShares': g('floatShares'),
        'beta': g('beta'),
    }

    return {
        'symbol': symbol.upper(),
        'period': freq,
        'currency': native_ccy,
        'displayCurrency': native_ccy,
        'companyName': info.get('longName') or info.get('shortName') or symbol,
        'periods': period_dates,
        'income': income,
        'balance': balance,
        'cashflow': cashflow,
        'highlights': highlights,
    }


# ── Currency conversion ───────────────────────────────────────────

def _apply_currency(data: dict, from_ccy: str, to_ccy: str) -> dict:
    """Scale monetary values in-place. Return the same dict for chaining."""
    if not from_ccy or not to_ccy or from_ccy == to_ccy:
        data['displayCurrency'] = from_ccy
        return data

    rate = get_rate(from_ccy, to_ccy)
    if rate == 1.0:
        data['displayCurrency'] = from_ccy
        return data

    for section_key in ('income', 'balance', 'cashflow'):
        for row in data.get(section_key, []):
            if row.get('kind') != 'data':
                continue
            if row.get('key') in NON_MONETARY_KEYS:
                continue
            row['values'] = [
                (v * rate) if v is not None else None
                for v in row['values']
            ]

    # Highlights: known monetary fields
    HL_MONETARY = {
        'marketCap', 'enterpriseValue', 'revenue', 'netIncome', 'totalCash',
        'totalDebt', 'freeCashFlow', 'operatingCashFlow', 'ebitda',
        'trailingEps', 'forwardEps', 'bookValue',
    }
    hl = data.get('highlights') or {}
    for k in list(hl.keys()):
        if k in HL_MONETARY and isinstance(hl[k], (int, float)):
            hl[k] = hl[k] * rate

    data['displayCurrency'] = to_ccy
    data['fxRate'] = rate
    return data


# ── Flask endpoints ───────────────────────────────────────────────

@fa_bp.route('/api/fa/statements/<symbol>')
def api_statements(symbol):
    """Return IS / BS / CF statements for a security.

    Query params:
        exchange  — TradingView prefix (NASDAQ, TSE, XETR, …)
        period    — 'annual' (default) or 'quarterly'
        ccy       — convert all monetary figures into this currency
    """
    exchange = (request.args.get('exchange') or '').strip()
    period = (request.args.get('period') or 'annual').strip().lower()
    target_ccy = (request.args.get('ccy') or '').strip().upper() or None

    if period not in ('annual', 'quarterly'):
        period = 'annual'

    try:
        def fetch():
            yf_ticker = to_yfinance_ticker(exchange, symbol) if exchange else symbol
            return _build_payload(yf_ticker, period)

        cache_key = f'fa_{exchange}_{symbol}_{period}'
        data = cached(cache_key, fetch)

        # FX conversion is applied post-cache so the native-currency
        # payload stays in the cache across users requesting different
        # display currencies.
        if target_ccy and target_ccy != data.get('currency'):
            data = copy.deepcopy(data)
            _apply_currency(data, data.get('currency'), target_ccy)

        return jsonify(data)

    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@fa_bp.route('/api/fa/currencies')
def api_currencies():
    """Return convertible currencies (ECB rate universe)."""
    try:
        rates = get_rates()
        majors = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'HKD', 'CNY']
        available = sorted(rates.keys())
        ordered = [c for c in majors if c in available]
        ordered += [c for c in available if c not in ordered]
        return jsonify({'currencies': ordered})
    except Exception as e:
        traceback.print_exc()
        return jsonify({
            'error': str(e),
            'currencies': ['USD', 'EUR', 'GBP', 'JPY', 'CHF'],
        }), 500
