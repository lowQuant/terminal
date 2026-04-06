"""FX — Foreign Exchange Rate Cache.

Fetches daily reference rates from the ECB (EUR-based) and builds a
cross-rate matrix so any currency pair can be converted.

Data source: European Central Bank daily XML feed — free, no API key,
updated ~16:00 CET each business day.
    https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml

The cache is updated at most once per hour (rates don't change
intraday). All conversions go through EUR as the pivot:

    amount_in_B = amount_in_A * (EUR_per_A) * (B_per_EUR)
                = amount_in_A * (rate_B / rate_A)

where rate_X = how many units of X per 1 EUR.

Usage from other modules::

    from functions.fx import convert, get_rate, get_rates
    usd_value = convert(1_000_000, 'JPY', 'USD')
    rate = get_rate('JPY', 'USD')  # 1 JPY = ? USD

Frontend endpoint::

    GET /api/fx/rates          → full rate table (EUR-based)
    GET /api/fx/convert?from=JPY&to=USD&amount=1000000
"""

import xml.etree.ElementTree as ET
import urllib.request
import time
import traceback

from flask import Blueprint, jsonify, request


fx_bp = Blueprint('fx', __name__)


ECB_DAILY_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml'
ECB_NS = {'ecb': 'http://www.ecb.int/vocabulary/2002-08-01/euref'}

_cache = {
    'rates': {},       # currency → float (units per 1 EUR). EUR itself = 1.0
    'ts': 0,           # last successful fetch timestamp
}
_CACHE_TTL = 3600      # 1 hour


def _fetch_ecb_rates() -> dict:
    """Fetch the latest daily EUR reference rates from the ECB XML feed."""
    req = urllib.request.Request(ECB_DAILY_URL, headers={
        'User-Agent': 'Terminal/1.0',
        'Accept': 'application/xml',
    })
    with urllib.request.urlopen(req, timeout=10) as resp:
        xml_bytes = resp.read()

    root = ET.fromstring(xml_bytes)
    # Structure: <Cube><Cube time="2026-04-06"><Cube currency="USD" rate="1.0856"/>...
    rates = {'EUR': 1.0}
    for cube in root.iter():
        currency = cube.attrib.get('currency')
        rate = cube.attrib.get('rate')
        if currency and rate:
            try:
                rates[currency] = float(rate)
            except ValueError:
                pass
    return rates


def _ensure_rates():
    """Refresh the rate cache if stale."""
    now = time.time()
    if _cache['rates'] and now - _cache['ts'] < _CACHE_TTL:
        return
    try:
        _cache['rates'] = _fetch_ecb_rates()
        _cache['ts'] = now
        print(f'[fx] Refreshed ECB rates: {len(_cache["rates"])} currencies')
    except Exception as e:
        print(f'[fx] ECB fetch failed: {e}')
        if not _cache['rates']:
            # Seed with a minimal fallback so the app doesn't crash
            _cache['rates'] = {'EUR': 1.0, 'USD': 1.10}
            _cache['ts'] = now


# ═════════════════════════════════════════
# Public API (Python)
# ═════════════════════════════════════════

def get_rates() -> dict:
    """Return the full EUR-based rate table {currency: rate}."""
    _ensure_rates()
    return dict(_cache['rates'])


def get_rate(from_ccy: str, to_ccy: str) -> float:
    """Return the exchange rate: 1 unit of from_ccy = ? units of to_ccy."""
    _ensure_rates()
    rates = _cache['rates']
    from_ccy = from_ccy.upper()
    to_ccy = to_ccy.upper()
    if from_ccy == to_ccy:
        return 1.0
    rate_from = rates.get(from_ccy)
    rate_to = rates.get(to_ccy)
    if rate_from is None or rate_to is None:
        return 1.0  # unknown pair — no conversion
    # Both are "per 1 EUR": to go from A→B = rate_B / rate_A
    return rate_to / rate_from


def convert(amount: float, from_ccy: str, to_ccy: str) -> float:
    """Convert an amount from one currency to another."""
    return amount * get_rate(from_ccy, to_ccy)


# ═════════════════════════════════════════
# Flask endpoints
# ═════════════════════════════════════════

@fx_bp.route('/api/fx/rates')
def api_rates():
    """Return the full EUR-based rate table + timestamp."""
    try:
        rates = get_rates()
        return jsonify({
            'base': 'EUR',
            'rates': rates,
            'count': len(rates),
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@fx_bp.route('/api/fx/convert')
def api_convert():
    """Convert an amount between currencies.

    Query params: from, to, amount (default 1)
    """
    from_ccy = (request.args.get('from') or 'EUR').upper()
    to_ccy = (request.args.get('to') or 'USD').upper()
    try:
        amount = float(request.args.get('amount', 1))
    except (ValueError, TypeError):
        amount = 1.0

    try:
        rate = get_rate(from_ccy, to_ccy)
        result = amount * rate
        return jsonify({
            'from': from_ccy,
            'to': to_ccy,
            'amount': amount,
            'rate': rate,
            'result': result,
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500
