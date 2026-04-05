"""
TERMINAL — Python Backend
Serves yfinance company data, news, OHLCV history, and search.
Also serves the static frontend files.
"""

from flask import Flask, jsonify, request, send_from_directory
import yfinance as yf
import time
import traceback
import urllib.request
import urllib.error
import json
from datetime import datetime, date, timedelta
from concurrent.futures import ThreadPoolExecutor
from exchange_map import (
    to_yfinance_ticker,
    to_tv_symbol,
    is_tv_embed_supported,
    get_exchange_label,
    EXCHANGE_MAP,
)

app = Flask(__name__, static_folder='.', static_url_path='')

# ── Simple in-memory cache ──
_cache = {}
CACHE_TTL = 300  # 5 minutes
SEARCH_CACHE_TTL = 60  # 1 minute for search results


def cached(key, fetch_fn, ttl=CACHE_TTL, skip_empty=False):
    """Return cached data if fresh, otherwise fetch and cache."""
    now = time.time()
    if key in _cache and now - _cache[key]['ts'] < ttl:
        return _cache[key]['data']
    data = fetch_fn()
    # Optionally skip caching empty results (yfinance can return empty transiently)
    if skip_empty and isinstance(data, dict):
        candles = data.get('candles', None)
        if candles is not None and len(candles) == 0:
            return data  # Return but don't cache
    _cache[key] = {'data': data, 'ts': now}
    return data


# ── Static files ──
@app.route('/')
def index():
    return send_from_directory('.', 'index.html')


# ═══════════════════════════════════════
# SEARCH / AUTOCOMPLETE API
# ═══════════════════════════════════════

@app.route('/api/search')
def search():
    """Search for tickers by company name or symbol.
    Returns results with TradingView-compatible symbols.
    """
    query = request.args.get('q', '').strip()
    if not query or len(query) < 1:
        return jsonify([])

    try:
        def fetch():
            results = []
            try:
                search_result = yf.Search(query, enable_fuzzy_query=True)
                quotes = search_result.quotes or []
            except Exception:
                quotes = []

            for q in quotes[:12]:  # Limit to 12 results
                symbol = q.get('symbol', '')
                yahoo_exchange = q.get('exchange', '')
                name = q.get('longname') or q.get('shortname', '')
                quote_type = q.get('quoteType', 'EQUITY')

                if not symbol:
                    continue

                # Map Yahoo exchange → TradingView symbol
                tv_info = to_tv_symbol(yahoo_exchange, symbol)

                results.append({
                    'symbol': symbol,
                    'name': name,
                    'tvSymbol': tv_info['full_symbol'],
                    'tvPrefix': tv_info['tv_prefix'],
                    'ticker': tv_info['ticker'],
                    'exchange': tv_info['label'],
                    'type': quote_type,
                    'tvSupported': tv_info['tv_supported'],
                })

            return results

        data = cached(f'search_{query.lower()}', fetch, ttl=SEARCH_CACHE_TTL)
        return jsonify(data)

    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


# ═══════════════════════════════════════
# COMPANY INFO API
# ═══════════════════════════════════════

