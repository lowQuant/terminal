"""
Exchange Mapping — Cross-Provider Ticker Resolution

Provides mappings between:
  • TradingView  (e.g. TSE:7203)
  • yfinance     (e.g. 7203.T)
  • Yahoo Finance search results (internal exchange codes like JPX, NMS)

To add a new data provider later, add a key to EXCHANGE_MAP entries
and a corresponding helper function.

Usage:
    from exchange_map import to_yfinance_ticker, to_tv_symbol, is_tv_embed_supported
"""

# ═══════════════════════════════════════════════════════════════
# TradingView exchange prefix → provider configuration
# ═══════════════════════════════════════════════════════════════
#
# yfinance:   suffix appended to ticker for yfinance lookups
# tv_embed:   whether TradingView's free embeddable widgets support this exchange
# label:      human-readable exchange name

EXCHANGE_MAP = {
    # ── United States ──
    'NASDAQ':   {'yfinance': '',     'tv_embed': True,  'label': 'NASDAQ'},
    'NYSE':     {'yfinance': '',     'tv_embed': True,  'label': 'NYSE'},
    'AMEX':     {'yfinance': '',     'tv_embed': True,  'label': 'NYSE American'},
    'NYSEARCA': {'yfinance': '',     'tv_embed': True,  'label': 'NYSE Arca'},
    'OTC':      {'yfinance': '',     'tv_embed': True,  'label': 'OTC Markets'},

    # ── Australia ──
    'ASX':      {'yfinance': '.AX',  'tv_embed': True,  'label': 'ASX'},

    # ── Japan ──
    'TSE':      {'yfinance': '.T',   'tv_embed': False, 'label': 'Tokyo Stock Exchange'},

    # ── United Kingdom ──
    'LSE':      {'yfinance': '.L',   'tv_embed': True,  'label': 'London Stock Exchange'},

    # ── Germany ──
    'XETR':     {'yfinance': '.DE',  'tv_embed': True,  'label': 'Xetra'},
    'FWB':      {'yfinance': '.F',   'tv_embed': True,  'label': 'Frankfurt'},

    # ── Switzerland ──
    'SIX':      {'yfinance': '.SW',  'tv_embed': True,  'label': 'SIX Swiss Exchange'},

    # ── France ──
    'EURONEXT': {'yfinance': '.PA',  'tv_embed': True,  'label': 'Euronext Paris'},

    # ── Netherlands ──
    'EURONEXT_AMS': {'yfinance': '.AS', 'tv_embed': True, 'label': 'Euronext Amsterdam'},

    # ── Hong Kong ──
    'HKEX':     {'yfinance': '.HK',  'tv_embed': False, 'label': 'Hong Kong Exchange'},

    # ── South Korea ──
    'KRX':      {'yfinance': '.KS',  'tv_embed': False, 'label': 'Korea Exchange'},
    'KOSDAQ':   {'yfinance': '.KQ',  'tv_embed': False, 'label': 'KOSDAQ'},

    # ── India ──
    'NSE':      {'yfinance': '.NS',  'tv_embed': True,  'label': 'NSE India'},
    'BSE':      {'yfinance': '.BO',  'tv_embed': True,  'label': 'BSE India'},

    # ── Canada ──
    'TSX':      {'yfinance': '.TO',  'tv_embed': True,  'label': 'Toronto Stock Exchange'},
    'TSXV':     {'yfinance': '.V',   'tv_embed': True,  'label': 'TSX Venture'},

    # ── China ──
    'SSE':      {'yfinance': '.SS',  'tv_embed': False, 'label': 'Shanghai Stock Exchange'},
    'SZSE':     {'yfinance': '.SZ',  'tv_embed': False, 'label': 'Shenzhen Stock Exchange'},

    # ── Taiwan ──
    'TWSE':     {'yfinance': '.TW',  'tv_embed': False, 'label': 'Taiwan Stock Exchange'},

    # ── Singapore ──
    'SGX':      {'yfinance': '.SI',  'tv_embed': True,  'label': 'Singapore Exchange'},

    # ── Brazil ──
    'BMFBOVESPA': {'yfinance': '.SA', 'tv_embed': True, 'label': 'B3 (BM&F Bovespa)'},

    # ── Mexico ──
    'BMV':      {'yfinance': '.MX',  'tv_embed': True,  'label': 'Bolsa Mexicana'},

    # ── Crypto (always supported in TradingView embeds) ──
    'BINANCE':  {'yfinance': '',     'tv_embed': True,  'label': 'Binance'},
    'COINBASE': {'yfinance': '',     'tv_embed': True,  'label': 'Coinbase'},
    'BITSTAMP': {'yfinance': '',     'tv_embed': True,  'label': 'Bitstamp'},

    # ── Forex ──
    'FX_IDC':   {'yfinance': '',     'tv_embed': True,  'label': 'Forex'},
    'FOREXCOM': {'yfinance': '',     'tv_embed': True,  'label': 'Forex.com'},
}


