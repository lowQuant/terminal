"""Watchlist enrichment API — batch quotes, relative volume, earnings & news heat."""

from flask import Blueprint, jsonify, request
import yfinance as yf
from datetime import datetime, timedelta
import math
import traceback

from exchange_map import to_yfinance_ticker

watchlist_bp = Blueprint('watchlist', __name__)


def _safe_float(val):
    """Convert to float, returning None for NaN/None."""
    if val is None:
        return None
    try:
        f = float(val)
        return None if math.isnan(f) else f
    except (TypeError, ValueError):
        return None


def _safe_int(val):
    if val is None:
        return None
    try:
        i = int(float(val))
        return i
    except (TypeError, ValueError):
        return None


@watchlist_bp.route('/api/watchlist/quotes')
def batch_quotes():
    """
    Return basic quote data for a list of tickers.
    Uses fast_info only for speed.

    Query params:
      tickers    — comma-separated raw tickers (e.g. AAPL,6146,ASML)
      exchanges  — optional comma-separated parallel list of internal
                   exchange keys (e.g. NASDAQ,TSE,EURONEXT_AMS). When
                   provided, each ticker is suffixed via
                   to_yfinance_ticker() so international symbols resolve
                   correctly (6146 → 6146.T, ASML → ASML.AS, etc.).
                   Missing / empty entries fall back to the raw ticker.

    The response echoes the ORIGINAL raw ticker in each quote's "symbol"
    field so the frontend can match rows by the same key it sent.
    """
    tickers_raw = request.args.get('tickers', '')
    exchanges_raw = request.args.get('exchanges', '')
    if not tickers_raw:
        return jsonify({'error': 'No tickers provided', 'quotes': []})

    tickers = [t.strip().upper() for t in tickers_raw.split(',') if t.strip()]
    if not tickers:
        return jsonify({'error': 'No valid tickers', 'quotes': []})

    # Parallel list; pad to tickers length so zip() is safe even when
    # the caller omits exchanges or sends a shorter list.
    exchanges = [e.strip().upper() for e in exchanges_raw.split(',')] if exchanges_raw else []
    while len(exchanges) < len(tickers):
        exchanges.append('')

    results = []

    for symbol, exchange in zip(tickers, exchanges):
        try:
            yf_symbol = to_yfinance_ticker(exchange, symbol) if exchange else symbol
            tkr = yf.Ticker(yf_symbol)
            info = tkr.fast_info

            last = _safe_float(getattr(info, 'last_price', None))
            prev_close = _safe_float(getattr(info, 'previous_close', None))

            change = None
            change_pct = None
            if last is not None and prev_close is not None and prev_close != 0:
                change = round(last - prev_close, 2)
                change_pct = round((change / prev_close) * 100, 2)

            volume = _safe_int(getattr(info, 'last_volume', None))
            market_cap = _safe_int(getattr(info, 'market_cap', None))

            # Average volume from fast_info (3-month average)
            avg_volume = None
            try:
                avg_volume = _safe_int(getattr(info, 'three_month_average_volume', None))
            except Exception:
                pass

            # Relative volume
            rel_vol = None
            if volume and avg_volume and avg_volume > 0:
                rel_vol = round(volume / avg_volume, 2)

            results.append({
                'symbol': symbol,
                'last': last,
                'change': change,
                'changePct': change_pct,
                'volume': volume,
                'avgVolume': avg_volume,
                'relativeVolume': rel_vol,
                'marketCap': market_cap,
                # Enrichment fields — will be populated by /api/watchlist/enrich
                'earningsDate': None,
                'earningsUpcoming': False,
                'earningsPublished': False,
                'newsHeat': 'low',
            })
        except Exception as e:
            traceback.print_exc()
            results.append({
                'symbol': symbol,
                'last': None,
                'change': None,
                'changePct': None,
                'volume': None,
                'avgVolume': None,
                'relativeVolume': None,
                'marketCap': None,
                'earningsDate': None,
                'earningsUpcoming': False,
                'earningsPublished': False,
                'newsHeat': 'low',
                'error': str(e),
            })

    return jsonify({'quotes': results})


@watchlist_bp.route('/api/watchlist/enrich/<symbol>')
def enrich_ticker(symbol):
    """
    Return expensive enrichment data for a single ticker:
    earnings dates and news heat. Called lazily per-ticker.
    """
    symbol = symbol.strip().upper()
    now = datetime.now()

    result = {
        'symbol': symbol,
        'earningsDate': None,
        'earningsUpcoming': False,
        'earningsPublished': False,
        'newsHeat': 'low',
    }

    try:
        tkr = yf.Ticker(symbol)

        # Earnings info
        try:
            cal = tkr.calendar
            if cal is not None and not (hasattr(cal, 'empty') and cal.empty):
                if isinstance(cal, dict):
                    ed = cal.get('Earnings Date', [])
                    ed_val = ed[0] if isinstance(ed, list) and len(ed) > 0 else ed
                else:
                    try:
                        ed_val = cal.loc['Earnings Date'].iloc[0] if 'Earnings Date' in cal.index else None
                    except Exception:
                        ed_val = None

                if ed_val is not None:
                    if hasattr(ed_val, 'date'):
                        ed_date = ed_val.date() if callable(ed_val.date) else ed_val.date
                    elif isinstance(ed_val, str):
                        ed_date = datetime.strptime(ed_val[:10], '%Y-%m-%d').date()
                    else:
                        ed_date = None

                    if ed_date:
                        result['earningsDate'] = str(ed_date)
                        today = now.date()
                        delta = (ed_date - today).days
                        if delta == 0:
                            result['earningsUpcoming'] = True
                        elif -3 <= delta < 0:
                            result['earningsPublished'] = True
                        elif 0 < delta <= 7:
                            result['earningsUpcoming'] = True
        except Exception:
            pass

        # News heat
        try:
            news = tkr.news
            if news:
                recent_cutoff = now.timestamp() - 86400  # 24 hours
                recent = [n for n in news if n.get('providerPublishTime', 0) > recent_cutoff]
                count = len(recent)
                if count >= 5:
                    result['newsHeat'] = 'high'
                elif count >= 2:
                    result['newsHeat'] = 'medium'
        except Exception:
            pass

    except Exception:
        traceback.print_exc()

    return jsonify(result)
