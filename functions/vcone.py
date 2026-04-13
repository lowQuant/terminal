"""VCONE — Volatility Cone.

Compares the historical distribution of realized volatility across
rolling windows (1M, 2M, 3M, 6M, 1Y) against:

  - the **current** realized volatility at each window
  - the **current** implied volatility from options at matched expirations

Historical volatility is computed from daily close-to-close log
returns. For overlapping-window calculations we apply the Hodges &
Tompkins (2002) variance-inflation correction::

    m = 1 / (1 − h/n + (h² − 1) / (3n²))
    vol_adjusted = vol_raw · √m

Where h is the window length and n = T − h + 1 is the number of
distinct subseries in the total sample.

Earnings-day exclusion
──────────────────────
A common bias in realized-vol estimation is that the single-day gap
on earnings release day can dominate the tails of the distribution.
When ``exclude_earnings=true`` we drop the log-return day that
captured the earnings move, based on the release timing:

  - After-hours release (AMC, hour ≥ 12 ET):
        drop the NEXT trading day's return (the gap is in the
        overnight close → next-day close move)

  - Pre-market release (BMO, hour < 12 ET):
        drop the SAME trading day's return (the gap opens that day)

We pull up to 40 historical earnings timestamps via yfinance's
``Ticker.get_earnings_dates()``; the returned index is tz-aware in
America/New_York, so the hour field tells us BMO vs AMC.

Implied Volatility
──────────────────
For each cone window we pick the option expiration with the closest
days-to-expiry (scaled 252/365 to match trading-day windows) and use
the mid of call + put IV at the strike nearest the current price.

Endpoint::

    GET /api/vcone/<symbol>?exchange=&years=5&exclude_earnings=true|false
"""

import math
import traceback
from datetime import datetime, timedelta

import numpy as np
import pandas as pd
import yfinance as yf
from flask import Blueprint, jsonify, request

from exchange_map import to_yfinance_ticker
from functions._utils import cached


vcone_bp = Blueprint('vcone', __name__)


# Rolling windows (trading days) ≈ 1M, 2M, 3M, 6M, 1Y
WINDOWS = [20, 40, 60, 120, 240]
WINDOW_LABELS = {20: '1M', 40: '2M', 60: '3M', 120: '6M', 240: '1Y'}


def hodges_tompkins_factor(h: int, total_obs: int) -> float:
    """Return the multiplicative correction factor for *variance*.

    For the volatility (std), multiply by ``sqrt(factor)``.
    """
    n = total_obs - h + 1
    if n <= 0:
        return 1.0
    denom = 1.0 - (h / n) + (h ** 2 - 1.0) / (3.0 * n ** 2)
    if denom <= 0:
        return 1.0
    return 1.0 / denom


def _get_earnings_exclude_dates(ticker: yf.Ticker, hist_index: pd.DatetimeIndex) -> set:
    """Return the set of trading-day dates (tz-naive, normalized) whose
    log-return should be excluded because it captures an earnings gap.

    Heuristic for BMO vs AMC: hour < 12 ET = BMO, otherwise AMC.
    """
    excludes: set = set()

    try:
        df = ticker.get_earnings_dates(limit=40)
    except Exception as e:
        print(f'[vcone] get_earnings_dates failed: {e}')
        return excludes

    if df is None or df.empty:
        return excludes

    # Normalize history index to tz-naive dates for matching
    if hist_index.tz is not None:
        hist_dates = hist_index.tz_localize(None).normalize()
    else:
        hist_dates = hist_index.normalize()

    for earn_ts in df.index:
        # Earnings timestamp may be tz-aware (NY); pull hour from it.
        if earn_ts.tz is not None:
            hour = earn_ts.hour
            earn_date = earn_ts.tz_localize(None).normalize()
        else:
            hour = earn_ts.hour
            earn_date = earn_ts.normalize()

        # Heuristic: hour < 12 ET = before-market-open release.
        # Any later timestamp (incl. 16:00 AMC, or 12:00 placeholder) →
        # treat as after-hours, gap captured NEXT day.
        is_bmo = hour < 12

        if is_bmo:
            target = earn_date
        else:
            # Find first trading day strictly AFTER earn_date
            future = hist_dates[hist_dates > earn_date]
            if len(future) == 0:
                continue
            target = future[0]

        excludes.add(target)

    return excludes


def _fetch_atm_iv(ticker: yf.Ticker, windows: list, current_price: float) -> dict:
    """For each window, return the mid of call/put ATM implied vol
    at the option expiration closest to that number of trading days."""
    result = {w: None for w in windows}

    if not current_price or current_price <= 0:
        return result

    try:
        expirations = list(ticker.options or [])
    except Exception as e:
        print(f'[vcone] options list failed: {e}')
        return result
    if not expirations:
        return result

    today = datetime.now().date()

    # Parse expirations into (string, trading_days_out)
    exp_info = []
    for e in expirations:
        try:
            d = datetime.strptime(e, '%Y-%m-%d').date()
            cal_days = (d - today).days
            if cal_days < 0:
                continue
            td_days = cal_days * 252.0 / 365.0
            exp_info.append((e, td_days))
        except ValueError:
            continue

    if not exp_info:
        return result

    # Cache option_chain calls within a request — each call is
    # expensive and a cone might pick the same expiration twice.
    chain_cache: dict = {}

    def get_chain(exp_str):
        if exp_str in chain_cache:
            return chain_cache[exp_str]
        try:
            chain_cache[exp_str] = ticker.option_chain(exp_str)
        except Exception as e:
            print(f'[vcone] option_chain {exp_str} failed: {e}')
            chain_cache[exp_str] = None
        return chain_cache[exp_str]

    for w in windows:
        best = min(exp_info, key=lambda x: abs(x[1] - w))
        exp_str, _ = best
        chain = get_chain(exp_str)
        if chain is None:
            continue

        try:
            calls = chain.calls
            puts = chain.puts
        except AttributeError:
            continue
        if calls is None or puts is None or calls.empty or puts.empty:
            continue

        try:
            atm_call_idx = (calls['strike'] - current_price).abs().idxmin()
            atm_put_idx = (puts['strike'] - current_price).abs().idxmin()
            call_iv = float(calls.loc[atm_call_idx, 'impliedVolatility'] or 0)
            put_iv = float(puts.loc[atm_put_idx, 'impliedVolatility'] or 0)
            vals = [v for v in (call_iv, put_iv) if v > 0 and not math.isnan(v)]
            if vals:
                result[w] = sum(vals) / len(vals)
        except (KeyError, ValueError, TypeError):
            continue

    return result


