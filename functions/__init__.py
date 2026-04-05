"""Terminal function modules.

Each function (ECO, EVTS, CMDTY, …) has its own module here and
exposes a Flask Blueprint. ``server.py`` imports and registers them
all, so adding a new function is just dropping a module and appending
its blueprint to ``ALL_BLUEPRINTS``.
"""

from functions.eco import eco_bp
from functions.evts import evts_bp


# Blueprints that server.py registers on the Flask app.
ALL_BLUEPRINTS = [
    eco_bp,
    evts_bp,
]


__all__ = ['ALL_BLUEPRINTS', 'eco_bp', 'evts_bp']
