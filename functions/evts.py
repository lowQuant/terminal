"""EVTS — Corporate Events (Earnings Calendar).

Data sources by region:

    US → NASDAQ's free public earnings API (no API key, full daily
         market coverage — every US-listed company reporting each day).

    EU → yfinance Ticker.calendar polled in parallel across ~150 top
         STOXX Europe 600 constituents (continent + UK).

    JP → yfinance across Nikkei 225 top names.

    HK → yfinance across Hang Seng Index constituents.

For truly exhaustive global coverage the upgrade path is a third-party
provider with a worldwide feed (Finnhub / Financial Modeling Prep,
both free API-key tiers).
"""

import json
import traceback
import urllib.request
from datetime import date, timedelta
from concurrent.futures import ThreadPoolExecutor

import yfinance as yf
from flask import Blueprint, jsonify, request

from functions._utils import cached


evts_bp = Blueprint('evts', __name__)


NASDAQ_UA = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
                  'AppleWebKit/537.36 (KHTML, like Gecko) '
                  'Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Origin': 'https://www.nasdaq.com',
    'Referer': 'https://www.nasdaq.com/',
}

# ── Regional index-constituent universes (Yahoo Finance ticker format) ──

# STOXX Europe 600 — top ~150 by market cap across Eurozone, UK,
# Switzerland and Nordics. Covers all 11 ICB industries.
EU_UNIVERSE = [
    # Germany (DAX + MDAX leaders)
    'SAP.DE', 'SIE.DE', 'ALV.DE', 'DTE.DE', 'MUV2.DE', 'AIR.PA',
    'IFX.DE', 'DB1.DE', 'MBG.DE', 'BMW.DE', 'VOW3.DE', 'ADS.DE',
    'BAS.DE', 'BAYN.DE', 'DHL.DE', 'HEN3.DE', 'MRK.DE', 'FRE.DE',
    'FME.DE', 'RWE.DE', 'EOAN.DE', 'VNA.DE', 'CON.DE', 'HEI.DE',
    'SY1.DE', 'SHL.DE', 'P911.DE', 'ENR.DE', 'BEI.DE', 'HNR1.DE',
    # France (CAC 40 + SBF)
    'MC.PA', 'OR.PA', 'TTE.PA', 'SAN.PA', 'SU.PA', 'AI.PA', 'EL.PA',
    'BNP.PA', 'CS.PA', 'KER.PA', 'DG.PA', 'SGO.PA', 'CAP.PA', 'RI.PA',
    'ACA.PA', 'GLE.PA', 'ORA.PA', 'HO.PA', 'LR.PA', 'SAF.PA', 'ML.PA',
    'PUB.PA', 'DSY.PA', 'VIE.PA', 'CA.PA', 'RNO.PA', 'BN.PA',
    # Netherlands
    'ASML.AS', 'PRX.AS', 'INGA.AS', 'AD.AS', 'HEIA.AS', 'PHIA.AS',
    'ADYEN.AS', 'WKL.AS', 'DSFIR.AS', 'EXO.AS', 'REN.AS',
    # Italy (FTSE MIB)
    'ENEL.MI', 'ENI.MI', 'ISP.MI', 'UCG.MI', 'STLAM.MI', 'G.MI',
    'RACE.MI', 'MONC.MI', 'LDO.MI', 'STMMI.MI', 'CPR.MI', 'TRN.MI',
    'PRY.MI', 'MB.MI', 'TIT.MI', 'UNI.MI',
    # Spain (IBEX 35)
    'IBE.MC', 'SAN.MC', 'BBVA.MC', 'ITX.MC', 'TEF.MC', 'REP.MC',
    'FER.MC', 'AENA.MC', 'CABK.MC', 'ACS.MC', 'AMS.MC',
    # Switzerland (SMI / SPI)
    'NOVN.SW', 'ROG.SW', 'NESN.SW', 'UBSG.SW', 'ZURN.SW', 'ABBN.SW',
    'CFR.SW', 'GIVN.SW', 'LONN.SW', 'SREN.SW', 'ALC.SW', 'SGSN.SW',
    'SIKA.SW', 'GEBN.SW', 'UHR.SW', 'SCMN.SW', 'STMN.SW', 'KNIN.SW',
    # Belgium / Luxembourg
    'ABI.BR', 'KBC.BR', 'UCB.BR', 'SOLB.BR',
    # Nordics (Denmark / Sweden / Finland / Norway)
    'NOVO-B.CO', 'MAERSK-B.CO', 'DSV.CO', 'ORSTED.CO', 'CARL-B.CO',
    'VWS.CO', 'NDA-DK.CO',
    'VOLV-B.ST', 'ERIC-B.ST', 'HM-B.ST', 'ATCO-A.ST', 'INVE-B.ST',
    'SAND.ST', 'SEB-A.ST', 'SHB-A.ST', 'EVO.ST', 'ASSA-B.ST',
    'NOKIA.HE', 'UPM.HE', 'NESTE.HE', 'KNEBV.HE', 'FORTUM.HE',
    'EQNR.OL', 'DNB.OL', 'TEL.OL',
    # United Kingdom (FTSE 100)
    'AZN.L', 'SHEL.L', 'HSBA.L', 'ULVR.L', 'GSK.L', 'RIO.L', 'DGE.L',
    'BP.L', 'GLEN.L', 'REL.L', 'LSEG.L', 'BARC.L', 'LLOY.L', 'AAL.L',
    'NG.L', 'ABF.L', 'VOD.L', 'IMB.L', 'BATS.L', 'TSCO.L', 'BA.L',
    'NWG.L', 'STAN.L', 'PRU.L', 'LGEN.L', 'AV.L', 'EXPN.L', 'SSE.L',
    'SGE.L', 'BT-A.L', 'CNA.L', 'MNDI.L', 'III.L', 'NXT.L', 'JD.L',
    'ITRK.L', 'CRH.L', 'SMIN.L', 'WPP.L', 'RKT.L',
]

