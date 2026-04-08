"""Terminal function modules.

Each function (ECO, EVTS, CMDTY, …) has its own module here and
exposes a Flask Blueprint. ``server.py`` imports and registers them
all, so adding a new function is just dropping a module and appending
its blueprint to ``ALL_BLUEPRINTS``.

The country registry (``_countries.py``) is the single source of truth
for all country metadata. A shared ``/api/countries`` endpoint exposes
the full list so the frontend never needs its own country definitions.
"""

from flask import Blueprint, jsonify

from functions.eco import eco_bp
from functions.evts import evts_bp
from functions.fx import fx_bp
from functions.most import most_bp
from functions.mov import mov_bp
from functions.eqs import eqs_bp
from functions.omon import omon_bp
from functions.watchlist import watchlist_bp
from functions._countries import COUNTRIES, all_with_eco, all_with_scanner, to_json

# ── Shared countries endpoint ──
_shared_bp = Blueprint('shared', __name__)


@_shared_bp.route('/api/countries')
def list_countries():
    """Full country registry for the frontend."""
    return jsonify(to_json())


@_shared_bp.route('/api/countries/eco')
def list_eco_countries():
    """Countries supported by the ECO events widget."""
    return jsonify(to_json(all_with_eco()))


@_shared_bp.route('/api/countries/scanner')
def list_scanner_countries():
    """Countries queryable via the TradingView scanner (for EVTS etc.)."""
    return jsonify(to_json(all_with_scanner()))


# Blueprints that server.py registers on the Flask app.
ALL_BLUEPRINTS = [
    _shared_bp,
    eco_bp,
    evts_bp,
    fx_bp,
    most_bp,
    mov_bp,
    eqs_bp,
    omon_bp,
    watchlist_bp,
]


__all__ = ['ALL_BLUEPRINTS', 'eco_bp', 'evts_bp']