@app.route('/api/info/<symbol>')
def get_info(symbol):
    """Return company fundamentals for a single ticker.
    Accepts optional ?exchange= parameter for international stocks.
    """
    exchange = request.args.get('exchange', '').strip()

    try:
        def fetch():
            # Resolve the correct yfinance ticker
            if exchange:
                yf_ticker = to_yfinance_ticker(exchange, symbol)
            else:
                yf_ticker = symbol

            t = yf.Ticker(yf_ticker)
            info = t.info

            # Earnings dates
            next_earnings = None
            last_quarter = None
            try:
                cal = t.calendar
                if isinstance(cal, dict):
                    ed = cal.get('Earnings Date')
                    if ed and len(ed) > 0:
                        next_earnings = str(ed[0])
                elif hasattr(cal, 'iloc'):
                    # DataFrame
                    if 'Earnings Date' in cal.index:
                        val = cal.loc['Earnings Date']
                        if hasattr(val, 'iloc'):
                            next_earnings = str(val.iloc[0])
                        else:
                            next_earnings = str(val)
            except Exception:
                pass

            mq = info.get('mostRecentQuarter')
            if mq:
                # Can be a unix timestamp (int) or a date string
                if isinstance(mq, (int, float)) and mq > 1e9:
                    from datetime import datetime as _dt
                    last_quarter = _dt.fromtimestamp(mq).strftime('%Y-%m-%d')
                else:
                    last_quarter = str(mq)

            return {
                # Identity
                'name': info.get('longName') or info.get('shortName', symbol),
                'symbol': symbol.upper(),
                'exchange': exchange or info.get('exchange', ''),
                'quoteType': info.get('quoteType', ''),

                # Classification
                'sector': info.get('sector', 'N/A'),
                'industry': info.get('industry', 'N/A'),

                # Price
                'currentPrice': info.get('currentPrice') or info.get('regularMarketPrice'),
                'previousClose': info.get('previousClose') or info.get('regularMarketPreviousClose'),
                'currency': info.get('currency', 'USD'),

                # Valuation
                'marketCap': info.get('marketCap'),
                'enterpriseValue': info.get('enterpriseValue'),
                'trailingPE': info.get('trailingPE'),
                'forwardPE': info.get('forwardPE'),
                'pegRatio': info.get('pegRatio'),
                'priceToBook': info.get('priceToBook'),
                'priceToSalesTrailing12Months': info.get('priceToSalesTrailing12Months'),

                # Earnings
                'trailingEps': info.get('trailingEps'),
                'forwardEps': info.get('forwardEps'),
                'nextEarningsDate': next_earnings,
                'lastQuarter': last_quarter,
                'earningsGrowth': info.get('earningsQuarterlyGrowth'),
                'revenueGrowth': info.get('revenueGrowth'),

                # Profitability
                'profitMargins': info.get('profitMargins'),
                'grossMargins': info.get('grossMargins'),
                'operatingMargins': info.get('operatingMargins'),
                'returnOnEquity': info.get('returnOnEquity'),
                'returnOnAssets': info.get('returnOnAssets'),

                # Market data
                'beta': info.get('beta'),
                'fiftyTwoWeekHigh': info.get('fiftyTwoWeekHigh'),
                'fiftyTwoWeekLow': info.get('fiftyTwoWeekLow'),
                'fiftyDayAverage': info.get('fiftyDayAverage'),
                'twoHundredDayAverage': info.get('twoHundredDayAverage'),
                'averageVolume': info.get('averageVolume'),

                # Dividends
                'dividendYield': info.get('dividendYield'),
                'dividendRate': info.get('dividendRate'),
                'payoutRatio': info.get('payoutRatio'),

                # Company
                'description': info.get('longBusinessSummary', ''),
                'website': info.get('website', ''),
                'employees': info.get('fullTimeEmployees'),
                'country': info.get('country', ''),
                'city': info.get('city', ''),
            }

        cache_key = f'info_{exchange}_{symbol}' if exchange else f'info_{symbol}'
        data = cached(cache_key, fetch)
        return jsonify(data)

    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


# ═══════════════════════════════════════
# NEWS API
# ═══════════════════════════════════════

