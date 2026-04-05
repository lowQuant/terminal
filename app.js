/* ═══════════════════════════════════════════════════════════
   TERMINAL — App Logic
   Bloomberg-Inspired Stock Terminal
   Global Search, Hybrid Charts, Exchange-Aware Data
   ═══════════════════════════════════════════════════════════ */

// ── State ──
const state = {
  currentSymbol: 'NASDAQ:AAPL',   // TradingView format: EXCHANGE:TICKER
  currentExchange: 'NASDAQ',
  currentTicker: 'AAPL',
  activeTab: 'home',
  symbolLoaded: false,              // becomes true after the first ticker search
  recentSymbols: JSON.parse(localStorage.getItem('terminal_recent') || '[]'),
  companyInfo: null,
  newsData: null,
  tvSupported: true,               // Whether TradingView embed works for current exchange
  exchangeMap: {},                  // Loaded from /api/exchanges
  searchResults: [],
  searchActiveIndex: -1,           // Keyboard nav index in dropdown
  watchlist: [
    { symbol: 'AAPL', exchange: 'NASDAQ', name: 'Apple Inc.' },
    { symbol: 'MSFT', exchange: 'NASDAQ', name: 'Microsoft Corp.' },
    { symbol: 'GOOGL', exchange: 'NASDAQ', name: 'Alphabet Inc.' },
    { symbol: 'AMZN', exchange: 'NASDAQ', name: 'Amazon.com Inc.' },
    { symbol: 'TSLA', exchange: 'NASDAQ', name: 'Tesla Inc.' },
    { symbol: 'NVDA', exchange: 'NASDAQ', name: 'NVIDIA Corp.' },
    { symbol: 'META', exchange: 'NASDAQ', name: 'Meta Platforms' },
    { symbol: 'JPM', exchange: 'NYSE', name: 'JPMorgan Chase' },
    { symbol: 'V', exchange: 'NYSE', name: 'Visa Inc.' },
    { symbol: 'BRK.B', exchange: 'NYSE', name: 'Berkshire Hathaway' },
  ],
  // Lightweight Charts instances (for cleanup)
  _lwCharts: [],
};

// ── DOM References ──
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ── Debounce utility ──
function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// ── Initialize ──
// Terminal init is deferred until auth completes (auth.js calls showTerminal).
let _terminalInitialized = false;

function initTerminal() {
  if (_terminalInitialized) return;
  _terminalInitialized = true;
  loadExchangeMap();
  initSearch();
  initTabs();
  initClock();
  initKeyboardShortcuts();
  initArticleModal();
  renderTickerTape();
  // Start on the Home page — no ticker loaded until the user searches one.
  setActiveTab('home');
}

// Legacy fallback: if auth.js is not loaded or Supabase is unconfigured,
// init after a short delay so the terminal still works in dev mode.
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => {
    if (!_terminalInitialized && document.getElementById('app').style.display !== 'none') {
      initTerminal();
    }
  }, 500);
});


// ═══════════════════════════════════════
// FORMATTING UTILITIES
// ═══════════════════════════════════════

