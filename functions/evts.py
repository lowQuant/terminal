"""EVTS — Corporate Events (Earnings Calendar).

Data sources
============

US
    NASDAQ's free public earnings API (no API key). Returns every US-listed
    company reporting on each requested day — full daily market coverage.

Non-US (EU / JP / HK / any market the scanner supports)
    TradingView's scanner API in a *single call per market*, requesting the
    ``earnings_release_next_date`` column directly. No per-ticker yfinance
    round-trips. The scanner returns the upcoming earnings date alongside
    market cap, EPS estimates, and country info — we just filter to the
    requested date window and return.

Adding a new region is a one-line change in the ``REGIONS`` dict.
"""

import json
import traceback
import urllib.request
from datetime import date, timedelta
from concurrent.futures import ThreadPoolExecutor

from flask import Blueprint, jsonify, request

from functions._utils import cached
from functions._tv_scanner import fetch_earnings_calendar
from functions._countries import region_scanner_slugs


evts_bp = Blueprint('evts', __name__)


# ═════════════════════════════════════════
# Region configuration
# ═════════════════════════════════════════
# US is special-cased to use NASDAQ's API; all other regions are resolved
# dynamically via the country registry (region_scanner_slugs).

NASDAQ_REGION = 'US'


# ═════════════════════════════════════════
# US path — NASDAQ public API
# ═════════════════════════════════════════

NASDAQ_UA = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
                  'AppleWebKit/537.36 (KHTML, like Gecko) '
                  'Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Origin': 'https://www.nasdaq.com',
    'Referer': 'https://www.nasdaq.com/',
}


def _parse_money(s):
    """Parse NASDAQ money strings like '$1,234.56', '$3.4M', '$(0.25)', 'N/A'."""
    if s is None:
        return None
    s = str(s).strip()
    if not s or s.upper() in ('N/A', 'NA', '--', '-'):
        return None
    negative = s.startswith('(') and s.endswith(')')
    s = s.replace('(', '').replace(')', '')
    s = s.replace('$', '').replace(',', '').replace(' ', '')
    if not s:
        return None
    multiplier = 1
    last = s[-1].upper()
    if last in 'KMBT':
        multiplier = {'K': 1e3, 'M': 1e6, 'B': 1e9, 'T': 1e12}[last]
        s = s[:-1]
    try:
        val = float(s) * multiplier
        return -val if negative else val
    except ValueError:
        return None


def _fetch_nasdaq_earnings_day(d):
    url = f'https://api.nasdaq.com/api/calendar/earnings?date={d.isoformat()}'
    try:
        req = urllib.request.Request(url, headers=NASDAQ_UA)
        with urllib.request.urlopen(req, timeout=12) as resp:
            payload = json.loads(resp.read().decode('utf-8'))
    except Exception as e:
        print(f'[evts US] {d} failed: {e}')
        return []

    rows = (payload.get('data') or {}).get('rows') or []
    out = []
    for row in rows:
        symbol = (row.get('symbol') or '').strip()
        if not symbol:
            continue
        out.append({
            'date':           d.isoformat(),
            'ticker':         symbol,
            'name':           (row.get('name') or '').strip(),
            'eps_estimate':   _parse_money(row.get('epsForecast')),
            'last_year_eps':  _parse_money(row.get('lastYearEPS')),
            'market_cap':     _parse_money(row.get('marketCap')),
            'num_estimates':  row.get('noOfEsts'),
            'time':           row.get('time', ''),
            'fiscal_quarter': row.get('fiscalQuarterEnding', ''),
            'country':        'United States',
        })
    return out


def _fetch_us_earnings(days):
    today = date.today()
    dates = [today + timedelta(days=i) for i in range(days)]
    all_rows = []
    with ThreadPoolExecutor(max_workers=10) as ex:
        for day_rows in ex.map(_fetch_nasdaq_earnings_day, dates):
            all_rows.extend(day_rows)
    return all_rows


# ═════════════════════════════════════════
# Route
# ═════════════════════════════════════════

@evts_bp.route('/api/earnings-calendar')
def earnings_calendar():
    """Return upcoming earnings for the selected region within ``days``.

    Query params:
      days    — window size in days (1-45, default 14)
      country — US | EU | JP | HK (default US)
    """
    try:
        days = int(request.args.get('days', 14))
    except ValueError:
        days = 14
    days = max(1, min(days, 45))
    country = (request.args.get('country') or 'US').upper()
    use_nasdaq = (country == NASDAQ_REGION)

    # Resolve scanner slugs from the country registry. This means any
    # country added to _countries.py with a tv_scanner slug is instantly
    # available — no per-function config needed.
    scanner_slugs = region_scanner_slugs(country)
    if not use_nasdaq and not scanner_slugs:
        return jsonify({'error': f'No scanner coverage for: {country}'}), 400

    def fetch():
        if use_nasdaq:
            rows = _fetch_us_earnings(days)
        else:
            rows = fetch_earnings_calendar(
                markets=scanner_slugs,
                days=days,
            )
        rows.sort(key=lambda r: (r['date'], -(r.get('market_cap') or 0)))
        return rows

    try:
        data = cached(f'earnings_{country}_{days}', fetch, ttl=1800)
        return jsonify({
            'rows':    data,
            'source':  'NASDAQ' if use_nasdaq else 'TradingView',
            'country': country,
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500
