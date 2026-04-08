"""OMON / OVOL — Options Monitor & Options Volatility.

Provides endpoints for:
    GET /api/omon/expirations/<symbol>   — available expiration dates
    GET /api/omon/chain/<symbol>         — full options chain for one expiry
    GET /api/omon/volatility/<symbol>    — IV-vs-strike data for all/selected expiries

Data comes from yfinance.  Greeks (delta) are computed server-side via
Black-Scholes using the implied-volatility that Yahoo already provides.
"""

from flask import Blueprint, jsonify, request
import yfinance as yf
import math
import numpy as np
import traceback
from datetime import datetime

from functions._utils import cached

omon_bp = Blueprint('omon', __name__)

# ── Risk-free rate assumption (US 10Y proxy) ──
RISK_FREE_RATE = 0.043


# ═══════════════════════════════════════
# BLACK-SCHOLES GREEKS
# ═══════════════════════════════════════

def _norm_cdf(x):
    """Standard normal CDF using math.erf (stdlib)."""
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def _norm_pdf(x):
    """Standard normal PDF."""
    return math.exp(-0.5 * x * x) / math.sqrt(2.0 * math.pi)


def _d1(S, K, T, r, sigma):
    if T <= 0 or sigma <= 0 or S <= 0 or K <= 0:
        return 0.0
    return (math.log(S / K) + (r + 0.5 * sigma ** 2) * T) / (sigma * math.sqrt(T))


def _d2(S, K, T, r, sigma):
    return _d1(S, K, T, r, sigma) - sigma * np.sqrt(T)


def bs_delta(S, K, T, r, sigma, option_type='call'):
    """Black-Scholes delta."""
    if T <= 0 or sigma <= 0:
        if option_type == 'call':
            return 1.0 if S > K else 0.0
        else:
            return -1.0 if S < K else 0.0
    d1 = _d1(S, K, T, r, sigma)
    if option_type == 'call':
        return float(_norm_cdf(d1))
    else:
        return float(_norm_cdf(d1) - 1.0)


def bs_gamma(S, K, T, r, sigma):
    """Black-Scholes gamma (same for calls and puts)."""
    if T <= 0 or sigma <= 0 or S <= 0:
        return 0.0
    d1 = _d1(S, K, T, r, sigma)
    return float(_norm_pdf(d1) / (S * sigma * math.sqrt(T)))


def bs_theta(S, K, T, r, sigma, option_type='call'):
    """Black-Scholes theta (per-day)."""
    if T <= 0 or sigma <= 0:
        return 0.0
    d1 = _d1(S, K, T, r, sigma)
    d2 = d1 - sigma * math.sqrt(T)
    common = -(S * _norm_pdf(d1) * sigma) / (2.0 * math.sqrt(T))
    if option_type == 'call':
        theta_annual = common - r * K * math.exp(-r * T) * _norm_cdf(d2)
    else:
        theta_annual = common + r * K * math.exp(-r * T) * _norm_cdf(-d2)
    return float(theta_annual / 365.0)  # per-day


def bs_vega(S, K, T, r, sigma):
    """Black-Scholes vega (per 1% move in IV)."""
    if T <= 0 or sigma <= 0:
        return 0.0
    d1 = _d1(S, K, T, r, sigma)
    return float(S * _norm_pdf(d1) * math.sqrt(T) / 100.0)


def _years_to_expiry(expiry_str):
    """Convert 'YYYY-MM-DD' to fractional years from now."""
    exp = datetime.strptime(expiry_str, '%Y-%m-%d')
    now = datetime.now()
    delta = (exp - now).total_seconds()
    if delta <= 0:
        return 0.0
    return delta / (365.25 * 24 * 3600)


# ═══════════════════════════════════════
# HELPERS
# ═══════════════════════════════════════

def _resolve_ticker(symbol, exchange):
    """Resolve to a yfinance-compatible ticker."""
    if exchange:
        try:
            from exchange_map import to_yfinance_ticker
            return to_yfinance_ticker(exchange, symbol)
        except Exception:
            pass
    return symbol