@app.route('/api/news/<symbol>')
def get_news(symbol):
    """Return recent news articles for a ticker.
    Accepts optional ?exchange= parameter for international stocks.
    """
    exchange = request.args.get('exchange', '').strip()

    try:
        def fetch():
            # Resolve the correct yfinance ticker
            if exchange:
                yf_ticker = to_yfinance_ticker(exchange, symbol)
            else:
                yf_ticker = symbol

            t = yf.Ticker(yf_ticker)
            raw = t.news or []
            articles = []
            for item in raw:
                # yfinance >= 1.0 uses nested 'content' dict
                content = item.get('content', item)

                # Title
                title = content.get('title', item.get('title', ''))

                # Publisher / Provider
                provider = content.get('provider', {})
                if isinstance(provider, dict):
                    publisher = provider.get('displayName', '')
                else:
                    publisher = item.get('publisher', str(provider))

                # Link
                click_url = content.get('clickThroughUrl') or content.get('canonicalUrl') or {}
                if isinstance(click_url, dict):
                    link = click_url.get('url', '')
                else:
                    link = item.get('link', str(click_url))

                # Published date — convert ISO string to unix timestamp
                pub_date = content.get('pubDate', '')
                published_at = 0
                if pub_date:
                    try:
                        from datetime import datetime
                        dt = datetime.fromisoformat(pub_date.replace('Z', '+00:00'))
                        published_at = int(dt.timestamp())
                    except Exception:
                        published_at = item.get('providerPublishTime', 0)
                else:
                    published_at = item.get('providerPublishTime', 0)

                # Thumbnail
                thumb = ''
                thumb_data = content.get('thumbnail', item.get('thumbnail'))
                if thumb_data:
                    if isinstance(thumb_data, dict):
                        resolutions = thumb_data.get('resolutions', [])
                        if resolutions:
                            thumb = sorted(resolutions, key=lambda r: r.get('width', 0), reverse=True)[0].get('url', '')
                        elif thumb_data.get('originalUrl'):
                            thumb = thumb_data['originalUrl']

                # Summary
                summary = content.get('summary', '')

                # Content type
                content_type = content.get('contentType', item.get('type', 'STORY'))

                if title:  # Only add if we have a title
                    articles.append({
                        'title': title,
                        'publisher': publisher,
                        'link': link,
                        'publishedAt': published_at,
                        'type': content_type,
                        'thumbnail': thumb,
                        'summary': summary,
                    })
            return articles

        cache_key = f'news_{exchange}_{symbol}' if exchange else f'news_{symbol}'
        data = cached(cache_key, fetch)
        return jsonify(data)

    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


# ═══════════════════════════════════════
# OHLCV HISTORY API (for Lightweight Charts fallback)
# ═══════════════════════════════════════

@app.route('/api/history/<symbol>')
def get_history(symbol):
    """Return OHLCV history for Lightweight Charts rendering.
    Accepts:
        ?exchange=  TradingView exchange prefix (e.g. TSE, ASX)
        ?period=    yfinance period (1mo, 3mo, 6mo, 1y, 2y, 5y, max) — default 1y
        ?interval=  yfinance interval (1d, 1wk, 1mo) — default 1d
    """
    exchange = request.args.get('exchange', '').strip()
    period = request.args.get('period', '1y').strip()
    interval = request.args.get('interval', '1d').strip()

    # Validate params
    valid_periods = ['1mo', '3mo', '6mo', '1y', '2y', '5y', 'max']
    valid_intervals = ['1d', '1wk', '1mo']
    if period not in valid_periods:
        period = '1y'
    if interval not in valid_intervals:
        interval = '1d'

    try:
        def fetch():
            if exchange:
                yf_ticker = to_yfinance_ticker(exchange, symbol)
            else:
                yf_ticker = symbol

            t = yf.Ticker(yf_ticker)
            try:
                hist = t.history(period=period, interval=interval)
            except Exception:
                hist = None

            if hist is None or hist.empty:
                return {'candles': [], 'volumes': []}

            candles = []
            volumes = []

            for idx, row in hist.iterrows():
                # Convert timestamp to YYYY-MM-DD string
                date_str = idx.strftime('%Y-%m-%d')

                candles.append({
                    'time': date_str,
                    'open': round(row['Open'], 4),
                    'high': round(row['High'], 4),
                    'low': round(row['Low'], 4),
                    'close': round(row['Close'], 4),
                })

                # Color volume bars based on candle direction
                is_up = row['Close'] >= row['Open']
                volumes.append({
                    'time': date_str,
                    'value': int(row['Volume']),
                    'color': 'rgba(38, 166, 154, 0.5)' if is_up else 'rgba(239, 83, 80, 0.5)',
                })

            return {'candles': candles, 'volumes': volumes}

        cache_key = f'history_{exchange}_{symbol}_{period}_{interval}'
        data = cached(cache_key, fetch, skip_empty=True)
        return jsonify(data)

    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e), 'candles': [], 'volumes': []}), 500


