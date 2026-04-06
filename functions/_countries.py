"""Canonical country/region registry — single source of truth.

Every function that needs countries (ECO, EVTS, future macro views,
search-by-country, etc.) imports from here. Adding a new country is a
single edit to the ``COUNTRIES`` list; every consumer picks it up
automatically.

Each country object carries *all* the metadata the various subsystems
need so nothing has to be duplicated or maintained separately:

    code        — short uppercase code used in URLs, state, API params
    name        — human-readable name (matches TradingView scanner's
                  ``country`` column for direct lookups)
    flag        — emoji flag for UI
    yf_suffix   — Yahoo Finance ticker suffix (.DE, .T, .HK, …)
    tv_scanner  — TradingView scanner market slug(s) for this country;
                  used by EVTS to query earnings. ``None`` means the
                  scanner doesn't cover this market.
    eco_code    — TradingView events-widget ``countryFilter`` code
                  (ISO2 lowercase or 'eu'). ``None`` means the ECO
                  widget doesn't support this country.
    region      — grouping label for multi-country aggregations
                  ('americas', 'europe', 'asia_pacific', 'middle_east_africa')

Future fields (reserved, add when needed):
    macro_db_code — Global-Macro-Database-Python country key
    currency      — ISO 4217 currency code
    benchmark     — benchmark equity index symbol (e.g. 'SPX', 'DAX')
"""

from dataclasses import dataclass, field
from typing import Optional, List, Dict


@dataclass(frozen=True)
class Country:
    code:        str                          # 'US', 'DE', 'JP', …
    name:        str                          # 'United States', 'Germany', …
    flag:        str                          # '🇺🇸', '🇩🇪', …
    yf_suffix:   str                          # '', '.DE', '.T', …
    currency:    str = 'USD'                  # ISO 4217: 'USD', 'EUR', 'JPY', …
    tv_scanner:  Optional[str] = None         # 'america', 'germany', …
    eco_code:    Optional[str] = None         # 'us', 'de', …
    region:      str = 'other'


# ═════════════════════════════════════════
# Master list — add new countries here
# ═════════════════════════════════════════

COUNTRIES: List[Country] = [
    # ── Americas ──                                     currency
    Country('US',  'United States',  '🇺🇸', '',     'USD', 'america',      'us', 'americas'),
    Country('CA',  'Canada',         '🇨🇦', '.TO',  'CAD', 'canada',       'ca', 'americas'),
    Country('MX',  'Mexico',         '🇲🇽', '.MX',  'MXN', 'mexico',       'mx', 'americas'),
    Country('BR',  'Brazil',         '🇧🇷', '.SA',  'BRL', 'brazil',       'br', 'americas'),

    # ── Europe ──
    Country('EU',  'Eurozone',       '🇪🇺', '',     'EUR', None,           'eu', 'europe'),
    Country('GB',  'United Kingdom', '🇬🇧', '.L',   'GBP', 'uk',           'gb', 'europe'),
    Country('DE',  'Germany',        '🇩🇪', '.DE',  'EUR', 'germany',      'de', 'europe'),
    Country('FR',  'France',         '🇫🇷', '.PA',  'EUR', 'france',       'fr', 'europe'),
    Country('NL',  'Netherlands',    '🇳🇱', '.AS',  'EUR', 'netherlands',  None,  'europe'),
    Country('IT',  'Italy',          '🇮🇹', '.MI',  'EUR', 'italy',        'it', 'europe'),
    Country('ES',  'Spain',          '🇪🇸', '.MC',  'EUR', 'spain',        'es', 'europe'),
    Country('CH',  'Switzerland',    '🇨🇭', '.SW',  'CHF', 'switzerland',  'ch', 'europe'),
    Country('BE',  'Belgium',        '🇧🇪', '.BR',  'EUR', 'belgium',      None,  'europe'),
    Country('AT',  'Austria',        '🇦🇹', '.VI',  'EUR', 'austria',      None,  'europe'),
    Country('PT',  'Portugal',       '🇵🇹', '.LS',  'EUR', 'portugal',     None,  'europe'),
    Country('IE',  'Ireland',        '🇮🇪', '.IR',  'EUR', 'ireland',      None,  'europe'),
    Country('DK',  'Denmark',        '🇩🇰', '.CO',  'DKK', 'denmark',      None,  'europe'),
    Country('SE',  'Sweden',         '🇸🇪', '.ST',  'SEK', 'sweden',       None,  'europe'),
    Country('FI',  'Finland',        '🇫🇮', '.HE',  'EUR', 'finland',      None,  'europe'),
    Country('NO',  'Norway',         '🇳🇴', '.OL',  'NOK', 'norway',       None,  'europe'),
    Country('PL',  'Poland',         '🇵🇱', '.WA',  'PLN', 'poland',       None,  'europe'),
    Country('GR',  'Greece',         '🇬🇷', '.AT',  'EUR', 'greece',       None,  'europe'),

    # ── Asia-Pacific ──
    Country('JP',  'Japan',          '🇯🇵', '.T',   'JPY', 'japan',        'jp', 'asia_pacific'),
    Country('CN',  'China',          '🇨🇳', '.SS',  'CNY', 'china',        'cn', 'asia_pacific'),
    Country('HK',  'Hong Kong',      '🇭🇰', '.HK',  'HKD', 'hongkong',     None,  'asia_pacific'),
    Country('KR',  'South Korea',    '🇰🇷', '.KS',  'KRW', 'korea',        'kr', 'asia_pacific'),
    Country('TW',  'Taiwan',         '🇹🇼', '.TW',  'TWD', 'taiwan',       None,  'asia_pacific'),
    Country('IN',  'India',          '🇮🇳', '.NS',  'INR', 'india',        'in', 'asia_pacific'),
    Country('AU',  'Australia',      '🇦🇺', '.AX',  'AUD', 'australia',    'au', 'asia_pacific'),
    Country('NZ',  'New Zealand',    '🇳🇿', '.NZ',  'NZD', 'new-zealand',  'nz', 'asia_pacific'),
    Country('SG',  'Singapore',      '🇸🇬', '.SI',  'SGD', 'singapore',    None,  'asia_pacific'),
    Country('ID',  'Indonesia',      '🇮🇩', '.JK',  'IDR', 'indonesia',    None,  'asia_pacific'),
    Country('TH',  'Thailand',       '🇹🇭', '.BK',  'THB', 'thailand',     None,  'asia_pacific'),

    # ── Middle East & Africa ──
    Country('IL',  'Israel',         '🇮🇱', '.TA',  'ILS', 'israel',       None,  'middle_east_africa'),
    Country('SA',  'Saudi Arabia',   '🇸🇦', '.SR',  'SAR', 'saudi-arabia', None,  'middle_east_africa'),
    Country('ZA',  'South Africa',   '🇿🇦', '.JO',  'ZAR', 'south-africa', 'za', 'middle_east_africa'),
    Country('TR',  'Turkey',         '🇹🇷', '.IS',  'TRY', 'turkey',       'tr', 'middle_east_africa'),
]