function fmtMarketCap(v) {
  if (v == null) return 'N/A';
  if (v >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(0)}M`;
  return `$${v.toLocaleString()}`;
}

function fmtRatio(v) {
  if (v == null) return '—';
  return `${v.toFixed(2)}x`;
}

function fmtPercent(v) {
  if (v == null) return '—';
  const pct = (v * 100).toFixed(2);
  return `${pct}%`;
}

function fmtNumber(v, decimals = 2) {
  if (v == null) return '—';
  return v.toFixed(decimals);
}

function fmtDate(dateStr) {
  if (!dateStr || dateStr === 'None') return '—';
  try {
    const d = new Date(dateStr);
    if (isNaN(d)) return dateStr;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return dateStr;
  }
}

function fmtDateFromTs(ts) {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function timeAgo(ts) {
  if (!ts) return '';
  const now = Date.now() / 1000;
  const diff = now - ts;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return fmtDateFromTs(ts);
}

function metricColor(v, positiveGood = true) {
  if (v == null) return '';
  if (positiveGood) return v >= 0 ? 'company-info__metric-value--green' : 'company-info__metric-value--red';
  return v >= 0 ? 'company-info__metric-value--red' : 'company-info__metric-value--green';
}

function escHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}


// ═══════════════════════════════════════
// EXCHANGE MAP
// ═══════════════════════════════════════

async function loadExchangeMap() {
  try {
    const resp = await fetch('/api/exchanges');
    if (resp.ok) {
      state.exchangeMap = await resp.json();
    }
  } catch (err) {
    console.warn('Could not load exchange map:', err);
  }
}

function isTvSupported(exchange) {
  // Check local map first
  if (state.exchangeMap[exchange]) {
    return state.exchangeMap[exchange].tvSupported;
  }
  // Default known US exchanges to supported
  return ['NASDAQ', 'NYSE', 'AMEX', 'NYSEARCA'].includes(exchange);
}


// ═══════════════════════════════════════
// SEARCH / AUTOCOMPLETE
// ═══════════════════════════════════════

let _searchAbort = null; // AbortController for cancelling in-flight searches

function initSearch() {
  const input = $('#ticker-input');
  const dropdown = $('#recent-dropdown');

  // Debounced API search
  const debouncedSearch = debounce(async (query) => {
    if (query.length < 1) return;

    // Cancel previous search
    if (_searchAbort) _searchAbort.abort();
    _searchAbort = new AbortController();

    // Show loading state
    showSearchLoading();

    try {
      const resp = await fetch(`/api/search?q=${encodeURIComponent(query)}`, {
        signal: _searchAbort.signal,
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const results = await resp.json();
      state.searchResults = results;
      state.searchActiveIndex = -1;
      renderSearchResults(results, query);
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error('Search failed:', err);
        // Fall back to watchlist filtering
        renderWatchlistFilter(query);
      }
    }
  }, 300);

  input.addEventListener('focus', () => {
    const val = input.value.trim();
    if (val.length > 0) {
      // Re-show results if we have them
      if (state.searchResults.length > 0) {
        renderSearchResults(state.searchResults, val);
      }
    } else if (state.recentSymbols.length > 0) {
      renderRecentDropdown();
      dropdown.classList.add('recent-dropdown--visible');
    }
  });

  input.addEventListener('blur', () => {
    setTimeout(() => {
      dropdown.classList.remove('recent-dropdown--visible');
    }, 200);
  });

  input.addEventListener('input', () => {
    const val = input.value.trim();
    if (val.length > 0) {
      debouncedSearch(val);
    } else {
      state.searchResults = [];
      state.searchActiveIndex = -1;
      if (state.recentSymbols.length > 0) {
        renderRecentDropdown();
      } else {
        dropdown.classList.remove('recent-dropdown--visible');
      }
    }
  });

  input.addEventListener('keydown', (e) => {
    const dropdown = $('#recent-dropdown');
    const isVisible = dropdown.classList.contains('recent-dropdown--visible');

    // Arrow navigation in dropdown
    if (isVisible && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      const items = dropdown.querySelectorAll('.search-result, .recent-dropdown__item');
      if (items.length === 0) return;

      if (e.key === 'ArrowDown') {
        state.searchActiveIndex = Math.min(state.searchActiveIndex + 1, items.length - 1);
      } else {
        state.searchActiveIndex = Math.max(state.searchActiveIndex - 1, -1);
      }

      items.forEach((item, i) => {
        item.classList.toggle('search-result--active', i === state.searchActiveIndex);
        item.classList.toggle('recent-dropdown__item--active', i === state.searchActiveIndex);
      });

      // Scroll into view
      if (state.searchActiveIndex >= 0 && items[state.searchActiveIndex]) {
        items[state.searchActiveIndex].scrollIntoView({ block: 'nearest' });
      }
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();

      // If an item is highlighted via keyboard, select it
      if (isVisible && state.searchActiveIndex >= 0) {
        const items = dropdown.querySelectorAll('.search-result, .recent-dropdown__item');
        if (items[state.searchActiveIndex]) {
          items[state.searchActiveIndex].click();
          return;
        }
      }

      // Otherwise, use the raw input value
      const val = input.value.trim().toUpperCase();
      if (val) {
        // Check if it's already in EXCHANGE:TICKER format
        if (val.includes(':')) {
          const [exchange] = val.split(':');
          loadSymbol(val, isTvSupported(exchange));
        } else {
          // Try to find in search results first
          const match = state.searchResults.find(
            (r) => r.ticker.toUpperCase() === val || r.symbol.toUpperCase() === val
          );
          if (match) {
            loadSymbol(match.tvSymbol, match.tvSupported);
          } else {
            // Default: guess US exchange
            loadSymbol(`NASDAQ:${val}`, true);
          }
        }
        input.value = '';
        input.blur();
        dropdown.classList.remove('recent-dropdown--visible');
      }
    }

    if (e.key === 'Escape') {
      input.blur();
      dropdown.classList.remove('recent-dropdown--visible');
      state.searchActiveIndex = -1;
    }
  });
}

function showSearchLoading() {
  const dropdown = $('#recent-dropdown');
  dropdown.innerHTML = `
    <div class="search-loading">
      <div class="search-loading__spinner"></div>
      <span>Searching...</span>
    </div>
  `;
  dropdown.classList.add('recent-dropdown--visible');
}

function renderSearchResults(results, query) {
  const dropdown = $('#recent-dropdown');

  if (results.length === 0) {
    // No API results — fall back to watchlist filter and allow raw input
    renderWatchlistFilter(query);
    return;
  }

  let html = `<div class="recent-dropdown__header">Search Results</div>`;
  html += results.map((r, i) => {
    const tvBadge = r.tvSupported
      ? `<span class="search-result__tv-badge search-result__tv-badge--supported">TV</span>`
      : `<span class="search-result__tv-badge search-result__tv-badge--fallback">YF</span>`;

    return `
      <div class="search-result ${i === state.searchActiveIndex ? 'search-result--active' : ''}"
           onclick="selectSearchResult(${i})"
           data-index="${i}">
        <span class="search-result__ticker">${escHtml(r.ticker)}</span>
        <div class="search-result__info">
          <span class="search-result__name">${escHtml(r.name)}</span>
          <span class="search-result__exchange">${escHtml(r.exchange)}</span>
        </div>
        <div class="search-result__badges">
          <span class="search-result__type-badge">${escHtml(r.type || 'EQUITY')}</span>
          ${tvBadge}
        </div>
      </div>
    `;
  }).join('');

  dropdown.innerHTML = html;
  dropdown.classList.add('recent-dropdown--visible', 'recent-dropdown--scrollable');
}

function renderWatchlistFilter(query) {
  const dropdown = $('#recent-dropdown');
  const val = query.toUpperCase();
  const filtered = state.watchlist.filter(
    (w) => w.symbol.includes(val) || w.name.toUpperCase().includes(val)
  );

  let html = `<div class="recent-dropdown__header">Suggestions</div>`;
  if (filtered.length > 0) {
    html += filtered.map((w) => `
      <div class="recent-dropdown__item" onclick="loadSymbol('${w.exchange}:${w.symbol}', true)">
        <span class="recent-dropdown__item-symbol">${w.symbol}</span>
        <span>${w.name}</span>
      </div>
    `).join('');
  }

  // Always show "search for X" option
  html += `
    <div class="recent-dropdown__item" onclick="loadSymbol('NASDAQ:${escHtml(val)}', true)">
      <span class="recent-dropdown__item-symbol">${escHtml(val)}</span>
      <span>Search for ${escHtml(val)}</span>
    </div>
  `;

  dropdown.innerHTML = html;
  dropdown.classList.add('recent-dropdown--visible');
}

function selectSearchResult(index) {
  const r = state.searchResults[index];
  if (!r) return;

  loadSymbol(r.tvSymbol, r.tvSupported, r.name);

  // Clear search
  const input = $('#ticker-input');
  input.value = '';
  input.blur();
  $('#recent-dropdown').classList.remove('recent-dropdown--visible');
  state.searchResults = [];
  state.searchActiveIndex = -1;
}

function renderRecentDropdown() {
  const dropdown = $('#recent-dropdown');
  dropdown.innerHTML = `
    <div class="recent-dropdown__header">Recent Symbols</div>
    ${state.recentSymbols.slice(0, 8).map((s) => `
      <div class="recent-dropdown__item" onclick="loadSymbol('${s}')">
        <span class="recent-dropdown__item-symbol">${s.split(':')[1] || s}</span>
        <span>${s}</span>
      </div>
    `).join('')}
  `;
  dropdown.classList.add('recent-dropdown--visible');
}


// ═══════════════════════════════════════
// SYMBOL LOADING
// ═══════════════════════════════════════

function loadSymbol(fullSymbol, tvSupported, companyName) {
  const parts = fullSymbol.split(':');
  state.currentExchange = parts.length > 1 ? parts[0] : 'NASDAQ';
  state.currentTicker = parts.length > 1 ? parts[1] : parts[0];
  state.currentSymbol = `${state.currentExchange}:${state.currentTicker}`;

  // Determine TV support
  if (tvSupported !== undefined) {
    state.tvSupported = tvSupported;
  } else {
    state.tvSupported = isTvSupported(state.currentExchange);
  }

  // Clear cached data for new symbol
  state.companyInfo = null;
  state.newsData = null;

  // Clean up any existing Lightweight Charts instances
  destroyLightweightCharts();

  // Update recent
  state.recentSymbols = [
    state.currentSymbol,
    ...state.recentSymbols.filter((s) => s !== state.currentSymbol),
  ].slice(0, 20);
  localStorage.setItem('terminal_recent', JSON.stringify(state.recentSymbols));

  state.symbolLoaded = true;
  updateSymbolBar(companyName);

  // If we were on the Home page, flip to Overview on first ticker search.
  if (state.activeTab === 'home') {
    setActiveTab('overview');
  } else {
    loadTabContent(state.activeTab);
  }
  updateStatusBar();
}

function updateSymbolBar(companyName) {
  $('#symbol-ticker').textContent = state.currentTicker;
  $('#symbol-exchange').textContent = state.currentExchange;

  if (companyName) {
    $('#symbol-name').textContent = companyName;
  } else {
    const found = state.watchlist.find((w) => w.symbol === state.currentTicker);
    $('#symbol-name').textContent = found ? found.name : state.currentTicker;
  }

  // Update name from API data when it loads
  if (!companyName) {
    fetchCompanyInfo(state.currentTicker, state.currentExchange).then((info) => {
      if (info && info.name && !info.error) {
        $('#symbol-name').textContent = info.name;
      }
    });
  }
}


// ═══════════════════════════════════════
// API CALLS
// ═══════════════════════════════════════

async function fetchCompanyInfo(ticker, exchange) {
  try {
    const params = exchange ? `?exchange=${exchange}` : '';
    const resp = await fetch(`/api/info/${ticker}${params}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } catch (err) {
    console.error('Failed to fetch company info:', err);
    return null;
  }
}