# ═══════════════════════════════════════
# EXCHANGE MAP API (expose to frontend)
# ═══════════════════════════════════════

@app.route('/api/exchanges')
def get_exchanges():
    """Return the exchange support map for frontend use."""
    result = {}
    for prefix, config in EXCHANGE_MAP.items():
        result[prefix] = {
            'tvSupported': config.get('tv_embed', False),
            'label': config.get('label', prefix),
        }
    return jsonify(result)


# ═══════════════════════════════════════
# ARTICLE CONTENT EXTRACTION
# ═══════════════════════════════════════

@app.route('/api/article')
def get_article():
    """Extract readable article content from a URL."""
    url = request.args.get('url', '')
    if not url:
        return jsonify({'error': 'No URL provided'}), 400

    # Try trafilatura first (best quality)
    try:
        import trafilatura
        downloaded = trafilatura.fetch_url(url)
        if downloaded:
            text = trafilatura.extract(
                downloaded,
                include_comments=False,
                include_tables=True,
                favor_precision=True,
            )
            if text:
                return jsonify({'content': text, 'url': url})
    except ImportError:
        pass
    except Exception:
        pass

    # Fallback: basic HTML text extraction via requests
    try:
        import requests as req
        import re
        resp = req.get(url, timeout=10, headers={
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
                          'AppleWebKit/537.36 (KHTML, like Gecko) '
                          'Chrome/120.0.0.0 Safari/537.36'
        })
        html = resp.text
        # Remove scripts, styles, nav, footer
        for tag in ['script', 'style', 'nav', 'footer', 'header', 'aside']:
            html = re.sub(rf'<{tag}[^>]*>.*?</{tag}>', '', html, flags=re.DOTALL | re.IGNORECASE)

        # Extract text from <p> tags specifically (higher quality than stripping all HTML)
        paragraphs = re.findall(r'<p[^>]*>(.*?)</p>', html, flags=re.DOTALL | re.IGNORECASE)
        if paragraphs:
            # Clean HTML tags from within paragraphs
            clean = []
            for p in paragraphs:
                p_text = re.sub(r'<[^>]+>', '', p).strip()
                if len(p_text) > 30:  # Skip tiny fragments
                    clean.append(p_text)
            if clean:
                text = '\n\n'.join(clean)
                return jsonify({'content': text, 'url': url})

        return jsonify({
            'content': 'Could not extract article content. The publisher may restrict access.',
            'url': url,
            'fallback': True,
        })

    except Exception as e:
        return jsonify({
            'content': f'Could not fetch article: {str(e)}',
            'url': url,
            'fallback': True,
        })


# ═══════════════════════════════════════
# ECO — ECONOMIC CALENDAR API
# ═══════════════════════════════════════
#
# ECO uses the free ForexFactory JSON feed which includes title, country
# (as currency code), impact rating, and – crucially – the Actual /
# Forecast / Previous columns the embedded TradingView widget lacks.
# No API key, no scraping.

FF_URLS = [
    'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
    'https://nfs.faireconomy.media/ff_calendar_nextweek.json',
]


def _fetch_json(url, timeout=15):
    req = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
                      'AppleWebKit/537.36 (KHTML, like Gecko) '
                      'Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
    })
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read()
    return json.loads(body.decode('utf-8'))


@app.route('/api/eco-calendar')
def eco_calendar():
    """Aggregate this-week + next-week economic events from ForexFactory."""
    def fetch():
        events = []
        for url in FF_URLS:
            try:
                data = _fetch_json(url)
                if isinstance(data, list):
                    events.extend(data)
            except Exception as e:
                print(f'[eco-calendar] {url} failed: {e}')
        # Normalise — pass through most fields, ensure keys exist
        out = []
        for ev in events:
            if not isinstance(ev, dict):
                continue
            out.append({
                'title':    ev.get('title', ''),
                'country':  ev.get('country', ''),      # currency code: USD, EUR, …
                'date':     ev.get('date', ''),         # ISO datetime with TZ
                'impact':   ev.get('impact', ''),       # Low / Medium / High / Holiday
                'forecast': ev.get('forecast', ''),
                'previous': ev.get('previous', ''),
                'actual':   ev.get('actual', ''),
            })
        # Sort by date ascending
        out.sort(key=lambda x: x.get('date') or '')
        return out

    try:
        data = cached('eco_calendar', fetch, ttl=900)   # 15-min cache
        return jsonify(data)
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