def _compute_cone(yf_ticker: str, years: int, exclude_earnings: bool) -> dict:
    t = yf.Ticker(yf_ticker)

    end_date = datetime.now()
    start_date = end_date - timedelta(days=int(years * 365.25))

    try:
        hist = t.history(
            start=start_date.strftime('%Y-%m-%d'),
            end=end_date.strftime('%Y-%m-%d'),
            auto_adjust=False,
        )
    except Exception as e:
        print(f'[vcone] history fetch failed: {e}')
        return None

    if hist is None or hist.empty or 'Close' not in hist.columns:
        return None

    close = hist['Close'].dropna()
    if len(close) < max(WINDOWS) + 1:
        return None

    log_ret_all = np.log(close / close.shift(1)).dropna()

    # Earnings exclusion
    excluded_count = 0
    excluded_dates = []
    if exclude_earnings:
        exc = _get_earnings_exclude_dates(t, log_ret_all.index)
        if exc:
            if log_ret_all.index.tz is not None:
                idx_dates = log_ret_all.index.tz_localize(None).normalize()
            else:
                idx_dates = log_ret_all.index.normalize()
            mask = idx_dates.isin(list(exc))
            excluded_count = int(mask.sum())
            excluded_dates = sorted([d.strftime('%Y-%m-%d') for d in exc])
            log_ret = log_ret_all[~mask]
        else:
            log_ret = log_ret_all
    else:
        log_ret = log_ret_all

    total_obs = len(log_ret)
    if total_obs < max(WINDOWS) + 1:
        return None

    # Build cone stats
    cone = []
    for w in WINDOWS:
        ht_vol = math.sqrt(hodges_tompkins_factor(w, total_obs))
        rolling = log_ret.rolling(window=w).std().dropna() * math.sqrt(252) * ht_vol
        if len(rolling) == 0:
            cone.append({
                'window': w, 'label': WINDOW_LABELS[w],
                'min': None, 'q1': None, 'median': None, 'q3': None, 'max': None,
                'current': None,
            })
            continue
        cone.append({
            'window': w,
            'label': WINDOW_LABELS[w],
            'min': float(rolling.min()),
            'q1': float(np.percentile(rolling, 25)),
            'median': float(np.percentile(rolling, 50)),
            'q3': float(np.percentile(rolling, 75)),
            'max': float(rolling.max()),
            'current': float(rolling.iloc[-1]),
        })

    # Info + IV
    info = {}
    try:
        info = t.info or {}
    except Exception:
        info = {}

    current_price = (
        info.get('currentPrice')
        or info.get('regularMarketPrice')
        or info.get('previousClose')
    )

    iv_by_window = _fetch_atm_iv(t, WINDOWS, float(current_price) if current_price else 0.0)
    for entry in cone:
        entry['iv'] = iv_by_window.get(entry['window'])

    return {
        'symbol': yf_ticker.upper(),
        'companyName': info.get('longName') or info.get('shortName') or yf_ticker,
        'currency': (info.get('currency') or 'USD').upper(),
        'windows': WINDOWS,
        'cone': cone,
        'excludeEarnings': exclude_earnings,
        'earningsExcluded': excluded_count,
        'earningsExcludedDates': excluded_dates[-12:] if excluded_dates else [],
        'totalObservations': total_obs,
        'rawObservations': int(len(log_ret_all)),
        'years': years,
        'startDate': hist.index[0].strftime('%Y-%m-%d'),
        'endDate': hist.index[-1].strftime('%Y-%m-%d'),
        'currentPrice': float(current_price) if current_price else None,
    }


@vcone_bp.route('/api/vcone/<symbol>')
def api_vcone(symbol):
    exchange = (request.args.get('exchange') or '').strip()
    exclude_earnings = (request.args.get('exclude_earnings') or 'true').strip().lower() == 'true'

    try:
        years = int(request.args.get('years') or 5)
    except ValueError:
        years = 5
    years = max(1, min(years, 10))

    try:
        def fetch():
            yf_ticker = to_yfinance_ticker(exchange, symbol) if exchange else symbol
            return _compute_cone(yf_ticker, years=years, exclude_earnings=exclude_earnings)

        cache_key = f'vcone_{exchange}_{symbol}_{years}_{int(exclude_earnings)}'
        data = cached(cache_key, fetch)
        if data is None:
            return jsonify({'error': f'Could not fetch history or insufficient data for {symbol}'}), 404
        return jsonify(data)

    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500