async function fetchNews(ticker, exchange) {
  try {
    const params = exchange ? `?exchange=${exchange}` : '';
    const resp = await fetch(`/api/news/${ticker}${params}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } catch (err) {
    console.error('Failed to fetch news:', err);
    return null;
  }
}

async function fetchHistory(ticker, exchange, period = '1y', interval = '1d') {
  try {
    const params = new URLSearchParams({ exchange: exchange || '', period, interval });
    const resp = await fetch(`/api/history/${ticker}?${params}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } catch (err) {
    console.error('Failed to fetch history:', err);
    return { candles: [], volumes: [] };
  }
}

async function fetchArticleContent(url) {
  try {
    const resp = await fetch(`/api/article?url=${encodeURIComponent(url)}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } catch (err) {
    console.error('Failed to fetch article:', err);
    return { content: 'Could not load article content.', fallback: true };
  }
}


// ═══════════════════════════════════════
// TAB NAVIGATION
// ═══════════════════════════════════════

function initTabs() {
  $$('.nav-tabs__tab').forEach((tab) => {
    tab.addEventListener('click', () => setActiveTab(tab.dataset.tab));
  });
}

function setActiveTab(tabName) {
  state.activeTab = tabName;
  $$('.nav-tabs__tab').forEach((t) => t.classList.remove('nav-tabs__tab--active'));
  // Home has no dedicated tab button — guard the lookup.
  const activeBtn = $(`.nav-tabs__tab[data-tab="${tabName}"]`);
  if (activeBtn) activeBtn.classList.add('nav-tabs__tab--active');
  destroyLightweightCharts();
  loadTabContent(tabName);
}

function loadTabContent(tabName) {
  const dashboard = $('#dashboard');
  const symbolBar = $('#symbol-bar');
  const navTabs = $('#nav-tabs');

  // On Home: hide the stock-context nav-tabs and the symbol bar.
  // On any ticker tab: show them (tabs stay stock-specific for now;
  // future: asset-class-aware tab bindings).
  if (tabName === 'home') {
    if (symbolBar) symbolBar.style.display = 'none';
    if (navTabs) navTabs.style.display = 'none';
  } else if (state.symbolLoaded) {
    if (symbolBar) symbolBar.style.display = '';
    if (navTabs) navTabs.style.display = '';
  }

  // Ticker-bound tab requested without a loaded symbol → fall back to Home.
  if (tabName !== 'home' && !state.symbolLoaded) {
    setActiveTab('home');
    return;
  }

  switch (tabName) {
    case 'home': renderHome(dashboard); break;
    case 'overview': renderOverview(dashboard); break;
    case 'chart': renderFullChart(dashboard); break;
    case 'news': renderNews(dashboard); break;
    case 'financials': renderFinancials(dashboard); break;
    case 'profile': renderProfile(dashboard); break;
    case 'watchlist': renderWatchlist(dashboard); break;
    default: renderHome(dashboard);
  }
}


// ═══════════════════════════════════════
// HOME TAB — Market Dashboard + Daily Quote
// ═══════════════════════════════════════

// Curated quotes from famous investors, traders, psychologists & thinkers.
// Rotates deterministically by day-of-year so every user sees the same
// quote on a given day.
const MARKET_QUOTES = [
  { text: "The stock market is a device for transferring money from the impatient to the patient.", author: "Warren Buffett" },
  { text: "Be fearful when others are greedy, and greedy when others are fearful.", author: "Warren Buffett" },
  { text: "In the short run, the market is a voting machine, but in the long run, it is a weighing machine.", author: "Benjamin Graham" },
  { text: "The investor's chief problem — and even his worst enemy — is likely to be himself.", author: "Benjamin Graham" },
  { text: "Risk comes from not knowing what you're doing.", author: "Warren Buffett" },
  { text: "The four most dangerous words in investing are: 'this time it's different.'", author: "Sir John Templeton" },
  { text: "Markets can remain irrational longer than you can remain solvent.", author: "John Maynard Keynes" },
  { text: "The individual investor should act consistently as an investor and not as a speculator.", author: "Benjamin Graham" },
  { text: "How many millionaires do you know who have become wealthy by investing in savings accounts?", author: "Robert G. Allen" },
  { text: "The goal of a successful trader is to make the best trades. Money is secondary.", author: "Alexander Elder" },
  { text: "I'm only rich because I know when I'm wrong.", author: "George Soros" },
  { text: "It's not whether you're right or wrong that's important, but how much money you make when you're right and how much you lose when you're wrong.", author: "George Soros" },
  { text: "The trend is your friend until the end when it bends.", author: "Ed Seykota" },
  { text: "Amateurs think about how much money they can make. Professionals think about how much money they could lose.", author: "Jack Schwager" },
  { text: "The elements of good trading are: cutting losses, cutting losses, and cutting losses.", author: "Ed Seykota" },
  { text: "Every once in a while, the market does something so stupid it takes your breath away.", author: "Jim Cramer" },
  { text: "Time in the market beats timing the market.", author: "Ken Fisher" },
  { text: "The four most expensive words in the English language are 'This time it's different.'", author: "Sir John Templeton" },
  { text: "October: This is one of the peculiarly dangerous months to speculate in stocks. The others are July, January, September, April, November, May, March, June, December, August and February.", author: "Mark Twain" },
  { text: "The market can stay irrational longer than you can stay solvent.", author: "John Maynard Keynes" },
  { text: "Bulls make money, bears make money, pigs get slaughtered.", author: "Wall Street Proverb" },
  { text: "Know what you own, and know why you own it.", author: "Peter Lynch" },
  { text: "Far more money has been lost by investors preparing for corrections than has been lost in corrections themselves.", author: "Peter Lynch" },
  { text: "The stock market is filled with individuals who know the price of everything, but the value of nothing.", author: "Phillip Fisher" },
  { text: "The key to making money in stocks is not to get scared out of them.", author: "Peter Lynch" },
  { text: "An investment in knowledge pays the best interest.", author: "Benjamin Franklin" },
  { text: "Wide diversification is only required when investors do not understand what they are doing.", author: "Warren Buffett" },
  { text: "Rule No. 1: Never lose money. Rule No. 2: Never forget rule No. 1.", author: "Warren Buffett" },
  { text: "The most important quality for an investor is temperament, not intellect.", author: "Warren Buffett" },
  { text: "If you have trouble imagining a 20% loss in the stock market, you shouldn't be in stocks.", author: "John Bogle" },
  { text: "Don't look for the needle in the haystack. Just buy the haystack!", author: "John Bogle" },
  { text: "The biggest risk of all is not taking one.", author: "Mellody Hobson" },
  { text: "Behind every stock is a company. Find out what it's doing.", author: "Peter Lynch" },
  { text: "The essence of investment management is the management of risks, not the management of returns.", author: "Benjamin Graham" },
  { text: "We don't have to be smarter than the rest. We have to be more disciplined than the rest.", author: "Warren Buffett" },
  { text: "The market is a pendulum that forever swings between unsustainable optimism and unjustified pessimism.", author: "Benjamin Graham" },
  { text: "Losers average losers.", author: "Paul Tudor Jones" },
  { text: "The key is to wait. Sometimes the hardest thing to do is to do nothing.", author: "David Tepper" },
  { text: "I became a millionaire by trying to be right — not by trying to make money.", author: "Nicolas Darvas" },
  { text: "Markets are never wrong — opinions are.", author: "Jesse Livermore" },
  { text: "It was never my thinking that made big money for me. It was my sitting.", author: "Jesse Livermore" },
  { text: "The fundamental law of investing is the uncertainty of the future.", author: "Peter Bernstein" },
  { text: "Risk management is the most important thing to be well understood. Undertrade, undertrade, undertrade.", author: "Bruce Kovner" },
  { text: "Humans think in stories, and we try to make sense of the world by telling stories.", author: "Daniel Kahneman" },
  { text: "Nothing in life is as important as you think it is while you are thinking about it.", author: "Daniel Kahneman" },
  { text: "A lot of success in life and business comes from knowing what you want to avoid.", author: "Charlie Munger" },
  { text: "The big money is not in the buying and selling, but in the waiting.", author: "Charlie Munger" },
  { text: "All intelligent investing is value investing — acquiring more than you are paying for.", author: "Charlie Munger" },
  { text: "Invert, always invert.", author: "Charlie Munger" },
  { text: "Take calculated risks. That is quite different from being rash.", author: "George S. Patton" },
];

function getQuoteOfTheDay() {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 0);
  const diff = now - start;
  const dayOfYear = Math.floor(diff / (1000 * 60 * 60 * 24));
  return MARKET_QUOTES[dayOfYear % MARKET_QUOTES.length];
}

function renderHome(container) {
  container.className = 'dashboard dashboard--home';
  const quote = getQuoteOfTheDay();
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  container.innerHTML = `
    <div class="home-wrapper">
      <!-- Quote Hero -->
      <section class="home-quote">
        <div class="home-quote__date">${today.toUpperCase()}</div>
        <blockquote class="home-quote__text">
          <span class="home-quote__mark">&ldquo;</span>${escHtml(quote.text)}<span class="home-quote__mark">&rdquo;</span>
        </blockquote>
        <div class="home-quote__author">— ${escHtml(quote.author)}</div>
      </section>

      <!-- Market Grid: Global Markets (left) + Top News (right) -->
      <section class="home-grid">
        <div class="panel home-panel home-panel--markets">
          <div class="panel__header">
            <div class="panel__title"><span class="panel__title-dot"></span> Global Markets</div>
          </div>
          <div class="panel__body" id="home-market-overview"></div>
        </div>

        <div class="panel home-panel home-panel--news">
          <div class="panel__header">
            <div class="panel__title"><span class="panel__title-dot"></span> Top News</div>
          </div>
          <div class="panel__body" id="home-news-feed"></div>
        </div>
      </section>

      <!-- Function Hints -->
      <section class="home-functions">
        <div class="home-functions__label">Quick functions — type in search:</div>
        <div class="home-functions__grid">
          <div class="func-card" title="Economic calendar &amp; releases">
            <div class="func-card__code">ECO</div>
            <div class="func-card__desc">Economic Data &amp; Releases</div>
          </div>
          <div class="func-card" title="World equity futures">
            <div class="func-card__code">WEIF</div>
            <div class="func-card__desc">World Equity Futures</div>
          </div>
          <div class="func-card" title="Commodity overview">
            <div class="func-card__code">CMDTY</div>
            <div class="func-card__desc">Commodity Overview</div>
          </div>
          <div class="func-card" title="Foreign exchange cross rates">
            <div class="func-card__code">FX</div>
            <div class="func-card__desc">Currency Cross Rates</div>
          </div>
          <div class="func-card" title="Top movers — gainers &amp; losers">
            <div class="func-card__code">MOV</div>
            <div class="func-card__desc">Top Movers</div>
          </div>
          <div class="func-card" title="Your personalized watchlist">
            <div class="func-card__code">WL</div>
            <div class="func-card__desc">Watchlist</div>
          </div>
        </div>
        <div class="home-functions__hint">
          <span class="kbd">/</span> search ticker or function &nbsp;·&nbsp;
          <span class="kbd">Esc</span> back to Home
        </div>
      </section>
    </div>
  `;

  injectMarketOverview('home-market-overview');
  injectTimeline('home-news-feed');
}

// ── Home page widget injectors ──
// NOTE on symbol curation: TradingView's free embed widgets only display
// data for symbols that have free public feeds. CME/NYMEX/COMEX futures,
// CBOE:VIX, TVC:DXY and TVC bond-yield tickers are gated behind a TV
// login and render as empty rows inside market-overview. We stick to
// FOREXCOM/INDEX/OANDA/TVC/BITSTAMP/BINANCE which are reliably public.
function injectMarketOverview(containerId) {
  injectWidget(containerId,
    'https://s3.tradingview.com/external-embedding/embed-widget-market-overview.js',
    {
      colorTheme: 'dark',
      dateRange: '12M',
      showChart: true,
      locale: 'en',
      width: '100%',
      height: '100%',
      largeChartUrl: '',
      isTransparent: true,
      showSymbolLogo: true,
      showFloatingTooltip: false,
      plotLineColorGrowing: 'rgba(0, 230, 118, 1)',
      plotLineColorFalling: 'rgba(255, 82, 82, 1)',
      gridLineColor: 'rgba(30, 32, 48, 0.6)',
      scaleFontColor: 'rgba(138, 140, 160, 1)',
      belowLineFillColorGrowing: 'rgba(0, 230, 118, 0.12)',
      belowLineFillColorFalling: 'rgba(255, 82, 82, 0.12)',
      belowLineFillColorGrowingBottom: 'rgba(0, 230, 118, 0)',
      belowLineFillColorFallingBottom: 'rgba(255, 82, 82, 0)',
      symbolActiveColor: 'rgba(255, 140, 0, 0.12)',
      tabs: [
        {
          title: 'Indices',
          symbols: [
            { s: 'FOREXCOM:SPXUSD', d: 'S&P 500' },
            { s: 'FOREXCOM:NSXUSD', d: 'NASDAQ 100' },
            { s: 'FOREXCOM:DJI',    d: 'Dow Jones' },
            { s: 'INDEX:DEU40',     d: 'DAX' },
            { s: 'INDEX:SX5E',      d: 'Euro Stoxx 50' },
            { s: 'INDEX:NKY',       d: 'Nikkei 225' },
            { s: 'INDEX:HSI',       d: 'Hang Seng' },
            { s: 'BMFBOVESPA:IBOV', d: 'Ibovespa' },
            { s: 'CAPITALCOM:VIX',  d: 'VIX' },
          ],
          originalTitle: 'Indices',
        },
        {
          title: 'Forex',
          symbols: [
            { s: 'FX:EURUSD', d: 'EUR/USD' },
            { s: 'FX:GBPUSD', d: 'GBP/USD' },
            { s: 'FX:USDJPY', d: 'USD/JPY' },
            { s: 'FX:USDCHF', d: 'USD/CHF' },
            { s: 'FX:AUDUSD', d: 'AUD/USD' },
            { s: 'FX:USDCAD', d: 'USD/CAD' },
            { s: 'FX:NZDUSD', d: 'NZD/USD' },
          ],
          originalTitle: 'Forex',
        },
        {
          title: 'Commodities',
          symbols: [
            { s: 'OANDA:XAUUSD', d: 'Gold' },
            { s: 'OANDA:XAGUSD', d: 'Silver' },
            { s: 'TVC:USOIL',    d: 'WTI Crude' },
            { s: 'TVC:UKOIL',    d: 'Brent Crude' },
            { s: 'OANDA:XPTUSD', d: 'Platinum' },
            { s: 'OANDA:XPDUSD', d: 'Palladium' },
          ],
          originalTitle: 'Commodities',
        },
        {
          title: 'Crypto',
          symbols: [
            { s: 'BITSTAMP:BTCUSD',  d: 'Bitcoin' },
            { s: 'BITSTAMP:ETHUSD',  d: 'Ethereum' },
            { s: 'BINANCE:SOLUSDT',  d: 'Solana' },
            { s: 'BINANCE:BNBUSDT',  d: 'BNB' },
            { s: 'BINANCE:XRPUSDT',  d: 'XRP' },
            { s: 'BINANCE:ADAUSDT',  d: 'Cardano' },
          ],
          originalTitle: 'Crypto',
        },
      ],
    }
  );
}

function injectTimeline(containerId) {
  injectWidget(containerId,
    'https://s3.tradingview.com/external-embedding/embed-widget-timeline.js',
    {
      feedMode: 'all_symbols',
      isTransparent: true,
      displayMode: 'regular',
      width: '100%',
      height: '100%',
      colorTheme: 'dark',
      locale: 'en',
    }
  );
}


// ═══════════════════════════════════════
// OVERVIEW TAB — Chart + Company Info
// ═══════════════════════════════════════

function renderOverview(container) {
  container.className = 'dashboard dashboard--overview';
  container.innerHTML = `
    <div class="panel" id="main-chart-panel">
      <div class="panel__header">
        <div class="panel__title"><span class="panel__title-dot"></span> ${state.tvSupported ? 'Advanced Chart' : 'Price Chart'}</div>
        <div class="panel__actions">
          <button class="panel__action-btn" onclick="setActiveTab('chart')" title="Fullscreen">⛶</button>
        </div>
      </div>
      <div class="panel__body" id="chart-container"></div>
    </div>
    <div class="panel">
      <div class="panel__header">
        <div class="panel__title"><span class="panel__title-dot"></span> Company Info</div>
      </div>
      <div class="panel__body" id="company-info-container">
        ${renderInfoSkeleton()}
      </div>
    </div>
  `;

  injectChart('chart-container', state.currentSymbol, state.currentExchange);
  loadCompanyInfoPanel();
}

async function loadCompanyInfoPanel() {
  const container = document.getElementById('company-info-container');
  if (!container) return;

  if (!state.companyInfo) {
    state.companyInfo = await fetchCompanyInfo(state.currentTicker, state.currentExchange);
  }

  if (!state.companyInfo || state.companyInfo.error) {
    container.innerHTML = `
      <div class="company-info">
        <div class="company-info__section" style="text-align: center; padding: 40px 16px;">
          <p style="color: var(--text-tertiary); font-size: 11px;">
            ${state.companyInfo?.error || 'Could not load company data.'}<br>
            <span style="color: var(--text-muted); font-size: 10px;">
              Make sure the Flask server is running: <code>python server.py</code>
            </span>
          </p>
        </div>
      </div>
    `;
    return;
  }

  const info = state.companyInfo;

  // Update symbol bar name if we got a good response
  if (info.name) {
    $('#symbol-name').textContent = info.name;
  }

  container.innerHTML = `
    <div class="company-info">
      <!-- Header: Name + Classification -->
      <div class="company-info__header">
        <div class="company-info__name">${info.name || state.currentTicker}</div>
        <div class="company-info__classification">
          <span>${info.sector || '—'}</span>
          <span class="company-info__separator">›</span>
          <span>${info.industry || '—'}</span>
        </div>
        ${info.website ? `<div class="company-info__website">
          <a href="${info.website}" target="_blank">${info.website.replace(/^https?:\/\/(www\.)?/, '')}</a>
          ${info.employees ? ` · ${(info.employees / 1000).toFixed(0)}K employees` : ''}
          ${info.country ? ` · ${info.city ? info.city + ', ' : ''}${info.country}` : ''}
        </div>` : ''}
      </div>

      <!-- Valuation Metrics -->
      <div class="company-info__section">
        <div class="company-info__section-title">Valuation</div>
        <div class="company-info__metrics">
          <div class="company-info__metric">
            <span class="company-info__metric-label">Market Cap</span>
            <span class="company-info__metric-value">${fmtMarketCap(info.marketCap)}</span>
          </div>
          <div class="company-info__metric">
            <span class="company-info__metric-label">EV</span>
            <span class="company-info__metric-value">${fmtMarketCap(info.enterpriseValue)}</span>
          </div>
          <div class="company-info__metric">
            <span class="company-info__metric-label">Trailing P/E</span>
            <span class="company-info__metric-value">${fmtRatio(info.trailingPE)}</span>
          </div>
          <div class="company-info__metric">
            <span class="company-info__metric-label">Forward P/E</span>
            <span class="company-info__metric-value">${fmtRatio(info.forwardPE)}</span>
          </div>
          <div class="company-info__metric">
            <span class="company-info__metric-label">P/S</span>
            <span class="company-info__metric-value">${fmtRatio(info.priceToSalesTrailing12Months)}</span>
          </div>
          <div class="company-info__metric">
            <span class="company-info__metric-label">P/B</span>
            <span class="company-info__metric-value">${fmtRatio(info.priceToBook)}</span>
          </div>
          <div class="company-info__metric">
            <span class="company-info__metric-label">PEG</span>
            <span class="company-info__metric-value">${fmtRatio(info.pegRatio)}</span>
          </div>
          <div class="company-info__metric">
            <span class="company-info__metric-label">Beta</span>
            <span class="company-info__metric-value">${fmtNumber(info.beta)}</span>
          </div>
        </div>
      </div>

      <!-- Earnings -->
      <div class="company-info__section">
        <div class="company-info__section-title">Earnings</div>
        <div class="company-info__metrics">
          <div class="company-info__metric">
            <span class="company-info__metric-label">EPS (TTM)</span>
            <span class="company-info__metric-value">${fmtNumber(info.trailingEps)}</span>
          </div>
          <div class="company-info__metric">
            <span class="company-info__metric-label">EPS (FWD)</span>
            <span class="company-info__metric-value">${fmtNumber(info.forwardEps)}</span>
          </div>
          <div class="company-info__metric">
            <span class="company-info__metric-label">Rev Growth</span>
            <span class="company-info__metric-value ${metricColor(info.revenueGrowth)}">${fmtPercent(info.revenueGrowth)}</span>
          </div>
          <div class="company-info__metric">
            <span class="company-info__metric-label">Earnings Growth</span>
            <span class="company-info__metric-value ${metricColor(info.earningsGrowth)}">${fmtPercent(info.earningsGrowth)}</span>
          </div>
        </div>
        ${info.lastQuarter || info.nextEarningsDate ? `
          <div class="company-info__metrics" style="margin-top: 4px;">
            <div class="company-info__metric">
              <span class="company-info__metric-label">Last Quarter</span>
              <span class="company-info__metric-value">${fmtDate(info.lastQuarter)}</span>
            </div>
            <div class="company-info__metric">
              <span class="company-info__metric-label">Next Earnings</span>
              <span class="company-info__metric-value company-info__metric-value--accent">${fmtDate(info.nextEarningsDate)}</span>
            </div>
          </div>
        ` : ''}
        ${info.nextEarningsDate && info.nextEarningsDate !== 'None' ? `
          <div class="company-info__earnings-next">
            <span class="company-info__earnings-icon">📅</span>
            <div class="company-info__earnings-detail">
              <div class="company-info__earnings-label">Upcoming Earnings</div>
              <div class="company-info__earnings-date">${fmtDate(info.nextEarningsDate)}</div>
            </div>
          </div>
        ` : ''}
      </div>

      <!-- Market Data -->
      <div class="company-info__section">
        <div class="company-info__section-title">Market Data</div>
        <div class="company-info__metrics">
          <div class="company-info__metric">
            <span class="company-info__metric-label">52W High</span>
            <span class="company-info__metric-value">${fmtNumber(info.fiftyTwoWeekHigh)}</span>
          </div>
          <div class="company-info__metric">
            <span class="company-info__metric-label">52W Low</span>
            <span class="company-info__metric-value">${fmtNumber(info.fiftyTwoWeekLow)}</span>
          </div>
          <div class="company-info__metric">
            <span class="company-info__metric-label">50d MA</span>
            <span class="company-info__metric-value">${fmtNumber(info.fiftyDayAverage)}</span>
          </div>
          <div class="company-info__metric">
            <span class="company-info__metric-label">200d MA</span>
            <span class="company-info__metric-value">${fmtNumber(info.twoHundredDayAverage)}</span>
          </div>
          <div class="company-info__metric">
            <span class="company-info__metric-label">Div Yield</span>
            <span class="company-info__metric-value">${info.dividendYield != null ? fmtPercent(info.dividendYield) : '—'}</span>
          </div>
          <div class="company-info__metric">
            <span class="company-info__metric-label">Payout Ratio</span>
            <span class="company-info__metric-value">${info.payoutRatio != null ? fmtPercent(info.payoutRatio) : '—'}</span>
          </div>
        </div>
      </div>

      <!-- Profitability -->
      <div class="company-info__section">
        <div class="company-info__section-title">Profitability</div>
        <div class="company-info__metrics">
          <div class="company-info__metric">
            <span class="company-info__metric-label">Gross Margin</span>
            <span class="company-info__metric-value">${fmtPercent(info.grossMargins)}</span>
          </div>
          <div class="company-info__metric">
            <span class="company-info__metric-label">Op Margin</span>
            <span class="company-info__metric-value">${fmtPercent(info.operatingMargins)}</span>
          </div>
          <div class="company-info__metric">
            <span class="company-info__metric-label">Profit Margin</span>
            <span class="company-info__metric-value">${fmtPercent(info.profitMargins)}</span>
          </div>
          <div class="company-info__metric">
            <span class="company-info__metric-label">ROE</span>
            <span class="company-info__metric-value">${fmtPercent(info.returnOnEquity)}</span>
          </div>
        </div>
      </div>

      <!-- Description -->
      ${info.description ? `
        <div class="company-info__description">
          <p>${info.description}</p>
        </div>
      ` : ''}
    </div>
  `;
}

function renderInfoSkeleton() {
  return `
    <div class="company-info__skeleton">
      <div class="skeleton-line skeleton-line--long skeleton-line--thick"></div>
      <div class="skeleton-line skeleton-line--medium"></div>
      <div class="skeleton-line skeleton-line--short"></div>
      <div style="height: 16px;"></div>
      <div class="skeleton-line skeleton-line--full"></div>
      <div class="skeleton-line skeleton-line--full"></div>
      <div class="skeleton-line skeleton-line--full"></div>
      <div class="skeleton-line skeleton-line--full"></div>
      <div style="height: 16px;"></div>
      <div class="skeleton-line skeleton-line--full"></div>
      <div class="skeleton-line skeleton-line--full"></div>
      <div class="skeleton-line skeleton-line--long"></div>
    </div>
  `;
}


// ═══════════════════════════════════════
// CHART TAB — Fullscreen
// ═══════════════════════════════════════

function renderFullChart(container) {
  container.className = 'dashboard dashboard--full';
  container.innerHTML = `
    <div class="panel">
      <div class="panel__header">
        <div class="panel__title"><span class="panel__title-dot"></span> ${state.tvSupported ? 'Advanced Chart' : 'Price Chart'} — ${state.currentSymbol}</div>
        <div class="panel__actions">
          <button class="panel__action-btn" onclick="setActiveTab('overview')" title="Back">←</button>
        </div>
      </div>
      <div class="panel__body" id="fullchart-container"></div>
    </div>
  `;
  injectChart('fullchart-container', state.currentSymbol, state.currentExchange);
}


// ═══════════════════════════════════════
// NEWS TAB — Full-width, Top Stories + Feed
// ═══════════════════════════════════════

function renderNews(container) {
  container.className = 'dashboard dashboard--full';
  container.innerHTML = `
    <div class="panel">
      <div class="panel__header">
        <div class="panel__title"><span class="panel__title-dot"></span> News — ${state.currentTicker}</div>
      </div>
      <div class="panel__body" id="news-container">
        <div class="news__loading">
          <div class="loading-spinner"></div>
          <div class="loading-text">Loading news...</div>
        </div>
      </div>
    </div>
  `;

  loadNewsContent();
}

async function loadNewsContent() {
  const container = document.getElementById('news-container');
  if (!container) return;

  if (!state.newsData) {
    state.newsData = await fetchNews(state.currentTicker, state.currentExchange);
  }

  if (!state.newsData || state.newsData.error || state.newsData.length === 0) {
    container.innerHTML = `
      <div class="news__empty">
        <p>${state.newsData?.error || 'No news available for this ticker.'}</p>
        <p style="color: var(--text-muted); font-size: 10px; margin-top: 8px;">
          Make sure the Flask server is running: <code>python server.py</code>
        </p>
      </div>
    `;
    return;
  }

  const articles = state.newsData;
  const topStories = articles.slice(0, 3);
  const feedArticles = articles.slice(3);

  container.innerHTML = `
    <div class="news-container">
      <!-- Top Stories -->
      <div class="news__top-section">
        <div class="news__section-title">Top Stories</div>
        <div class="news__top-grid">
          ${topStories.map((a, i) => `
            <div class="news-card" onclick="openArticle(${JSON.stringify(a.link).replace(/"/g, '&quot;')}, ${JSON.stringify(a.title).replace(/"/g, '&quot;')}, ${JSON.stringify(a.publisher).replace(/"/g, '&quot;')}, ${a.publishedAt})">
              <span class="news-card__rank">#${i + 1}</span>
              <div class="news-card__title">${escHtml(a.title)}</div>
              <div class="news-card__meta">
                <span class="news-card__publisher">${escHtml(a.publisher)}</span>
                <span class="news-card__dot"></span>
                <span>${timeAgo(a.publishedAt)}</span>
              </div>
            </div>
          `).join('')}
        </div>
      </div>

      <!-- Recent Feed -->
      ${feedArticles.length > 0 ? `
        <div class="news__feed-section">
          <div class="news__section-title">Recent</div>
          <div class="news-feed">
            ${feedArticles.map((a) => `
              <div class="news-feed__item" onclick="openArticle(${JSON.stringify(a.link).replace(/"/g, '&quot;')}, ${JSON.stringify(a.title).replace(/"/g, '&quot;')}, ${JSON.stringify(a.publisher).replace(/"/g, '&quot;')}, ${a.publishedAt})">
                <span class="news-feed__time">${timeAgo(a.publishedAt)}</span>
                <div class="news-feed__content">
                  <div class="news-feed__title">${escHtml(a.title)}</div>
                  <div class="news-feed__publisher">${escHtml(a.publisher)}</div>
                </div>
                <span class="news-feed__arrow">→</span>
              </div>
            `).join('')}
          </div>
        </div>
      ` : ''}
    </div>
  `;
}


// ═══════════════════════════════════════
// ARTICLE READER MODAL
// ═══════════════════════════════════════

function initArticleModal() {
  const modal = $('#article-modal');
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeArticleModal();
    });
  }
}

function openArticle(url, title, publisher, publishedAt) {
  const modal = $('#article-modal');
  if (!modal) return;

  $('#article-modal-title').textContent = title || 'Article';
  $('#article-modal-publisher').textContent = publisher || '';
  $('#article-modal-date').textContent = publishedAt ? fmtDateFromTs(publishedAt) : '';
  $('#article-modal-link').href = url;

  const body = $('#article-modal-body');
  body.innerHTML = `
    <div class="article-modal__loading">
      <div class="loading-spinner"></div>
      <div class="loading-text">Extracting article content...</div>
    </div>
  `;

  modal.classList.add('article-modal--visible');

  fetchArticleContent(url).then((data) => {
    if (data.content) {
      const paragraphs = data.content.split('\n\n').filter(p => p.trim());
      body.innerHTML = `
        <div class="article-modal__text">
          ${paragraphs.map(p => `<p>${escHtml(p.trim())}</p>`).join('')}
        </div>
      `;
    } else {
      body.innerHTML = `
        <div class="article-modal__text" style="text-align: center; padding: 40px;">
          <p style="color: var(--text-tertiary);">Could not extract article content.</p>
          <p style="margin-top: 12px;">
            <a href="${url}" target="_blank" class="article-modal__link" style="display: inline-flex;">
              Open in browser →
            </a>
          </p>
        </div>
      `;
    }
  });
}

function closeArticleModal() {
  const modal = $('#article-modal');
  if (modal) modal.classList.remove('article-modal--visible');
}


// ═══════════════════════════════════════
// FINANCIALS TAB
// ═══════════════════════════════════════

function renderFinancials(container) {
  container.className = 'dashboard dashboard--full';
  container.innerHTML = `
    <div class="panel">
      <div class="panel__header">
        <div class="panel__title"><span class="panel__title-dot"></span> Financials — ${state.currentSymbol}</div>
        <div class="panel__actions">
          <span class="panel__title text-muted" style="font-size: 9px; letter-spacing: 0.5px;">
            Income Statement · Balance Sheet · Cash Flow · Quarterly / Annual
          </span>
        </div>
      </div>
      <div class="panel__body" id="financials-container"></div>
    </div>
  `;
  injectFinancials('financials-container', state.currentSymbol);
}


// ═══════════════════════════════════════
// PROFILE TAB
// ═══════════════════════════════════════

function renderProfile(container) {
  container.className = 'dashboard dashboard--split';
  container.innerHTML = `
    <div class="panel">
      <div class="panel__header">
        <div class="panel__title"><span class="panel__title-dot"></span> Company Profile — ${state.currentTicker}</div>
      </div>
      <div class="panel__body" id="profile-container"></div>
    </div>
    <div class="panel">
      <div class="panel__header">
        <div class="panel__title"><span class="panel__title-dot"></span> Financials — ${state.currentTicker}</div>
      </div>
      <div class="panel__body" id="profile-fin-container"></div>
    </div>
  `;
  injectSymbolProfile('profile-container', state.currentSymbol);
  injectFinancials('profile-fin-container', state.currentSymbol);
}


// ═══════════════════════════════════════
// WATCHLIST TAB
// ═══════════════════════════════════════

function renderWatchlist(container) {
  container.className = 'dashboard dashboard--overview';
  container.innerHTML = `
    <div class="panel">
      <div class="panel__header">
        <div class="panel__title"><span class="panel__title-dot"></span> Chart — ${state.currentTicker}</div>
      </div>
      <div class="panel__body" id="wl-chart-container"></div>
    </div>
    <div class="panel">
      <div class="panel__header">
        <div class="panel__title"><span class="panel__title-dot"></span> Watchlist</div>
        <div class="panel__actions">
          <button class="panel__action-btn" onclick="addToWatchlist()" title="Add current ticker">+</button>
        </div>
      </div>
      <div class="panel__body">
        <ul class="watchlist">
          ${state.watchlist.map((w) => `
            <li class="watchlist__item ${w.symbol === state.currentTicker ? 'watchlist__item--active' : ''}"
                onclick="loadSymbol('${w.exchange}:${w.symbol}')">
              <span class="watchlist__ticker">${w.symbol}</span>
              <span class="watchlist__name">${w.name}</span>
            </li>
          `).join('')}
        </ul>
      </div>
    </div>
  `;
  injectChart('wl-chart-container', state.currentSymbol, state.currentExchange);
}


// ═══════════════════════════════════════
// HYBRID CHART INJECTION
// Decides: TradingView embed vs Lightweight Charts
// ═══════════════════════════════════════

function injectChart(containerId, symbol, exchange) {
  if (state.tvSupported) {
    injectAdvancedChart(containerId, symbol);
  } else {
    injectLightweightChart(containerId, state.currentTicker, exchange);
  }
}


// ═══════════════════════════════════════
// LIGHTWEIGHT CHARTS (yfinance-powered fallback)
// ═══════════════════════════════════════

function destroyLightweightCharts() {
  state._lwCharts.forEach((chart) => {
    try { chart.remove(); } catch (e) { /* already removed */ }
  });
  state._lwCharts = [];
}

async function injectLightweightChart(containerId, ticker, exchange, period = '1y', interval = '1d') {
  const container = document.getElementById(containerId);
  if (!container) return;

  // Build the wrapper with toolbar
  container.innerHTML = `
    <div class="lw-chart-wrapper">
      <div class="lw-chart-toolbar">
        <span class="lw-chart-toolbar__label">Period</span>
        <div class="lw-chart-toolbar__group" id="lw-period-${containerId}">
          ${['1mo', '3mo', '6mo', '1y', '2y', '5y'].map((p) => `
            <button class="lw-chart-toolbar__btn ${p === period ? 'lw-chart-toolbar__btn--active' : ''}"
                    data-period="${p}"
                    onclick="changeLwPeriod('${containerId}', '${ticker}', '${exchange}', '${p}', '${interval}')">
              ${p.toUpperCase()}
            </button>
          `).join('')}
        </div>
        <div class="lw-chart-toolbar__separator"></div>
        <span class="lw-chart-toolbar__label">Interval</span>
        <div class="lw-chart-toolbar__group" id="lw-interval-${containerId}">
          ${['1d', '1wk', '1mo'].map((iv) => `
            <button class="lw-chart-toolbar__btn ${iv === interval ? 'lw-chart-toolbar__btn--active' : ''}"
                    data-interval="${iv}"
                    onclick="changeLwInterval('${containerId}', '${ticker}', '${exchange}', '${period}', '${iv}')">
              ${iv === '1d' ? 'D' : iv === '1wk' ? 'W' : 'M'}
            </button>
          `).join('')}
        </div>
        <div class="lw-chart-toolbar__info">
          <span class="lw-chart-toolbar__info-dot"></span>
          <span>${exchange}:${ticker}</span>
        </div>
      </div>
      <div class="lw-chart-container" id="lw-canvas-${containerId}">
        <div class="lw-chart-loading">
          <div class="loading-spinner"></div>
          <div class="loading-text">Loading chart data...</div>
        </div>
      </div>
    </div>
  `;

  // Fetch data and render
  const data = await fetchHistory(ticker, exchange, period, interval);
  const canvasContainer = document.getElementById(`lw-canvas-${containerId}`);
  if (!canvasContainer) return;

  if (!data.candles || data.candles.length === 0) {
    canvasContainer.innerHTML = `
      <div class="lw-chart-loading">
        <div class="loading-text">No chart data available for ${exchange}:${ticker}</div>
      </div>
    `;
    return;
  }

  // Clear loading
  canvasContainer.innerHTML = '';

  // Create chart
  const chart = LightweightCharts.createChart(canvasContainer, {
    autoSize: true,
    layout: {
      background: { type: 'solid', color: '#111219' },
      textColor: '#8a8ca0',
      fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
      fontSize: 10,
    },
    grid: {
      vertLines: { color: 'rgba(30, 32, 48, 0.6)' },
      horzLines: { color: 'rgba(30, 32, 48, 0.6)' },
    },
    crosshair: {
      mode: 0, // Normal crosshair
      vertLine: {
        color: 'rgba(255, 140, 0, 0.3)',
        width: 1,
        style: 2, // Dashed
        labelBackgroundColor: '#ff8c00',
      },
      horzLine: {
        color: 'rgba(255, 140, 0, 0.3)',
        width: 1,
        style: 2,
        labelBackgroundColor: '#ff8c00',
      },
    },
    rightPriceScale: {
      borderColor: '#1e2030',
      scaleMargins: { top: 0.1, bottom: 0.25 },
    },
    timeScale: {
      borderColor: '#1e2030',
      timeVisible: false,
    },
  });

  state._lwCharts.push(chart);

  // Candlestick series
  const candleSeries = chart.addSeries(LightweightCharts.CandlestickSeries, {
    upColor: '#26a69a',
    downColor: '#ef5350',
    borderVisible: false,
    wickUpColor: '#26a69a',
    wickDownColor: '#ef5350',
  });
  candleSeries.setData(data.candles);

  // Volume histogram on separate scale
  const volumeSeries = chart.addSeries(LightweightCharts.HistogramSeries, {
    priceFormat: { type: 'volume' },
    priceScaleId: 'volume',
  });
  volumeSeries.priceScale().applyOptions({
    scaleMargins: { top: 0.8, bottom: 0 },
  });
  volumeSeries.setData(data.volumes);

  // Fit content
  chart.timeScale().fitContent();
}

function changeLwPeriod(containerId, ticker, exchange, period, interval) {
  destroyLightweightCharts();
  injectLightweightChart(containerId, ticker, exchange, period, interval);
}

function changeLwInterval(containerId, ticker, exchange, period, interval) {
  destroyLightweightCharts();
  injectLightweightChart(containerId, ticker, exchange, period, interval);
}


// ═══════════════════════════════════════
// TRADINGVIEW WIDGET INJECTORS
// ═══════════════════════════════════════

function createWidgetContainer(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return null;
  container.innerHTML = '';

  const widgetDiv = document.createElement('div');
  widgetDiv.className = 'tradingview-widget-container';
  widgetDiv.style.width = '100%';
  widgetDiv.style.height = '100%';

  const innerDiv = document.createElement('div');
  innerDiv.className = 'tradingview-widget-container__widget';
  innerDiv.style.width = '100%';
  innerDiv.style.height = '100%';
  widgetDiv.appendChild(innerDiv);

  container.appendChild(widgetDiv);
  return widgetDiv;
}

function injectWidget(containerId, scriptSrc, config) {
  const widgetDiv = createWidgetContainer(containerId);
  if (!widgetDiv) return;

  const script = document.createElement('script');
  script.type = 'text/javascript';
  script.src = scriptSrc;
  script.async = true;
  script.textContent = JSON.stringify(config);
  widgetDiv.appendChild(script);
}

function injectAdvancedChart(containerId, symbol) {
  injectWidget(containerId,
    'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js',
    {
      autosize: true,
      symbol: symbol,
      interval: 'D',
      timezone: 'Europe/Berlin',
      theme: 'dark',
      style: '1',
      locale: 'en',
      backgroundColor: '#111219',
      gridColor: 'rgba(30, 32, 48, 0.6)',
      hide_top_toolbar: false,
      hide_legend: false,
      allow_symbol_change: true,
      save_image: false,
      calendar: false,
      hide_volume: false,
      support_host: 'https://www.tradingview.com',
    }
  );
}

function injectSymbolProfile(containerId, symbol) {
  injectWidget(containerId,
    'https://s3.tradingview.com/external-embedding/embed-widget-symbol-profile.js',
    { width: '100%', height: '100%', isTransparent: true, colorTheme: 'dark', symbol, locale: 'en' }
  );
}

function injectFinancials(containerId, symbol) {
  injectWidget(containerId,
    'https://s3.tradingview.com/external-embedding/embed-widget-financials.js',
    { isTransparent: true, largeChartUrl: '', displayMode: 'regular', width: '100%', height: '100%', colorTheme: 'dark', symbol, locale: 'en' }
  );
}


// ═══════════════════════════════════════
// TICKER TAPE
// ═══════════════════════════════════════

function renderTickerTape() {
  const container = document.getElementById('ticker-tape');
  if (!container) return;
  container.innerHTML = '';

  const widgetDiv = document.createElement('div');
  widgetDiv.className = 'tradingview-widget-container';
  widgetDiv.style.width = '100%';
  widgetDiv.style.height = '40px';

  const innerDiv = document.createElement('div');
  innerDiv.className = 'tradingview-widget-container__widget';
  widgetDiv.appendChild(innerDiv);

  const script = document.createElement('script');
  script.type = 'text/javascript';
  script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-ticker-tape.js';
  script.async = true;
  script.textContent = JSON.stringify({
    symbols: [
      { proName: 'FOREXCOM:SPXUSD', title: 'S&P 500' },
      { proName: 'FOREXCOM:NSXUSD', title: 'US 100' },
      { proName: 'FX_IDC:EURUSD', title: 'EUR/USD' },
      { proName: 'BITSTAMP:BTCUSD', title: 'Bitcoin' },
      { proName: 'BITSTAMP:ETHUSD', title: 'Ethereum' },
      { proName: 'NASDAQ:AAPL', title: 'Apple' },
      { proName: 'NASDAQ:MSFT', title: 'Microsoft' },
      { proName: 'NASDAQ:NVDA', title: 'NVIDIA' },
      { proName: 'NASDAQ:GOOGL', title: 'Alphabet' },
      { proName: 'NASDAQ:AMZN', title: 'Amazon' },
      { proName: 'NASDAQ:TSLA', title: 'Tesla' },
      { proName: 'NASDAQ:META', title: 'Meta' },
    ],
    showSymbolLogo: true,
    isTransparent: true,
    displayMode: 'adaptive',
    colorTheme: 'dark',
    locale: 'en',
  });
  widgetDiv.appendChild(script);
  container.appendChild(widgetDiv);
}


// ═══════════════════════════════════════
// WATCHLIST MANAGEMENT
// ═══════════════════════════════════════

function addToWatchlist() {
  const { currentTicker: symbol, currentExchange: exchange } = state;
  if (!state.watchlist.find((w) => w.symbol === symbol)) {
    const name = state.companyInfo?.name || symbol;
    state.watchlist.push({ symbol, exchange, name });
    if (state.activeTab === 'watchlist') loadTabContent('watchlist');
  }
}


// ═══════════════════════════════════════
// CLOCK
// ═══════════════════════════════════════

function initClock() {
  function updateClock() {
    const now = new Date();
    const time = now.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const clockEl = $('#header-clock');
    if (clockEl) clockEl.textContent = time;

    const dateEl = $('#status-date');
    if (dateEl)
      dateEl.textContent = now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  }
  updateClock();
  setInterval(updateClock, 1000);
}


// ═══════════════════════════════════════
// STATUS BAR
// ═══════════════════════════════════════

function updateStatusBar() {
  const symbolEl = $('#status-symbol');
  if (symbolEl) symbolEl.textContent = state.currentSymbol;

  const dot = $('#status-live-dot');
  const label = $('#status-live-label');
  const source = $('#status-datasource');

  if (state.tvSupported) {
    // TradingView — live streaming data
    if (dot) { dot.classList.remove('delayed-dot'); }
    if (label) { label.textContent = 'LIVE'; }
    if (source) { source.textContent = 'Data: TradingView'; }
  } else {
    // yfinance fallback — delayed/historical data
    if (dot) { dot.classList.add('delayed-dot'); }
    if (label) { label.textContent = 'DELAYED'; }
    if (source) { source.textContent = 'Data: Yahoo Finance'; }
  }
}


// ═══════════════════════════════════════
// KEYBOARD SHORTCUTS
// ═══════════════════════════════════════

function initKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    // Don't trigger in inputs
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    // Escape closes article modal
    if (e.key === 'Escape') {
      // Priority 1: close article modal if open
      const modal = document.getElementById('article-modal');
      if (modal && modal.classList.contains('article-modal--visible')) {
        closeArticleModal();
        return;
      }
      // Priority 2: return to Home (Bloomberg-style)
      if (state.activeTab !== 'home') {
        setActiveTab('home');
      }
      return;
    }

    // / or Cmd+K = focus search
    if (e.key === '/' || (e.metaKey && e.key === 'k')) {
      e.preventDefault();
      $('#ticker-input').focus();
    }

    // 1-6 = ticker tabs (only active when a symbol is loaded).
    // Bindings are stock-context for now; future: asset-class-aware.
    if (e.key >= '1' && e.key <= '6' && state.symbolLoaded) {
      const tabs = ['overview', 'chart', 'news', 'financials', 'profile', 'watchlist'];
      const idx = parseInt(e.key) - 1;
      if (tabs[idx]) setActiveTab(tabs[idx]);
    }
  });
}