def _row_to_dict(row, underlying_price, T, option_type):
    """Convert a pandas row to a JSON-safe dict with Greeks."""
    strike = float(row.get('strike', 0))
    iv = float(row.get('impliedVolatility', 0))
    itm = bool(row.get('inTheMoney', False))

    # Compute delta
    delta = bs_delta(underlying_price, strike, T, RISK_FREE_RATE, iv, option_type)
    gamma = bs_gamma(underlying_price, strike, T, RISK_FREE_RATE, iv)
    theta = bs_theta(underlying_price, strike, T, RISK_FREE_RATE, iv, option_type)
    vega = bs_vega(underlying_price, strike, T, RISK_FREE_RATE, iv)

    def safe_float(val, decimals=2):
        try:
            v = float(val)
            return None if np.isnan(v) else round(v, decimals)
        except (TypeError, ValueError):
            return None

    return {
        'strike': round(strike, 2),
        'lastPrice': safe_float(row.get('lastPrice')),
        'change': safe_float(row.get('change')),
        'percentChange': safe_float(row.get('percentChange')),
        'bid': safe_float(row.get('bid')),
        'ask': safe_float(row.get('ask')),
        'volume': safe_float(row.get('volume'), 0),
        'openInterest': safe_float(row.get('openInterest'), 0),
        'impliedVolatility': round(iv * 100, 1) if iv else None,  # as percentage
        'inTheMoney': itm,
        'delta': round(delta, 4),
        'gamma': round(gamma, 4),
        'theta': round(theta, 4),
        'vega': round(vega, 4),
    }


# ═══════════════════════════════════════
# ENDPOINTS
# ═══════════════════════════════════════

@omon_bp.route('/api/omon/expirations/<symbol>')
def get_expirations(symbol):
    """Return available expiration dates for a symbol."""
    exchange = request.args.get('exchange', '').strip()

    try:
        def fetch():
            yf_ticker = _resolve_ticker(symbol, exchange)
            t = yf.Ticker(yf_ticker)
            expirations = t.options
            if not expirations:
                return {'expirations': [], 'error': 'No options data available'}

            # Format nicely
            items = []
            now = datetime.now()
            for exp_str in expirations:
                exp_date = datetime.strptime(exp_str, '%Y-%m-%d')
                days = (exp_date - now).days
                items.append({
                    'date': exp_str,
                    'days': max(days, 0),
                    'label': exp_date.strftime('%b %d'),
                })

            return {'expirations': items}

        cache_key = f'omon_exp_{exchange}_{symbol}'
        data = cached(cache_key, fetch, ttl=300)
        return jsonify(data)

    except Exception as e:
        traceback.print_exc()
        return jsonify({'expirations': [], 'error': str(e)}), 500


@omon_bp.route('/api/omon/chain/<symbol>')
def get_chain(symbol):
    """Return options chain (calls + puts) for a specific expiration."""
    exchange = request.args.get('exchange', '').strip()
    expiration = request.args.get('expiration', '').strip()

    if not expiration:
        return jsonify({'error': 'expiration parameter required'}), 400

    try:
        def fetch():
            yf_ticker = _resolve_ticker(symbol, exchange)
            t = yf.Ticker(yf_ticker)

            # Get underlying price
            info = t.info
            underlying_price = (
                info.get('currentPrice')
                or info.get('regularMarketPrice')
                or info.get('previousClose')
                or 0
            )

            chain = t.option_chain(expiration)
            T = _years_to_expiry(expiration)

            calls = [_row_to_dict(row, underlying_price, T, 'call')
                     for _, row in chain.calls.iterrows()]
            puts = [_row_to_dict(row, underlying_price, T, 'put')
                    for _, row in chain.puts.iterrows()]

            # Summary stats
            call_volume = sum(c['volume'] or 0 for c in calls)
            put_volume = sum(p['volume'] or 0 for p in puts)
            call_oi = sum(c['openInterest'] or 0 for c in calls)
            put_oi = sum(p['openInterest'] or 0 for p in puts)

            return {
                'underlyingPrice': round(underlying_price, 2),
                'expiration': expiration,
                'daysToExpiry': max(int((datetime.strptime(expiration, '%Y-%m-%d') - datetime.now()).days), 0),
                'calls': calls,
                'puts': puts,
                'summary': {
                    'callVolume': int(call_volume),
                    'putVolume': int(put_volume),
                    'callOI': int(call_oi),
                    'putOI': int(put_oi),
                    'pcRatio': round(put_volume / call_volume, 2) if call_volume > 0 else None,
                },
            }

        cache_key = f'omon_chain_{exchange}_{symbol}_{expiration}'
        data = cached(cache_key, fetch, ttl=120)  # 2 min cache for chain
        return jsonify(data)

    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@omon_bp.route('/api/omon/volatility/<symbol>')
