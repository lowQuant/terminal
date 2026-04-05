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
# EVTS — EARNINGS CALENDAR API
# ═══════════════════════════════════════
#
# TradingView does NOT expose a public embed widget for earnings, so we
# source data per region:
#
#   US → NASDAQ's free public earnings API (no key, full daily market
#        coverage — every US-listed company reporting that day)
#   EU / JP / HK → yfinance Ticker.calendar polled in parallel across
#        the region's benchmark index constituents (STOXX 50 + FTSE top,
#        Nikkei 225 top, Hang Seng). Not every global name has earnings
#        metadata in Yahoo, but coverage is far broader than a
#        hand-picked list.

NASDAQ_UA = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
                  'AppleWebKit/537.36 (KHTML, like Gecko) '
                  'Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Origin': 'https://www.nasdaq.com',
    'Referer': 'https://www.nasdaq.com/',
}

# Regional index-constituent universes (Yahoo Finance ticker format).
# These cover the benchmark indices: STOXX Europe 50 + FTSE 100, Nikkei
# 225 top names, Hang Seng Index.
EU_UNIVERSE = [
    # Eurozone / Continental Europe
    'ASML.AS', 'SAP.DE', 'SIE.DE', 'ALV.DE', 'DTE.DE', 'BAS.DE', 'BAYN.DE',
    'BMW.DE', 'MBG.DE', 'VOW3.DE', 'ADS.DE', 'AIR.PA', 'MC.PA', 'OR.PA',
    'TTE.PA', 'SAN.PA', 'SU.PA', 'BNP.PA', 'CS.PA', 'EL.PA', 'KER.PA',
    'DG.PA', 'AI.PA', 'ABI.BR', 'ENEL.MI', 'ENI.MI', 'ISP.MI', 'UCG.MI',
    'STLAM.MI', 'IBE.MC', 'SAN.MC', 'BBVA.MC', 'ITX.MC', 'NOVN.SW',
    'ROG.SW', 'NESN.SW', 'UBSG.SW', 'ZURN.SW',
    # UK (LSE)
    'AZN.L', 'SHEL.L', 'HSBA.L', 'ULVR.L', 'GSK.L', 'RIO.L', 'DGE.L',
    'BP.L', 'GLEN.L', 'REL.L', 'LSEG.L', 'BARC.L', 'LLOY.L',
]

JP_UNIVERSE = [
    '7203.T', '6758.T', '6861.T', '8035.T', '9983.T', '9984.T', '6098.T',
    '6367.T', '8306.T', '8316.T', '8411.T', '7974.T', '4063.T', '6501.T',
    '9432.T', '9433.T', '9434.T', '6902.T', '6954.T', '6594.T', '7751.T',
    '6752.T', '6702.T', '7267.T', '7269.T', '7201.T', '4502.T', '4503.T',
    '7011.T', '8058.T', '8031.T', '8053.T', '8001.T', '4568.T', '4578.T',
]

HK_UNIVERSE = [
    '0700.HK', '9988.HK', '3690.HK', '1299.HK', '0005.HK', '0939.HK',
    '1398.HK', '0388.HK', '0941.HK', '2318.HK', '0883.HK', '0386.HK',
    '3988.HK', '2628.HK', '1288.HK', '0857.HK', '1810.HK', '9618.HK',
    '1024.HK', '3968.HK', '1211.HK', '2333.HK', '0003.HK', '0011.HK',
    '0016.HK', '0066.HK', '0017.HK', '0001.HK', '0002.HK', '0688.HK',
    '0027.HK', '0175.HK', '0669.HK', '0267.HK',
]

