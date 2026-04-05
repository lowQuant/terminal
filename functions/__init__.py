"""Terminal function modules.

Each function (ECO, EVTS, CMDTY, …) whose backend needs custom routes
lives in its own module here and exposes a Flask Blueprint. server.py
imports and registers them all, so adding a new function is as simple
as dropping a new module and appending its blueprint to the list
below.

ECO is intentionally absent: it uses TradingView's embed-widget-events
client-side and needs no backend route.
"""

from functions.evts import evts_bp


# Blueprints that server.py registers on the Flask app.
ALL_BLUEPRINTS = [
    evts_bp,
]


__all__ = ['ALL_BLUEPRINTS', 'evts_bp']