def get_volatility(symbol):
    """Return IV-vs-strike curves for multiple expirations (for OVOL smile chart)."""
    exchange = request.args.get('exchange', '').strip()
    # Comma-separated list of expirations, or empty for first 4
    exp_param = request.args.get('expirations', '').strip()

    try:
        def fetch():
            yf_ticker = _resolve_ticker(symbol, exchange)
            t = yf.Ticker(yf_ticker)

            all_expirations = t.options
            if not all_expirations:
                return {'curves': [], 'error': 'No options data available'}

            # Pick which expirations to chart
            if exp_param:
                selected = [e for e in exp_param.split(',') if e in all_expirations]
            else:
                selected = list(all_expirations[:4])

            # Get underlying price
            info = t.info
            underlying_price = (
                info.get('currentPrice')
                or info.get('regularMarketPrice')
                or info.get('previousClose')
                or 0
            )

            curves = []
            for exp_str in selected:
                try:
                    chain = t.option_chain(exp_str)
                    days = max((datetime.strptime(exp_str, '%Y-%m-%d') - datetime.now()).days, 0)
                    label = datetime.strptime(exp_str, '%Y-%m-%d').strftime('%b %d')

                    # Combine calls and puts by strike for the smile
                    call_data = {}
                    for _, row in chain.calls.iterrows():
                        s = float(row['strike'])
                        iv = float(row.get('impliedVolatility', 0))
                        v = row.get('volume', 0)
                        o = row.get('openInterest', 0)
                        vol = 0 if (v is None or (isinstance(v, float) and math.isnan(v))) else int(v)
                        oi = 0 if (o is None or (isinstance(o, float) and math.isnan(o))) else int(o)
                        if iv > 0 and not math.isnan(iv):
                            call_data[s] = {'iv': round(iv * 100, 1), 'volume': vol, 'oi': oi}

                    put_data = {}
                    for _, row in chain.puts.iterrows():
                        s = float(row['strike'])
                        iv = float(row.get('impliedVolatility', 0))
                        v = row.get('volume', 0)
                        o = row.get('openInterest', 0)
                        vol = 0 if (v is None or (isinstance(v, float) and math.isnan(v))) else int(v)
                        oi = 0 if (o is None or (isinstance(o, float) and math.isnan(o))) else int(o)
                        if iv > 0 and not math.isnan(iv):
                            put_data[s] = {'iv': round(iv * 100, 1), 'volume': vol, 'oi': oi}

                    # Merge: use call IV for strikes <= ATM, put IV for strikes > ATM
                    all_strikes = sorted(set(list(call_data.keys()) + list(put_data.keys())))
                    points = []
                    for strike in all_strikes:
                        c = call_data.get(strike)
                        p = put_data.get(strike)
                        # Use whichever has more open interest, or average
                        if c and p:
                            # Weight by OI for a smoother curve
                            total_oi = c['oi'] + p['oi']
                            if total_oi > 0:
                                iv = (c['iv'] * c['oi'] + p['iv'] * p['oi']) / total_oi
                            else:
                                iv = (c['iv'] + p['iv']) / 2.0
                        elif c:
                            iv = c['iv']
                        else:
                            iv = p['iv']

                        points.append({
                            'strike': round(strike, 2),
                            'iv': round(iv, 1),
                            'callIV': c['iv'] if c else None,
                            'putIV': p['iv'] if p else None,
                        })

                    curves.append({
                        'expiration': exp_str,
                        'label': f'{label} ({days}d)',
                        'days': days,
                        'points': points,
                    })
                except Exception:
                    traceback.print_exc()
                    continue

            return {
                'underlyingPrice': round(underlying_price, 2),
                'curves': curves,
            }

        cache_key = f'omon_vol_{exchange}_{symbol}_{exp_param}'
        data = cached(cache_key, fetch, ttl=300)
        return jsonify(data)

    except Exception as e:
        traceback.print_exc()
        return jsonify({'curves': [], 'error': str(e)}), 500
