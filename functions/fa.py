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


def _fetch_via_yf_session(ticker: yf.Ticker, url: str, params: dict):
    """Call Yahoo via yfinance's internal session (handles cookie+crumb).

    Returns a requests.Response or None on failure. Falls back to a plain
    requests.get() if yfinance's internal API is unavailable.
    """
    # yfinance 0.2.x exposes the data fetcher at Ticker._data with a
    # `.get(url=, params=)` method that transparently handles the Yahoo
    # cookie / crumb handshake. Older versions may call it differently.
    data_client = getattr(ticker, '_data', None)
    if data_client is not None and hasattr(data_client, 'get'):
        try:
            return data_client.get(url=url, params=params)
        except TypeError:
            # Some versions use positional args
            try:
                return data_client.get(url, params=params)
            except Exception as e:
                print(f'[fa] _data.get failed: {e}')
        except Exception as e:
            print(f'[fa] _data.get failed: {e}')

    # Plain requests fallback — works for many symbols but may be rate-limited
    try:
        return requests.get(url, params=params, headers=_YAHOO_HEADERS, timeout=15)
    except Exception as e:
        print(f'[fa] requests.get failed: {e}')
        return None


def _fetch_timeseries(
    symbol: str,
    freq: str,
    fields: List[str],
    ticker: Optional[yf.Ticker] = None,
) -> Dict[str, Dict[str, float]]:
    """Fetch Yahoo fundamentals-timeseries for a symbol.

    Uses yfinance's internal session so the cookie/crumb handshake is
    done for us. Chunks the field list (Yahoo caps URL length at ~8KB).

    Args:
        symbol: yfinance-style ticker (e.g. 'AAPL', 'TM', '7203.T')
        freq: 'annual' or 'quarterly'
        fields: base field names without prefix (e.g. 'TotalRevenue')
        ticker: optional pre-built yf.Ticker to reuse its session

    Returns:
        {asOfDate (str): {field_base: raw_value}}
    """
    prefix = 'annual' if freq == 'annual' else 'quarterly'
    typed = [prefix + f for f in fields]

    # Windows
    now_ts = int(time.time())
    # Use a very old start so we get the full history Yahoo has.
    start_ts = 493590046  # 1985-08-25 — same default as yfinance internally

    if ticker is None:
        ticker = yf.Ticker(symbol)
    # Warm up yfinance session (triggers the cookie/crumb fetch)
    try:
        _ = ticker._data.cookie  # attribute access forces init in most versions
    except Exception:
        pass

    periods: Dict[str, Dict[str, float]] = {}
    fetch_errors = 0

    for chunk_start in range(0, len(typed), 20):
        chunk = typed[chunk_start:chunk_start + 20]
        params = {
            'symbol': symbol,
            'type': ','.join(chunk),
            'period1': start_ts,
            'period2': now_ts,
            'merge': 'false',
            'padTimeSeries': 'true',
            'lang': 'en-US',
            'region': 'US',
        }
        url = _YAHOO_URL.format(symbol=symbol)

        resp = _fetch_via_yf_session(ticker, url, params)
        if resp is None:
            fetch_errors += 1
            continue
        status = getattr(resp, 'status_code', None)
        if status is not None and status != 200:
            fetch_errors += 1
            print(f'[fa] Yahoo returned {status} for {symbol} chunk {chunk_start // 20}')
            continue

        try:
            body = resp.json()
        except ValueError:
            fetch_errors += 1
            continue

        results = (body.get('timeseries') or {}).get('result') or []
        for entry in results:
            meta = entry.get('meta') or {}
            types = meta.get('type') or []
            typed_key = types[0] if types else None
            if not typed_key:
                continue

            if typed_key.startswith(prefix):
                field_base = typed_key[len(prefix):]
            else:
                field_base = typed_key

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
                    if raw != raw:
                        continue
                except (TypeError, ValueError):
                    continue
                periods.setdefault(as_of, {})[field_base] = raw

    if not periods:
        print(f'[fa] timeseries returned no data for {symbol} '
              f'({freq}) — errors={fetch_errors}. Falling back to yfinance properties.')

    return periods


# ── Fallback via yfinance DataFrame properties ─────────────────────
#
# If the timeseries endpoint fails (cookies expired, rate limit, some
# symbols just have no timeseries coverage), we fall back to
# yfinance's .income_stmt / .quarterly_income_stmt etc. These only
# return 4–5 periods but at least we always show SOMETHING.

