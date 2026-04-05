"""ECO — Economic Calendar.

Client-side uses TradingView's ``embed-widget-events``. This module
exposes the supported country list via ``/api/eco/countries``, derived
from the canonical country registry (countries with an ``eco_code``).
"""

from flask import Blueprint, jsonify

from functions._countries import all_with_eco


eco_bp = Blueprint('eco', __name__)


@eco_bp.route('/api/eco/countries')
def countries():
    """Return countries supported by the ECO events widget."""
    return jsonify([
        {'code': c.eco_code, 'label': c.name, 'flag': c.flag}
        for c in all_with_eco()
    ])
