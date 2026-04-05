"""Shared helpers for function modules.

Function modules (`functions/<code>.py`) register themselves as Flask
Blueprints on the main app. This module holds utilities they share —
most importantly the in-memory cache used for TTL-based response
caching across endpoints.
"""

import time


# Simple process-local cache keyed by string. Reset on restart.
_cache = {}

CACHE_TTL = 300          # 5 minutes
SEARCH_CACHE_TTL = 60    # 1 minute for search autocomplete results


def cached(key, fetch_fn, ttl=CACHE_TTL, skip_empty=False):
    """Return cached data if still fresh, otherwise fetch and cache.

    Args:
        key:        unique cache key (string)
        fetch_fn:   zero-arg callable returning the data to cache
        ttl:        seconds before the entry is considered stale
        skip_empty: if True and the fetched data is a dict with an
                    empty `candles` list, return it but don't cache
                    (works around transient yfinance empties)
    """
    now = time.time()
    if key in _cache and now - _cache[key]['ts'] < ttl:
        return _cache[key]['data']

    data = fetch_fn()

    if skip_empty and isinstance(data, dict):
        candles = data.get('candles', None)
        if candles is not None and len(candles) == 0:
            return data  # return but don't cache

    _cache[key] = {'data': data, 'ts': now}
    return data