# Nikkei 225 top constituents
JP_UNIVERSE = [
    '7203.T', '6758.T', '6861.T', '8035.T', '9983.T', '9984.T', '6098.T',
    '6367.T', '8306.T', '8316.T', '8411.T', '7974.T', '4063.T', '6501.T',
    '9432.T', '9433.T', '9434.T', '6902.T', '6954.T', '6594.T', '7751.T',
    '6752.T', '6702.T', '7267.T', '7269.T', '7201.T', '4502.T', '4503.T',
    '7011.T', '8058.T', '8031.T', '8053.T', '8001.T', '4568.T', '4578.T',
    '4519.T', '6273.T', '6981.T', '7741.T', '6971.T', '4901.T', '4452.T',
    '9020.T', '9022.T', '9101.T', '9104.T', '9107.T', '5401.T', '5406.T',
    '5020.T', '1605.T', '8802.T', '3382.T', '2914.T', '2502.T',
]

# Hang Seng Index constituents
HK_UNIVERSE = [
    '0700.HK', '9988.HK', '3690.HK', '1299.HK', '0005.HK', '0939.HK',
    '1398.HK', '0388.HK', '0941.HK', '2318.HK', '0883.HK', '0386.HK',
    '3988.HK', '2628.HK', '1288.HK', '0857.HK', '1810.HK', '9618.HK',
    '1024.HK', '3968.HK', '1211.HK', '2333.HK', '0003.HK', '0011.HK',
    '0016.HK', '0066.HK', '0017.HK', '0001.HK', '0002.HK', '0688.HK',
    '0027.HK', '0175.HK', '0669.HK', '0267.HK', '0012.HK', '0823.HK',
    '0101.HK', '1113.HK', '2388.HK', '1109.HK', '0316.HK', '0291.HK',
    '0868.HK', '1093.HK', '1177.HK', '1928.HK', '2007.HK', '2382.HK',
    '6098.HK', '6862.HK', '9633.HK', '9999.HK',
]

REGIONAL_UNIVERSES = {
    'EU': EU_UNIVERSE,
    'JP': JP_UNIVERSE,
    'HK': HK_UNIVERSE,
}


# ═════════════════════════════════════════
# NASDAQ money parser
# ═════════════════════════════════════════

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


# ═════════════════════════════════════════
# US coverage — NASDAQ public API
# ═════════════════════════════════════════

def _fetch_nasdaq_earnings_day(d):
    """Fetch earnings for a single day from NASDAQ's public API."""
    url = f'https://api.nasdaq.com/api/calendar/earnings?date={d.isoformat()}'
    try:
        req = urllib.request.Request(url, headers=NASDAQ_UA)
        with urllib.request.urlopen(req, timeout=12) as resp:
            payload = json.loads(resp.read().decode('utf-8'))
    except Exception as e:
        print(f'[evts US] {d} failed: {e}')
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


# ═════════════════════════════════════════
# EU / JP / HK coverage — yfinance across index constituents
# ═════════════════════════════════════════

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
    with ThreadPoolExecutor(max_workers=20) as ex:
        futures = [ex.submit(_fetch_one_yf_earnings, t, country, cutoff) for t in universe]
        for f in futures:
            r = f.result()
            if r:
                results.append(r)
    return results


# ═════════════════════════════════════════
# Route
# ═════════════════════════════════════════

@evts_bp.route('/api/earnings-calendar')
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
            'rows':    data,
            'source':  'NASDAQ' if country == 'US' else 'Yahoo Finance',
            'country': country,
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500