# Map our base field names → possible row names in yfinance DataFrames.
# yfinance renames rows across versions so we try several variants.
_YF_FIELD_ALIASES = {
    'TotalRevenue':                               ['TotalRevenue', 'Total Revenue'],
    'CostOfRevenue':                              ['CostOfRevenue', 'Cost Of Revenue'],
    'GrossProfit':                                ['GrossProfit', 'Gross Profit'],
    'ResearchAndDevelopment':                     ['ResearchAndDevelopment', 'Research Development'],
    'SellingGeneralAndAdministration':            ['SellingGeneralAndAdministration', 'Selling General Administrative', 'Selling, General and Administrative'],
    'OtherOperatingExpenses':                     ['OtherOperatingExpenses', 'Other Operating Expenses'],
    'OperatingExpense':                           ['OperatingExpense', 'Operating Expense', 'Total Operating Expenses'],
    'OperatingIncome':                            ['OperatingIncome', 'Operating Income'],
    'InterestIncome':                             ['InterestIncome', 'Interest Income'],
    'InterestExpense':                            ['InterestExpense', 'Interest Expense'],
    'OtherNonOperatingIncomeExpenses':            ['OtherNonOperatingIncomeExpenses', 'Other Non Operating Income Expenses'],
    'PretaxIncome':                               ['PretaxIncome', 'Pretax Income', 'Income Before Tax'],
    'TaxProvision':                               ['TaxProvision', 'Tax Provision', 'Income Tax Expense'],
    'NetIncomeContinuousOperations':              ['NetIncomeContinuousOperations', 'Net Income Continuous Operations'],
    'NetIncome':                                  ['NetIncome', 'Net Income', 'NetIncomeCommonStockholders'],
    'EBIT':                                       ['EBIT'],
    'EBITDA':                                     ['EBITDA', 'NormalizedEBITDA'],
    'BasicEPS':                                   ['BasicEPS', 'Basic EPS'],
    'DilutedEPS':                                 ['DilutedEPS', 'Diluted EPS'],
    'BasicAverageShares':                         ['BasicAverageShares', 'Basic Average Shares'],
    'DilutedAverageShares':                       ['DilutedAverageShares', 'Diluted Average Shares'],
    # Balance sheet
    'CashAndCashEquivalents':                     ['CashAndCashEquivalents', 'Cash And Cash Equivalents'],
    'OtherShortTermInvestments':                  ['OtherShortTermInvestments', 'Other Short Term Investments'],
    'CashCashEquivalentsAndShortTermInvestments': ['CashCashEquivalentsAndShortTermInvestments', 'Cash And Short Term Investments'],
    'Receivables':                                ['Receivables', 'Net Receivables'],
    'Inventory':                                  ['Inventory'],
    'PrepaidAssets':                              ['PrepaidAssets', 'Prepaid Assets'],
    'OtherCurrentAssets':                         ['OtherCurrentAssets', 'Other Current Assets'],
    'CurrentAssets':                              ['CurrentAssets', 'Total Current Assets'],
    'NetPPE':                                     ['NetPPE', 'Net PPE', 'Property Plant Equipment'],
    'Goodwill':                                   ['Goodwill'],
    'OtherIntangibleAssets':                      ['OtherIntangibleAssets', 'Other Intangible Assets'],
    'InvestmentsAndAdvances':                     ['InvestmentsAndAdvances', 'Investments And Advances'],
    'OtherNonCurrentAssets':                      ['OtherNonCurrentAssets', 'Other Non Current Assets'],
    'TotalNonCurrentAssets':                      ['TotalNonCurrentAssets', 'Total Non Current Assets'],
    'TotalAssets':                                ['TotalAssets', 'Total Assets'],
    'AccountsPayable':                            ['AccountsPayable', 'Accounts Payable'],
    'CurrentDebt':                                ['CurrentDebt', 'Current Debt', 'Short Long Term Debt'],
    'CurrentDeferredLiabilities':                 ['CurrentDeferredLiabilities'],
    'OtherCurrentLiabilities':                    ['OtherCurrentLiabilities', 'Other Current Liabilities'],
    'CurrentLiabilities':                         ['CurrentLiabilities', 'Total Current Liabilities'],
    'LongTermDebt':                               ['LongTermDebt', 'Long Term Debt'],
    'NonCurrentDeferredLiabilities':              ['NonCurrentDeferredLiabilities'],
    'OtherNonCurrentLiabilities':                 ['OtherNonCurrentLiabilities', 'Other Non Current Liabilities'],
    'TotalNonCurrentLiabilitiesNetMinorityInterest': ['TotalNonCurrentLiabilitiesNetMinorityInterest'],
    'TotalLiabilitiesNetMinorityInterest':        ['TotalLiabilitiesNetMinorityInterest', 'Total Liab'],
    'CommonStock':                                ['CommonStock', 'Common Stock'],
    'RetainedEarnings':                           ['RetainedEarnings', 'Retained Earnings'],
    'StockholdersEquity':                         ['StockholdersEquity', 'Total Stockholder Equity'],
    'TotalDebt':                                  ['TotalDebt', 'Total Debt'],
    'NetDebt':                                    ['NetDebt', 'Net Debt'],
    'WorkingCapital':                             ['WorkingCapital', 'Working Capital'],
    'ShareIssued':                                ['ShareIssued', 'Share Issued', 'Ordinary Shares Number'],
    # Cash flow
    'NetIncomeFromContinuingOperations':          ['NetIncomeFromContinuingOperations', 'Net Income'],
    'DepreciationAmortizationDepletion':          ['DepreciationAmortizationDepletion', 'Depreciation And Amortization'],
    'StockBasedCompensation':                     ['StockBasedCompensation', 'Stock Based Compensation'],
    'ChangeInWorkingCapital':                     ['ChangeInWorkingCapital', 'Change In Working Capital'],
    'OperatingCashFlow':                          ['OperatingCashFlow', 'Total Cash From Operating Activities'],
    'CapitalExpenditure':                         ['CapitalExpenditure', 'Capital Expenditures'],
    'NetInvestmentPurchaseAndSale':               ['NetInvestmentPurchaseAndSale'],
    'NetBusinessPurchaseAndSale':                 ['NetBusinessPurchaseAndSale'],
    'InvestingCashFlow':                          ['InvestingCashFlow', 'Total Cashflows From Investing Activities'],
    'NetIssuancePaymentsOfDebt':                  ['NetIssuancePaymentsOfDebt', 'Net Borrowings'],
    'RepurchaseOfCapitalStock':                   ['RepurchaseOfCapitalStock', 'Repurchase Of Stock'],
    'IssuanceOfCapitalStock':                     ['IssuanceOfCapitalStock', 'Issuance Of Stock'],
    'CashDividendsPaid':                          ['CashDividendsPaid', 'Dividends Paid'],
    'FinancingCashFlow':                          ['FinancingCashFlow', 'Total Cash From Financing Activities'],
    'ChangesInCash':                              ['ChangesInCash', 'Change In Cash'],
    'EndCashPosition':                            ['EndCashPosition', 'End Cash Position'],
    'FreeCashFlow':                               ['FreeCashFlow', 'Free Cash Flow'],
}