# ═════════════════════════════════════════
# Lookup helpers
# ═════════════════════════════════════════

# Fast O(1) lookups by various keys
_by_code:       Dict[str, Country] = {c.code: c for c in COUNTRIES}
_by_name:       Dict[str, Country] = {c.name: c for c in COUNTRIES}
_by_tv_scanner: Dict[str, Country] = {c.tv_scanner: c for c in COUNTRIES if c.tv_scanner}
_by_eco_code:   Dict[str, Country] = {c.eco_code: c for c in COUNTRIES if c.eco_code}


def by_code(code: str) -> Optional[Country]:
    """Look up by short code ('US', 'DE', 'JP', …)."""
    return _by_code.get(code.upper())


def by_name(name: str) -> Optional[Country]:
    """Look up by full name ('United States', 'Germany', …).

    Matches the TradingView scanner's ``country`` column exactly.
    """
    return _by_name.get(name)


def by_tv_scanner(slug: str) -> Optional[Country]:
    """Look up by TradingView scanner market slug ('america', 'germany', …)."""
    return _by_tv_scanner.get(slug)


def by_eco_code(code: str) -> Optional[Country]:
    """Look up by ECO widget country-filter code ('us', 'de', 'jp', …)."""
    return _by_eco_code.get(code)


def yf_suffix_for_name(name: str) -> str:
    """Return the Yahoo Finance ticker suffix for a scanner country name."""
    c = by_name(name)
    return c.yf_suffix if c else ''


def all_with_eco() -> List[Country]:
    """Countries supported by the TradingView ECO events widget."""
    return [c for c in COUNTRIES if c.eco_code is not None]


def all_with_scanner() -> List[Country]:
    """Countries whose equities are queryable via the TV scanner."""
    return [c for c in COUNTRIES if c.tv_scanner is not None]


def region_scanner_slugs(region_code: str) -> List[str]:
    """Return TV scanner slugs for a region grouping.

    ``region_code`` is either a country code ('JP', 'HK') or a
    multi-country region key ('EU'). For 'EU' this returns all European
    scanner slugs.
    """
    code = region_code.upper()

    if code == 'EU':
        return [c.tv_scanner for c in COUNTRIES
                if c.region == 'europe' and c.tv_scanner]

    c = by_code(code)
    if c and c.tv_scanner:
        return [c.tv_scanner]
    return []


def currency_for_country(code: str) -> str:
    """Return the ISO 4217 currency code for a country code."""
    c = by_code(code)
    return c.currency if c else 'USD'


def to_json(countries: Optional[List[Country]] = None) -> List[dict]:
    """Serialize countries for the frontend API."""
    items = countries if countries is not None else COUNTRIES
    return [
        {'code': c.code, 'name': c.name, 'flag': c.flag,
         'region': c.region, 'currency': c.currency}
        for c in items
    ]
