"""EVTS — Corporate Events (Earnings Calendar).

Data sources
============

US
    NASDAQ's free public earnings API. Returns every US-listed company
    reporting on each requested day, no API key.

EU / JP / HK / … (any non-US region)
    Universe is built dynamically from TradingView's scanner API
    (``functions._tv_scanner``): we pull the top primary-listed stocks
    per country sorted by market cap, then poll ``yfinance.Ticker.calendar``
    across that universe in parallel. Scanner responses are cached
    for 24h; earnings responses for 30min.

Each regional request merges several scanner countries (e.g. EU ⊂
germany, france, netherlands, italy, spain, switzerland, belgium,
denmark, sweden, finland, norway, uk), so adding a new country to a
region is a one-line change.
"""

import json
import traceback
import urllib.request
from datetime import date, timedelta
from concurrent.futures import ThreadPoolExecutor

import yfinance as yf
from flask import Blueprint, jsonify, request

from functions._utils import cached
from functions._tv_scanner import fetch_aggregated_universe, fetch_country_universe


evts_bp = Blueprint('evts', __name__)


# ═════════════════════════════════════════
# Region configuration
# ═════════════════════════════════════════
#
# Each EVTS country/region maps to a list of TradingView scanner
# country slugs. ``US`` is special-cased to use the NASDAQ API for
# full daily coverage; everything else is scanner-driven.

REGIONS = {
    'US': {
        'nasdaq_api': True,
        'countries':  ['america'],
        'per_country': 250,
        'total_cap':   250,
    },
    'EU': {
        'nasdaq_api': False,
        'countries':  [
            'germany', 'france', 'netherlands', 'italy', 'spain',
            'switzerland', 'belgium', 'denmark', 'sweden', 'finland',
            'norway', 'uk', 'ireland', 'austria', 'portugal',
        ],
        'per_country': 50,
        'total_cap':   300,
    },
    'JP': {
        'nasdaq_api': False,
        'countries':  ['japan'],
        'per_country': 200,
        'total_cap':   200,
    },
    'HK': {
        'nasdaq_api': False,
        'countries':  ['hongkong'],
        'per_country': 150,
        'total_cap':   150,
    },
}


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
    """Fetch earnings for a single day from NASDAQ's public API."""
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
            'country':        'US',
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
# Non-US path — TV scanner universe + yfinance earnings
# ═════════════════════════════════════════

def _get_regional_universe(country_code):
    """Fetch (and cache for 24h) the Yahoo-formatted ticker universe for a region."""
    config = REGIONS.get(country_code)
    if not config:
        return []

    def fetch():
        if len(config['countries']) == 1:
            rows = fetch_country_universe(
                config['countries'][0],
                top_n=config['per_country'],
            )
        else:
            rows = fetch_aggregated_universe(
                config['countries'],
                per_country=config['per_country'],
                total_cap=config['total_cap'],
            )
        return rows

    try:
        # 24h TTL — index constituents barely change day-to-day
        return cached(f'tv_scanner_universe_{country_code}', fetch, ttl=86400)
    except Exception as e:
        print(f'[evts] scanner universe fetch failed for {country_code}: {e}')
        return []


def _fetch_one_yf_earnings(universe_entry, country, cutoff_date):
    """Pull the next upcoming earnings event for a single scanner entry."""
    ticker = universe_entry['yahoo_ticker']
    try:
        t = yf.Ticker(ticker)
        cal = t.calendar
        if not cal or not isinstance(cal, dict):
            return None

        earnings_dates = cal.get('Earnings Date') or []
        if not earnings_dates:
            return None

        today = date.today()
        future = [d for d in earnings_dates
                  if isinstance(d, date) and today <= d <= cutoff_date]
        if not future:
            return None

        def _num(k):
            v = cal.get(k)
            if v is None:
                return None
            try:
                return float(v)
            except (TypeError, ValueError):
                return None

        last_year_eps = None
        try:
            info = t.info or {}
            trailing = info.get('trailingEps')
            if trailing is not None:
                last_year_eps = float(trailing)
        except Exception:
            pass

        return {
            'date':           min(future).isoformat(),
            'ticker':         ticker,
            'tv_symbol':      universe_entry.get('tv_symbol'),
            'name':           universe_entry.get('name') or ticker,
            'eps_estimate':   _num('Earnings Average'),
            'last_year_eps':  last_year_eps,
            'market_cap':     universe_entry.get('market_cap'),
            'num_estimates':  None,
            'time':           '',
            'fiscal_quarter': '',
            'country':        country,
        }
    except Exception:
        return None


def _fetch_regional_earnings(country, days):
    universe = _get_regional_universe(country)
    if not universe:
        return []
    cutoff = date.today() + timedelta(days=days)
    results = []
    with ThreadPoolExecutor(max_workers=20) as ex:
        futures = [ex.submit(_fetch_one_yf_earnings, entry, country, cutoff)
                   for entry in universe]
        for f in futures:
            r = f.result()
            if r:
                results.append(r)
    return results


# ═════════════════════════════════════════
# Route
# ═════════════════════════════════════════

@evts_bp.route('/api/earnings-calendar')
def earnings_calendar():
    """Return upcoming earnings for the selected country within `days`.

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

    config = REGIONS.get(country)
    if not config:
        return jsonify({'error': f'Unsupported country: {country}'}), 400

    def fetch():
        if config['nasdaq_api']:
            rows = _fetch_us_earnings(days)
        else:
            rows = _fetch_regional_earnings(country, days)
        rows.sort(key=lambda r: (r['date'], -(r.get('market_cap') or 0), r['ticker']))
        return rows

    try:
        data = cached(f'earnings_{country}_{days}', fetch, ttl=1800)   # 30-min cache
        return jsonify({
            'rows':    data,
            'source':  'NASDAQ' if config['nasdaq_api'] else 'TradingView + yfinance',
            'country': country,
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500
