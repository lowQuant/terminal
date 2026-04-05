"""ECO — Economic Calendar.

The frontend renders ECO using TradingView's ``embed-widget-events``
client-side widget, so this module's backend footprint is small:
it publishes the country filter metadata via ``/api/eco/countries``
so the list lives in one place (Python) instead of being duplicated
in JavaScript.

All other ECO functionality (rendering, country toggle, widget
injection) lives in ``app.js`` → ``renderEcoCalendar``.
"""

from flask import Blueprint, jsonify


eco_bp = Blueprint('eco', __name__)


# Country codes here must match those accepted by TradingView's
# events widget ``countryFilter`` parameter (ISO 3166-1 alpha-2,
# lowercase, plus ``eu`` for the Eurozone aggregate).
ECO_COUNTRIES = [
    {'code': 'us', 'label': 'United States',  'flag': '🇺🇸'},
    {'code': 'eu', 'label': 'Eurozone',       'flag': '🇪🇺'},
    {'code': 'gb', 'label': 'United Kingdom', 'flag': '🇬🇧'},
    {'code': 'de', 'label': 'Germany',        'flag': '🇩🇪'},
    {'code': 'fr', 'label': 'France',         'flag': '🇫🇷'},
    {'code': 'it', 'label': 'Italy',          'flag': '🇮🇹'},
    {'code': 'es', 'label': 'Spain',          'flag': '🇪🇸'},
    {'code': 'ch', 'label': 'Switzerland',    'flag': '🇨🇭'},
    {'code': 'jp', 'label': 'Japan',          'flag': '🇯🇵'},
    {'code': 'cn', 'label': 'China',          'flag': '🇨🇳'},
    {'code': 'in', 'label': 'India',          'flag': '🇮🇳'},
    {'code': 'kr', 'label': 'South Korea',    'flag': '🇰🇷'},
    {'code': 'au', 'label': 'Australia',      'flag': '🇦🇺'},
    {'code': 'nz', 'label': 'New Zealand',    'flag': '🇳🇿'},
    {'code': 'ca', 'label': 'Canada',         'flag': '🇨🇦'},
    {'code': 'mx', 'label': 'Mexico',         'flag': '🇲🇽'},
    {'code': 'br', 'label': 'Brazil',         'flag': '🇧🇷'},
    {'code': 'tr', 'label': 'Turkey',         'flag': '🇹🇷'},
    {'code': 'za', 'label': 'South Africa',   'flag': '🇿🇦'},
]


@eco_bp.route('/api/eco/countries')
def countries():
    """Return the supported ECO country filter list."""
    return jsonify(ECO_COUNTRIES)