def _fallback_yfinance_properties(ticker: yf.Ticker, freq: str) -> Dict[str, Dict[str, float]]:
    """Fall back to yfinance's convenience DataFrame properties.

    Returns only 4–5 periods but guarantees SOMETHING is returned when
    the timeseries endpoint is unavailable.
    """
    # Attribute access on yfinance Ticker triggers a lazy fetch that can
    # raise if the symbol doesn't exist or the network blips. Isolate
    # each attribute so one failure doesn't kill the others.
    frames = []
    names = (
        ('quarterly_income_stmt', 'quarterly_balance_sheet', 'quarterly_cashflow')
        if freq == 'quarterly'
        else ('income_stmt', 'balance_sheet', 'cashflow')
    )
    for attr in names:
        try:
            frames.append(getattr(ticker, attr, None))
        except Exception as e:
            print(f'[fa] fallback {attr} error: {e}')
            frames.append(None)

    periods: Dict[str, Dict[str, float]] = {}

    for df in frames:
        if df is None:
            continue
        try:
            if df.empty:
                continue
        except Exception:
            continue

        # DataFrame columns are Timestamps, rows are field names
        for base_key, aliases in _YF_FIELD_ALIASES.items():
            row = None
            for alias in aliases:
                if alias in df.index:
                    row = df.loc[alias]
                    break
            if row is None:
                continue

            for col, val in zip(df.columns, row.values):
                try:
                    as_of = col.strftime('%Y-%m-%d')
                except AttributeError:
                    as_of = str(col)
                try:
                    if val is None:
                        continue
                    fv = float(val)
                    if fv != fv:
                        continue
                except (TypeError, ValueError):
                    continue
                periods.setdefault(as_of, {})[base_key] = fv

    return periods


def _build_payload(symbol: str, freq: str) -> dict:
    """Fetch + shape the full FA payload (no FX conversion applied).

    Strategy:
      1. Try Yahoo's fundamentals-timeseries endpoint for deep history
         (10+ years annual, 40+ quarters).
      2. If that returns nothing (cookie expired, rate-limited, some
         symbols just aren't covered), fall back to yfinance's
         DataFrame properties which guarantee 4–5 periods.
      3. Merge: timeseries takes priority; fallback only fills in
         periods the timeseries call missed.
    """
    ticker = yf.Ticker(symbol)

    # Primary: timeseries endpoint (auth'd via yfinance session)
    periods_map = _fetch_timeseries(symbol, freq, _ALL_FIELDS, ticker=ticker)

    # Always also pull yfinance's DataFrame properties — cheap, and
    # the overlap with timeseries is a nice way to validate, plus it
    # fills gaps if the timeseries call partially succeeded.
    fallback_map = _fallback_yfinance_properties(ticker, freq)

    # Merge: timeseries wins on conflicts, fallback fills gaps.
    if not periods_map:
        periods_map = fallback_map
    else:
        for as_of, fields in fallback_map.items():
            merged = periods_map.setdefault(as_of, {})
            for k, v in fields.items():
                merged.setdefault(k, v)

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
        info = ticker.info or {}
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