# ═══════════════════════════════════════════════════════════════
# Yahoo Finance internal exchange code → TradingView prefix
# ═══════════════════════════════════════════════════════════════
#
# These codes appear in yf.Search() results under the 'exchange' field.
# You can discover new codes by running:
#   yf.Search("company name").quotes  → look at 'exchange' values

YAHOO_EXCHANGE_TO_TV = {
    # United States
    'NMS':  'NASDAQ',       # NASDAQ Global Select
    'NGM':  'NASDAQ',       # NASDAQ Global Market
    'NCM':  'NASDAQ',       # NASDAQ Capital Market
    'NYQ':  'NYSE',
    'ASE':  'AMEX',
    'PCX':  'NYSEARCA',     # NYSE Arca
    'PNK':  'OTC',          # OTC Pink Sheets
    'OQB':  'OTC',          # OTC Bulletin Board

    # Australia
    'ASX':  'ASX',

    # Japan
    'JPX':  'TSE',

    # United Kingdom
    'LSE':  'LSE',
    'IOB':  'LSE',          # LSE International Order Book

    # Germany
    'GER':  'XETR',
    'FRA':  'FWB',

    # Switzerland
    'EBS':  'SIX',

    # France
    'PAR':  'EURONEXT',
    'ENX':  'EURONEXT',

    # Netherlands
    'AMS':  'EURONEXT_AMS',

    # Hong Kong
    'HKG':  'HKEX',

    # South Korea
    'KSC':  'KRX',
    'KOE':  'KOSDAQ',

    # India
    'NSI':  'NSE',
    'BOM':  'BSE',

    # Canada
    'TOR':  'TSX',
    'CVE':  'TSXV',

    # China
    'SHH':  'SSE',
    'SHZ':  'SZSE',

    # Taiwan
    'TAI':  'TWSE',

    # Singapore
    'SES':  'SGX',

    # Brazil
    'SAO':  'BMFBOVESPA',

    # Mexico
    'MEX':  'BMV',

    # Crypto
    'CCC':  'BINANCE',      # Yahoo's crypto market code
}


# ═══════════════════════════════════════════════════════════════
# Helper Functions
# ═══════════════════════════════════════════════════════════════

def to_yfinance_ticker(tv_exchange: str, ticker: str) -> str:
    """
    Convert a TradingView symbol to a yfinance-compatible ticker.

    Examples:
        to_yfinance_ticker('ASX', 'WOW')   → 'WOW.AX'
        to_yfinance_ticker('TSE', '7203')   → '7203.T'
        to_yfinance_ticker('NASDAQ', 'AAPL') → 'AAPL'
    """
    config = EXCHANGE_MAP.get(tv_exchange.upper(), {})
    suffix = config.get('yfinance', '')
    return f'{ticker}{suffix}'


def to_tv_symbol(yahoo_exchange: str, yahoo_symbol: str) -> dict:
    """
    Convert a Yahoo Finance search result into TradingView-compatible info.

    Returns:
        dict with keys: tv_prefix, ticker, full_symbol, tv_supported, label
    """
    tv_prefix = YAHOO_EXCHANGE_TO_TV.get(yahoo_exchange, '')

    # Yahoo symbols may already include a suffix (e.g., '7203.T')
    # Strip the suffix for the clean ticker
    ticker = yahoo_symbol.split('.')[0] if '.' in yahoo_symbol else yahoo_symbol

    # If we couldn't map the exchange, make a best guess
    if not tv_prefix:
        # Default to using the Yahoo exchange code as-is
        tv_prefix = yahoo_exchange

    config = EXCHANGE_MAP.get(tv_prefix, {})

    return {
        'tv_prefix':    tv_prefix,
        'ticker':       ticker,
        'full_symbol':  f'{tv_prefix}:{ticker}',
        'tv_supported': config.get('tv_embed', False),
        'label':        config.get('label', yahoo_exchange),
    }


def is_tv_embed_supported(tv_exchange: str) -> bool:
    """Check whether TradingView embeddable widgets support this exchange."""
    config = EXCHANGE_MAP.get(tv_exchange.upper(), {})
    return bool(config.get('tv_embed', False))


def get_exchange_label(tv_exchange: str) -> str:
    """Get the human-readable label for an exchange."""
    config = EXCHANGE_MAP.get(tv_exchange.upper(), {})
    return str(config.get('label', tv_exchange))