# ═══════════════════════════════════════
# EVTS — EARNINGS CALENDAR API
# ═══════════════════════════════════════
#
# EVTS uses NASDAQ's free public earnings API (no key) which returns the
# full daily earnings calendar — all US-listed companies reporting on a
# given date. We parallelise per-day calls over the requested window.

NASDAQ_UA = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
                  'AppleWebKit/537.36 (KHTML, like Gecko) '
                  'Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Origin': 'https://www.nasdaq.com',
    'Referer': 'https://www.nasdaq.com/',
}


def _parse_money(s):
    """Parse NASDAQ money strings like '$1,234.56', '$3.4M', '$(0.25)', 'N/A'."""
    if s is None:
        return None
    s = str(s).strip()
    if not s or s.upper() in ('N/A', 'NA', '--', '-'):
        return None
    negative = s.startswith('(') and s.endswith(')')
    s = s.replace('(', '').replace(')', '')
    s = s.replace('$', '').replace(',', '').replace(' ', '')
    if not s:
        return None
    multiplier = 1
    last = s[-1].upper()
    if last in 'KMBT':
        multiplier = {'K': 1e3, 'M': 1e6, 'B': 1e9, 'T': 1e12}[last]
        s = s[:-1]
    try:
        val = float(s) * multiplier
        return -val if negative else val
    except ValueError:
        return None


def _fetch_nasdaq_earnings_day(d):
    """Fetch earnings for a single day from NASDAQ's public API."""
    url = f'https://api.nasdaq.com/api/calendar/earnings?date={d.isoformat()}'
    try:
        req = urllib.request.Request(url, headers=NASDAQ_UA)
        with urllib.request.urlopen(req, timeout=12) as resp:
            payload = json.loads(resp.read().decode('utf-8'))
    except Exception as e:
        print(f'[earnings-calendar] {d} failed: {e}')
        return []

    rows = (payload.get('data') or {}).get('rows') or []
    out = []
    for row in rows:
        symbol = (row.get('symbol') or '').strip()
        if not symbol:
            continue
        out.append({
            'date':           d.isoformat(),
            'ticker':         symbol,
            'name':           (row.get('name') or '').strip(),
            'eps_estimate':   _parse_money(row.get('epsForecast')),
            'last_year_eps':  _parse_money(row.get('lastYearEPS')),
            'market_cap':     _parse_money(row.get('marketCap')),
            'num_estimates':  row.get('noOfEsts'),
            'time':           row.get('time', ''),                  # time-pre-market | time-after-hours | time-not-supplied
            'fiscal_quarter': row.get('fiscalQuarterEnding', ''),
            'country':        'US',
        })
    return out


@app.route('/api/earnings-calendar')
def earnings_calendar():
    """Return all US earnings in the next `days` (1-45) via NASDAQ's API."""
    try:
        days = int(request.args.get('days', 14))
    except ValueError:
        days = 14
    days = max(1, min(days, 45))

    def fetch():
        today = date.today()
        dates = [today + timedelta(days=i) for i in range(days)]
        all_rows = []
        with ThreadPoolExecutor(max_workers=10) as ex:
            for day_rows in ex.map(_fetch_nasdaq_earnings_day, dates):
                all_rows.extend(day_rows)
        # Sort by (date, market cap desc) so megacaps surface first within each day
        all_rows.sort(key=lambda r: (r['date'], -(r['market_cap'] or 0), r['ticker']))
        return all_rows

    try:
        data = cached(f'earnings_nasdaq_{days}', fetch, ttl=1800)   # 30-min cache
        return jsonify(data)
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


if __name__ == '__main__':
    print('\n  TERMINAL Server')
    print('  ═══════════════════════════')
    print('  http://localhost:8888')
    print('  ═══════════════════════════\n')
    app.run(host='0.0.0.0', port=8888, debug=True)