REGIONAL_UNIVERSES = {
    'EU': EU_UNIVERSE,
    'JP': JP_UNIVERSE,
    'HK': HK_UNIVERSE,
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


# ── US coverage: NASDAQ public API ──
def _fetch_nasdaq_earnings_day(d):
    """Fetch earnings for a single day from NASDAQ's public API."""
    url = f'https://api.nasdaq.com/api/calendar/earnings?date={d.isoformat()}'
    try:
        req = urllib.request.Request(url, headers=NASDAQ_UA)
        with urllib.request.urlopen(req, timeout=12) as resp:
            payload = json.loads(resp.read().decode('utf-8'))
    except Exception as e:
        print(f'[earnings-calendar US] {d} failed: {e}')
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
            'time':           row.get('time', ''),
            'fiscal_quarter': row.get('fiscalQuarterEnding', ''),
            'country':        'US',
        })
    return out


def _fetch_us_earnings(days):
    today = date.today()
    dates = [today + timedelta(days=i) for i in range(days)]
    all_rows = []
    with ThreadPoolExecutor(max_workers=10) as ex:
        for day_rows in ex.map(_fetch_nasdaq_earnings_day, dates):
            all_rows.extend(day_rows)
    return all_rows


# ── EU / JP / HK coverage: yfinance index constituents ──
def _fetch_one_yf_earnings(ticker, country, cutoff_date):
    """Pull the next upcoming earnings event for a single Yahoo ticker."""
    try:
        t = yf.Ticker(ticker)
        cal = t.calendar
        if not cal or not isinstance(cal, dict):
            return None

        earnings_dates = cal.get('Earnings Date') or []
        if not earnings_dates:
            return None

        today = date.today()
        future_dates = [d for d in earnings_dates if isinstance(d, date) and today <= d <= cutoff_date]
        if not future_dates:
            return None
        next_date = min(future_dates)

        info = {}
        try:
            info = t.info or {}
        except Exception:
            pass

        def _num(k):
            v = cal.get(k)
            if v is None:
                return None
            try:
                return float(v)
            except (TypeError, ValueError):
                return None

        last_year_eps = None
        # Best-effort last-year EPS from income statement
        try:
            trailing = info.get('trailingEps')
            if trailing is not None:
                last_year_eps = float(trailing)
        except Exception:
            pass

        return {
            'date':           next_date.isoformat(),
            'ticker':         ticker,
            'name':           info.get('shortName') or info.get('longName') or ticker,
            'eps_estimate':   _num('Earnings Average'),
            'last_year_eps':  last_year_eps,
            'market_cap':     info.get('marketCap'),
            'num_estimates':  None,
            'time':           '',
            'fiscal_quarter': '',
            'country':        country,
        }
    except Exception:
        return None


def _fetch_regional_earnings(country, days):
    universe = REGIONAL_UNIVERSES.get(country)
    if not universe:
        return []
    cutoff = date.today() + timedelta(days=days)
    results = []
    with ThreadPoolExecutor(max_workers=16) as ex:
        futures = [ex.submit(_fetch_one_yf_earnings, t, country, cutoff) for t in universe]
        for f in futures:
            r = f.result()
            if r:
                results.append(r)
    return results


@app.route('/api/earnings-calendar')
def earnings_calendar():
    """Return upcoming earnings for the selected country within `days`.

    Query params:
      days    — window size in days (1-45, default 14)
      country — US | EU | JP | HK (default US)
    """
    try:
        days = int(request.args.get('days', 14))
    except ValueError:
        days = 14
    days = max(1, min(days, 45))
    country = (request.args.get('country') or 'US').upper()

    def fetch():
        if country == 'US':
            rows = _fetch_us_earnings(days)
        else:
            rows = _fetch_regional_earnings(country, days)
        rows.sort(key=lambda r: (r['date'], -(r.get('market_cap') or 0), r['ticker']))
        return rows

    try:
        data = cached(f'earnings_{country}_{days}', fetch, ttl=1800)   # 30-min cache
        return jsonify({
            'rows':   data,
            'source': 'NASDAQ' if country == 'US' else 'Yahoo Finance',
            'country': country,
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


if __name__ == '__main__':
    print('\n  TERMINAL Server')
    print('  ═══════════════════════════')
    print('  http://localhost:8888')
    print('  ═══════════════════════════\n')
    app.run(host='0.0.0.0', port=8888, debug=True)
