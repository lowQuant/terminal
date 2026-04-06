"""EQS — Equity Screener.

Phase 1 uses TradingView's embed-widget-screener client-side. This
module exposes a config endpoint and will host the Phase 2 custom
scanner-API backend when needed.
"""

from flask import Blueprint, jsonify

from functions._countries import all_with_scanner, to_json


eqs_bp = Blueprint('eqs', __name__)


@eqs_bp.route('/api/eqs/markets')
def markets():
    """Return markets available for the equity screener."""
    countries = all_with_scanner()
    return jsonify([
        {'code': c.code, 'name': c.name, 'flag': c.flag,
         'region': c.region, 'tv_scanner': c.tv_scanner}
        for c in countries
    ])
