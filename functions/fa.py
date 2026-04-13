"""FA — Financial Analysis.

Serves fundamental financial data for a security: Income Statement,
Balance Sheet, Cash Flow, plus derived ratios and highlights.

Data source: yfinance. Each `Ticker` exposes:
    - .income_stmt / .quarterly_income_stmt
    - .balance_sheet / .quarterly_balance_sheet
    - .cashflow / .quarterly_cashflow
    - .info  (ratios, margins, growth — TTM or point-in-time)

We unify the raw DataFrames into a JSON shape the frontend can render
without any pandas knowledge:

    {
      "currency": "USD",
      "currencies": ["USD", "EUR", "GBP", ...],
      "period": "annual" | "quarterly",
      "periods": ["2024-12-31", "2023-12-31", ...],
      "income": [{"label": "Total Revenue", "key": "TotalRevenue", "values": [..]}, ...],
      "balance": [...],
      "cashflow": [...],
      "ratios": {...},
      "highlights": {...}
    }

Currency conversion: All figures are returned in the security's native
reporting currency. The frontend can request conversion by passing
``?ccy=USD`` — we apply ECB-based FX rates from ``functions.fx``.

Endpoints:
    GET /api/fa/statements/<symbol>?exchange=&period=annual|quarterly&ccy=USD
    GET /api/fa/highlights/<symbol>?exchange=&ccy=USD
"""

import traceback
from flask import Blueprint, jsonify, request
import yfinance as yf

from exchange_map import to_yfinance_ticker
from functions._utils import cached
from functions.fx import get_rate


fa_bp = Blueprint('fa', __name__)


# ── Statement row definitions ──────────────────────────────────────
# Maps the human-readable label → list of yfinance row keys to try
# (yfinance's row names have changed across versions; we try several).
# Keeping this as an ordered list lets the frontend display rows in a
# deterministic, Bloomberg-like order regardless of how pandas sorts
# the underlying frame.

INCOME_ROWS = [
    ('Total Revenue',              ['TotalRevenue', 'Total Revenue']),
    ('Cost of Revenue',            ['CostOfRevenue', 'Cost Of Revenue']),
    ('Gross Profit',               ['GrossProfit', 'Gross Profit']),
    ('Research & Development',     ['ResearchAndDevelopment', 'Research Development']),
    ('Selling, G&A',               ['SellingGeneralAndAdministration', 'Selling General Administrative']),
    ('Operating Expenses',         ['OperatingExpense', 'Operating Expenses', 'Total Operating Expenses']),
    ('Operating Income',           ['OperatingIncome', 'Operating Income']),
    ('Interest Expense',           ['InterestExpense', 'Interest Expense']),
    ('Pretax Income',              ['PretaxIncome', 'Income Before Tax']),
    ('Tax Provision',              ['TaxProvision', 'Income Tax Expense']),
    ('Net Income',                 ['NetIncome', 'Net Income', 'NetIncomeCommonStockholders']),
    ('EBIT',                       ['EBIT']),
    ('EBITDA',                     ['EBITDA', 'NormalizedEBITDA']),
    ('Diluted EPS',                ['DilutedEPS', 'Diluted EPS']),
    ('Basic EPS',                  ['BasicEPS', 'Basic EPS']),
    ('Diluted Shares Outstanding', ['DilutedAverageShares', 'Diluted Average Shares']),
]

BALANCE_ROWS = [
    ('Total Assets',               ['TotalAssets', 'Total Assets']),
    ('Current Assets',             ['CurrentAssets', 'Total Current Assets']),
    ('Cash & Short-Term Invest.',  ['CashCashEquivalentsAndShortTermInvestments', 'Cash And Short Term Investments', 'CashAndCashEquivalents']),
    ('Receivables',                ['Receivables', 'Net Receivables']),
    ('Inventory',                  ['Inventory']),
    ('Non-Current Assets',         ['TotalNonCurrentAssets', 'Total Non Current Assets']),
    ('Net PPE',                    ['NetPPE', 'Property Plant Equipment']),
    ('Goodwill & Intangibles',     ['GoodwillAndOtherIntangibleAssets', 'Goodwill', 'Intangible Assets']),
    ('Total Liabilities',          ['TotalLiabilitiesNetMinorityInterest', 'Total Liab']),
    ('Current Liabilities',        ['CurrentLiabilities', 'Total Current Liabilities']),
    ('Accounts Payable',           ['AccountsPayable']),
    ('Short-Term Debt',            ['CurrentDebt', 'Short Long Term Debt']),
    ('Long-Term Debt',             ['LongTermDebt', 'Long Term Debt']),
    ('Total Debt',                 ['TotalDebt', 'Total Debt']),
    ('Total Equity',               ['StockholdersEquity', 'Total Stockholder Equity']),
    ('Retained Earnings',          ['RetainedEarnings', 'Retained Earnings']),
    ('Shares Issued',              ['ShareIssued', 'Ordinary Shares Number']),
]

CASHFLOW_ROWS = [
    ('Operating Cash Flow',        ['OperatingCashFlow', 'Total Cash From Operating Activities']),
    ('Capital Expenditure',        ['CapitalExpenditure', 'Capital Expenditures']),
    ('Free Cash Flow',             ['FreeCashFlow']),
    ('Investing Cash Flow',        ['InvestingCashFlow', 'Total Cashflows From Investing Activities']),
    ('Financing Cash Flow',        ['FinancingCashFlow', 'Total Cash From Financing Activities']),
    ('Stock Repurchases',          ['RepurchaseOfCapitalStock', 'Repurchase Of Stock']),
    ('Cash Dividends Paid',        ['CashDividendsPaid', 'Dividends Paid']),
    ('Net Debt Issuance',          ['NetIssuancePaymentsOfDebt', 'Net Borrowings']),
    ('Change in Cash',             ['ChangesInCash', 'Change In Cash']),
    ('End Cash Position',          ['EndCashPosition']),
]


def _lookup(df, keys):
    """Return a (label, values) row from a yfinance DataFrame.
    Tries each key until one is found. Returns None if nothing matches.
    """
    if df is None or df.empty:
        return None
    for key in keys:
        if key in df.index:
            row = df.loc[key]
            # row is a Series indexed by period timestamps
            values = []
            for v in row.values:
                try:
                    if v is None:
                        values.append(None)
                    else:
                        # numpy NaN → None
                        fv = float(v)
                        if fv != fv:  # NaN check
                            values.append(None)
                        else:
                            values.append(fv)
                except (TypeError, ValueError):
                    values.append(None)
            return values
    return None


def _build_rows(df, row_defs):
    """Convert a yfinance DataFrame into an ordered list of rows."""
    rows = []
    for label, keys in row_defs:
        values = _lookup(df, keys)
        if values is not None:
            rows.append({
                'label': label,
                'key': keys[0],
                'values': values,
            })
    return rows


def _period_labels(df):
    """Extract period date labels as 'YYYY-MM-DD' strings from DataFrame columns."""
    if df is None or df.empty:
        return []
    labels = []
    for col in df.columns:
        try:
            # pandas Timestamp has strftime
            labels.append(col.strftime('%Y-%m-%d'))
        except AttributeError:
            labels.append(str(col))
    return labels


def _apply_currency(data, from_ccy, to_ccy):
    """Scale all monetary values in `data` by the fx rate.
    EPS rows are per-share so we also scale them.
    Share counts are not scaled.
    """
    if not from_ccy or not to_ccy or from_ccy == to_ccy:
        data['displayCurrency'] = from_ccy
        return data

    rate = get_rate(from_ccy, to_ccy)
    if rate == 1.0:
        data['displayCurrency'] = from_ccy
        return data

    # Keys whose values are NOT monetary (share counts etc.)
    NON_MONETARY_KEYS = {'DilutedAverageShares', 'ShareIssued', 'BasicAverageShares'}

    for section_key in ('income', 'balance', 'cashflow'):
        for row in data.get(section_key, []):
            if row['key'] in NON_MONETARY_KEYS:
                continue
            row['values'] = [
                (v * rate) if v is not None else None
                for v in row['values']
            ]

    # Highlights: monetary fields
    HL_MONETARY = {'marketCap', 'enterpriseValue', 'revenue', 'netIncome', 'totalCash',
                   'totalDebt', 'freeCashFlow', 'operatingCashFlow', 'ebitda', 'eps',
                   'forwardEps', 'trailingEps', 'bookValue', 'priceToBook'}
    hl = data.get('highlights') or {}
    for k, v in list(hl.items()):
        if k in HL_MONETARY and isinstance(v, (int, float)):
            hl[k] = v * rate

    data['displayCurrency'] = to_ccy
    data['fxRate'] = rate
    return data


def _build_highlights(info, income_df, balance_df, cashflow_df):
    """Build the Highlights dashboard — key ratios + last-period numbers."""
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

    hl = {
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

        # Shareholder returns
        'dividendYield': g('dividendYield'),
        'payoutRatio': g('payoutRatio'),

        # Per-share
        'trailingEps': g('trailingEps'),
        'forwardEps': g('forwardEps'),
        'bookValue': g('bookValue'),

        # TTM
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
    return hl


@fa_bp.route('/api/fa/statements/<symbol>')
def api_statements(symbol):
    """Return income / balance / cashflow statements for a security.

    Query params:
        exchange  — TradingView prefix (e.g. NASDAQ, TSE, XETR) for yfinance mapping
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
            t = yf.Ticker(yf_ticker)
            info = {}
            try:
                info = t.info or {}
            except Exception:
                info = {}

            native_ccy = info.get('financialCurrency') or info.get('currency') or 'USD'
            native_ccy = (native_ccy or 'USD').upper()

            if period == 'quarterly':
                income_df = getattr(t, 'quarterly_income_stmt', None)
                balance_df = getattr(t, 'quarterly_balance_sheet', None)
                cashflow_df = getattr(t, 'quarterly_cashflow', None)
            else:
                income_df = getattr(t, 'income_stmt', None)
                balance_df = getattr(t, 'balance_sheet', None)
                cashflow_df = getattr(t, 'cashflow', None)

            # Unify the period labels across statements (usually identical,
            # but the frontend needs one source of truth for columns).
            periods = _period_labels(income_df) or _period_labels(balance_df) or _period_labels(cashflow_df)

            data = {
                'symbol': symbol.upper(),
                'period': period,
                'currency': native_ccy,
                'periods': periods,
                'income': _build_rows(income_df, INCOME_ROWS),
                'balance': _build_rows(balance_df, BALANCE_ROWS),
                'cashflow': _build_rows(cashflow_df, CASHFLOW_ROWS),
                'highlights': _build_highlights(info, income_df, balance_df, cashflow_df),
                'companyName': info.get('longName') or info.get('shortName') or symbol,
            }
            return data

        cache_key = f'fa_{exchange}_{symbol}_{period}'
        data = cached(cache_key, fetch)

        # Apply currency conversion after caching so native-currency data
        # stays in the cache and conversion is a cheap post-processing step.
        if target_ccy and target_ccy != data.get('currency'):
            # Deep-copy-ish: build a new dict with cloned rows so we don't
            # mutate the cached entry.
            import copy
            data = copy.deepcopy(data)
            data = _apply_currency(data, data.get('currency'), target_ccy)
        else:
            data['displayCurrency'] = data.get('currency')

        return jsonify(data)

    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@fa_bp.route('/api/fa/currencies')
def api_currencies():
    """Return the list of currencies we can convert to (from ECB rates)."""
    try:
        from functions.fx import get_rates
        rates = get_rates()
        # Sort with the majors first, then alphabetical
        majors = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'HKD', 'CNY']
        available = sorted(rates.keys())
        ordered = [c for c in majors if c in available]
        ordered += [c for c in available if c not in ordered]
        return jsonify({'currencies': ordered})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e), 'currencies': ['USD', 'EUR', 'GBP', 'JPY', 'CHF']}), 500
