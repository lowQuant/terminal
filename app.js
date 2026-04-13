/* ═══════════════════════════════════════════════════════════
   TERMINAL — App Logic
   Bloomberg-Inspired Stock Terminal
   Global Search, Hybrid Charts, Exchange-Aware Data
   ═══════════════════════════════════════════════════════════ */

// ── State ──

// Load worksheets from localStorage, or create default
const _defaultWorksheets = [
  {
    id: 1, name: 'Sheet 1', tickers: [
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
    ]
  }
];

function _loadWorksheets() {
  try {
    const raw = localStorage.getItem('terminal_worksheets');
    if (raw) {
      const ws = JSON.parse(raw);
      if (Array.isArray(ws) && ws.length > 0) return ws;
    }
  } catch (_) { /* ignore */ }
  return JSON.parse(JSON.stringify(_defaultWorksheets));
}

const state = {
  currentSymbol: 'NASDAQ:AAPL',   // TradingView format: EXCHANGE:TICKER
  currentExchange: 'NASDAQ',
  currentTicker: 'AAPL',
  activeTab: 'home',
  activeFunction: null,             // non-null → a function view (ECO, EVTS, …) is active
  symbolLoaded: false,              // becomes true after the first ticker search
  recentSymbols: JSON.parse(localStorage.getItem('terminal_recent') || '[]'),
  companyInfo: null,
  newsData: null,
  tvSupported: true,               // Whether TradingView embed works for current exchange
  exchangeMap: {},                  // Loaded from /api/exchanges
  searchResults: [],
  searchActiveIndex: -1,           // Keyboard nav index in dropdown
  // Worksheet-based watchlist
  worksheets: _loadWorksheets(),
  activeWorksheetId: parseInt(localStorage.getItem('terminal_active_ws') || '1', 10),
  wlViewMode: '1-split', // 'max', '1-split', '2-split'
  wlQuoteData: {},                  // keyed by symbol
  wlEditingSymbol: null,
  wlSortCol: null,
  wlSortDir: 1,
  wlSplitMode: 'chart',
  // Backward compat — computed getter
  get watchlist() {
    const ws = this.worksheets.find(w => w.id === this.activeWorksheetId);
    return ws ? ws.tickers : (this.worksheets[0]?.tickers || []);
  },
  // Lightweight Charts instances (for cleanup)
  _lwCharts: [],
};

// Expose app state globally so sibling scripts (wf.js) can read things
// like the active watchlist. Top-level ``const`` is not attached to
// ``window`` automatically.
window.state = state;

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
  initSymbolBarInput();
  initBurgerMenu();
  renderTickerTape();
  // Start on the Home page — no ticker loaded until the user searches one.
  setActiveTab('home');
}

// ═══════════════════════════════════════
// MOBILE BURGER MENU
// ═══════════════════════════════════════

function initBurgerMenu() {
  const burgerBtn = document.getElementById('burger-btn');
  const mobileMenu = document.getElementById('mobile-menu');
  if (!burgerBtn || !mobileMenu) return;

  // Sync mobile user name with the desktop user-display-name
  const desktopName = document.getElementById('user-display-name');
  const mobileName = document.getElementById('mobile-user-name');
  if (desktopName && mobileName) {
    mobileName.textContent = desktopName.textContent;
    // Keep in sync if it changes later
    new MutationObserver(() => {
      mobileName.textContent = desktopName.textContent;
    }).observe(desktopName, { childList: true, characterData: true, subtree: true });
  }

  // Toggle burger menu
  burgerBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = mobileMenu.classList.toggle('mobile-menu--visible');
    burgerBtn.classList.toggle('header__burger--open', isOpen);
  });

  // Close menu when clicking outside
  document.addEventListener('click', (e) => {
    if (!mobileMenu.contains(e.target) && e.target !== burgerBtn) {
      mobileMenu.classList.remove('mobile-menu--visible');
      burgerBtn.classList.remove('header__burger--open');
    }
  });

  // Wire mobile settings button → same as desktop
  const mobileSettingsBtn = document.getElementById('mobile-settings-btn');
  const desktopSettingsBtn = document.getElementById('settings-btn');
  if (mobileSettingsBtn && desktopSettingsBtn) {
    mobileSettingsBtn.addEventListener('click', () => {
      mobileMenu.classList.remove('mobile-menu--visible');
      burgerBtn.classList.remove('header__burger--open');
      desktopSettingsBtn.click();
    });
  }

  // Wire mobile logout button → same as desktop
  const mobileLogoutBtn = document.getElementById('mobile-logout-btn');
  const desktopLogoutBtn = document.getElementById('logout-btn');
  if (mobileLogoutBtn && desktopLogoutBtn) {
    mobileLogoutBtn.addEventListener('click', () => {
      mobileMenu.classList.remove('mobile-menu--visible');
      burgerBtn.classList.remove('header__burger--open');
      desktopLogoutBtn.click();
    });
  }
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
// FUNCTION REGISTRY
// Bloomberg-style function codes (ECO, EVTS, …). Functions match in
// search autocomplete BEFORE tickers and open a dedicated function view
// via openFunction(code). Unimplemented ones are listed as teasers.
// ═══════════════════════════════════════

const FUNCTIONS = [
  {
    code: 'ECO',
    name: 'Economic Calendar',
    desc: 'Economic data releases & events',
    aliases: ['ECO', 'ECON', 'ECONOMIC', 'CALENDAR'],
    implemented: true,
  },
  {
    code: 'EVTS',
    name: 'Corporate Events',
    desc: 'Upcoming earnings & corporate events',
    aliases: ['EVTS', 'EVENTS', 'EARN', 'EARNINGS'],
    implemented: true,
  },
  {
    code: 'EQS',
    name: 'Equity Screener',
    desc: 'Screen stocks by any fundamental, technical or price metric',
    aliases: ['EQS', 'SCREEN', 'SCREENER', 'EQUITY'],
    implemented: true,
  },
  {
    code: 'CMDTY',
    name: 'Commodity Overview',
    desc: 'Major commodities snapshot',
    aliases: ['CMDTY', 'COMMODITY', 'COMMODITIES'],
    implemented: false,
  },
  {
    code: 'FX',
    name: 'Currency Cross Rates',
    desc: 'Foreign exchange cross rates',
    aliases: ['FX', 'FOREX', 'CURRENCY'],
    implemented: false,
  },
  {
    code: 'WEIF',
    name: 'World Equity Futures',
    desc: 'Global index futures',
    aliases: ['WEIF', 'FUTURES'],
    implemented: false,
  },
  {
    code: 'MOST',
    name: 'Most Active',
    desc: 'Gainers, losers, volume leaders & pre-market',
    aliases: ['MOST', 'ACTIVE', 'GAINERS', 'LOSERS', 'PREMARKET'],
    implemented: true,
  },
  {
    code: 'MOV',
    name: 'Index Movers',
    desc: 'Which stocks drive an index up or down',
    aliases: ['MOV', 'MOVERS', 'INDEX'],
    implemented: true,
  },
  {
    code: 'W',
    name: 'Worksheet',
    desc: 'Your personalized worksheet',
    aliases: ['W', 'WATCHLIST', 'WORKSHEET'],
    implemented: true,
    tabTarget: 'watchlist',
  },
  {
    code: 'OMON',
    name: 'Options Monitor',
    desc: 'Options chain with Greeks & volume',
    aliases: ['OMON', 'OPTIONS', 'CHAIN', 'OPTIONCHAIN'],
    implemented: true,
    stockSpecific: true,
  },
  {
    code: 'IVOL',
    name: 'Options Volatility',
    desc: 'Implied volatility smile & skew curves',
    aliases: ['IVOL', 'OVOL', 'VOLSMILE', 'VOLA'],
    implemented: true,
    stockSpecific: true,
  },
  {
    code: 'WF',
    name: 'Workflows',
    desc: 'Agentic research workflows — chain functions with Claude analysis',
    aliases: ['WF', 'WORKFLOW', 'WORKFLOWS', 'AGENT', 'RUN'],
    implemented: true,
  },
  {
    code: 'IMAP',
    name: 'Interactive Heatmaps',
    desc: 'Stock, ETF, crypto & FX heatmaps with sector/asset breakdowns',
    aliases: ['IMAP', 'HEATMAP', 'HEATMAPS', 'MAP', 'STOCKMAP', 'ETFMAP', 'FXMAP'],
    implemented: true,
  },
  // Bloomberg tab shortcuts — route to stock-context tabs
  {
    code: 'DES',
    name: 'Description / Overview',
    desc: 'Company overview & fundamentals',
    aliases: ['DES', 'DESCRIPTION'],
    implemented: true,
    stockSpecific: true,
    tabTarget: 'overview',
  },
  {
    code: 'GP',
    name: 'Graph / Chart',
    desc: 'Price chart',
    aliases: ['GP', 'GRAPH'],
    implemented: true,
    stockSpecific: true,
    tabTarget: 'chart',
  },
  {
    code: 'CN',
    name: 'Company News',
    desc: 'Latest news for the security',
    aliases: ['CN', 'NEWS'],
    implemented: true,
    stockSpecific: true,
    tabTarget: 'news',
  },
  {
    code: 'FA',
    name: 'Financial Analysis',
    desc: 'Financial statements & ratios — Highlights · IS · BS · CF · Ratios',
    aliases: ['FA', 'FINANCIALS'],
    implemented: true,
    stockSpecific: true,
    tabTarget: 'financials',
  },
  {
    code: 'IS',
    name: 'Income Statement',
    desc: 'Revenue, expenses, net income',
    aliases: ['IS', 'INCOME', 'PNL'],
    implemented: true,
    stockSpecific: true,
    tabTarget: 'financials',
    faSubTab: 'income',
  },
  {
    code: 'BS',
    name: 'Balance Sheet',
    desc: 'Assets, liabilities, equity',
    aliases: ['BS', 'BALANCESHEET', 'BALANCE'],
    implemented: true,
    stockSpecific: true,
    tabTarget: 'financials',
    faSubTab: 'balance',
  },
  {
    code: 'CF',
    name: 'Cash Flow',
    desc: 'Operating, investing, financing cash flows',
    aliases: ['CF', 'CASHFLOW'],
    implemented: true,
    stockSpecific: true,
    tabTarget: 'financials',
    faSubTab: 'cashflow',
  },
];

function matchFunctions(query) {
  const q = query.trim().toUpperCase();
  if (!q) return [];
  return FUNCTIONS.filter((fn) =>
    fn.code === q || fn.aliases.some((a) => a.startsWith(q))
  );
}

function openFunction(code) {
  const fn = FUNCTIONS.find((f) => f.code === code);
  if (!fn) return;
  if (!fn.implemented) {
    showToast(`${fn.code} — coming soon`);
    return;
  }

  // Stock-specific functions require a loaded ticker
  if (fn.stockSpecific && !state.symbolLoaded) {
    showToast(`${fn.code} — load a ticker first`);
    return;
  }

  // Dismiss search dropdown
  clearSearch();

  state.activeFunction = code;
  state.activeTab = null;

  // Tab shortcut functions — route to the stock tab instead of a function view
  if (fn.tabTarget) {
    state.activeFunction = null;

    // FA sub-tab targeting: when IS/BS/CF are invoked, pre-set the FA
    // active tab so the financials view opens directly on that section.
    if (fn.faSubTab && typeof faState !== 'undefined') {
      faState.activeTab = fn.faSubTab;
    }

    setActiveTab(fn.tabTarget);

    // Show function badge merged with the security header in the symbol bar
    const symbolBar = $('#symbol-bar');
    const fnBadge = $('#symbol-fn-badge');
    const exchangeEl = $('#symbol-exchange');
    const dividerEl = $('#symbol-divider');
    if (symbolBar) symbolBar.style.display = '';
    if (fnBadge) {
      fnBadge.innerHTML = `<span class="symbol-bar__fn-code">${fn.code}</span> ${escHtml(fn.name)}`;
      fnBadge.style.display = '';
    }
    if (exchangeEl) exchangeEl.style.display = 'none';
    if (dividerEl) dividerEl.style.display = 'none';
    return;
  }

  // Stock-specific functions keep the symbol bar visible
  const navTabs = $('#nav-tabs');
  const symbolBar = $('#symbol-bar');
  const fnBadge = $('#symbol-fn-badge');
  const exchangeEl = $('#symbol-exchange');
  const dividerEl = $('#symbol-divider');

  if (fn.stockSpecific) {
    if (navTabs) navTabs.style.display = 'none';
    if (symbolBar) symbolBar.style.display = '';
    // Show function badge in symbol bar, hide exchange
    if (fnBadge) {
      fnBadge.innerHTML = `<span class="symbol-bar__fn-code">${fn.code}</span> ${escHtml(fn.name)}`;
      fnBadge.style.display = '';
    }
    if (exchangeEl) exchangeEl.style.display = 'none';
    if (dividerEl) dividerEl.style.display = 'none';
  } else {
    if (navTabs) navTabs.style.display = 'none';
    if (symbolBar) symbolBar.style.display = 'none';
    if (fnBadge) fnBadge.style.display = 'none';
    if (exchangeEl) exchangeEl.style.display = '';
    if (dividerEl) dividerEl.style.display = '';
  }

  destroyLightweightCharts();

  const dashboard = $('#dashboard');
  switch (code) {
    case 'ECO':  renderEcoCalendar(dashboard); break;
    case 'EVTS': renderEventsCalendar(dashboard); break;
    case 'MOST': renderMostActive(dashboard); break;
    case 'MOV':  renderIndexMovers(dashboard); break;
    case 'EQS':  renderEquityScreener(dashboard); break;
    case 'OMON': renderOMON(dashboard); break;
    case 'IVOL': renderIVOL(dashboard); break;
    case 'WF':   renderWorkflowHub(dashboard); break;
    case 'IMAP': renderIMAP(dashboard); break;
  }
  updateStatusBar();
}

// ── Lightweight toast (used for "coming soon" messages) ──
function showToast(message) {
  let toast = document.getElementById('terminal-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'terminal-toast';
    toast.className = 'terminal-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add('terminal-toast--visible');
  clearTimeout(toast._hideTimer);
  toast._hideTimer = setTimeout(() => {
    toast.classList.remove('terminal-toast--visible');
  }, 2200);
}


// ═══════════════════════════════════════
// SEARCH / AUTOCOMPLETE
// ═══════════════════════════════════════

let _searchAbort = null; // AbortController for cancelling in-flight searches
let _searchClearing = false; // Guard flag to prevent dropdown re-opening during clearSearch()

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
    if (_searchClearing) return;
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
      if (!_searchClearing) {
        dropdown.classList.remove('recent-dropdown--visible');
      }
    }, 200);
  });

  input.addEventListener('input', () => {
    if (_searchClearing) return;
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
        // 1. Functions always take priority (e.g. "ECO" → Economic Calendar)
        const fnMatch = FUNCTIONS.find(
          (f) => f.code === val || f.aliases.includes(val)
        );
        if (fnMatch) {
          clearSearch();
          openFunction(fnMatch.code);
          return;
        }

        // 2. Check if it's already in EXCHANGE:TICKER format
        if (val.includes(':')) {
          const [exchange] = val.split(':');
          loadSymbol(val, isTvSupported(exchange));
        } else {
          // 3. Try to find in search results first
          const match = state.searchResults.find(
            (r) => r.ticker.toUpperCase() === val || r.symbol.toUpperCase() === val
          );
          if (match) {
            loadSymbol(match.tvSymbol, match.tvSupported);
          } else {
            // 4. Default: guess US exchange
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
      
      // If we press Escape from the search bar, navigate home (Bloomberg 2nd ESC behavior)
      if (state.activeTab !== 'home') {
        setActiveTab('home');
      }
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

function renderFunctionMatches(query) {
  const matches = matchFunctions(query);
  if (matches.length === 0) return '';
  let html = `<div class="recent-dropdown__header">Functions</div>`;
  html += matches.map((fn) => {
    const stateClass = fn.implemented ? '' : 'search-result--disabled';
    const badge = fn.implemented
      ? `<span class="search-result__fn-badge">FN</span>`
      : `<span class="search-result__fn-badge search-result__fn-badge--soon">SOON</span>`;
    return `
      <div class="search-result search-result--function ${stateClass}"
           onclick="openFunction('${fn.code}'); clearSearch();"
           data-function="${fn.code}">
        <span class="search-result__ticker search-result__ticker--function">${escHtml(fn.code)}</span>
        <div class="search-result__info">
          <span class="search-result__name">${escHtml(fn.name)}</span>
          <span class="search-result__exchange">${escHtml(fn.desc)}</span>
        </div>
        <div class="search-result__badges">${badge}</div>
      </div>
    `;
  }).join('');
  return html;
}

function renderSearchResults(results, query) {
  const dropdown = $('#recent-dropdown');

  // Functions always come first
  const functionsHtml = renderFunctionMatches(query);

  if (results.length === 0 && !functionsHtml) {
    // No API results and no function matches — fall back to watchlist filter
    renderWatchlistFilter(query);
    return;
  }

  let html = functionsHtml;

  if (results.length > 0) {
    html += `<div class="recent-dropdown__header">Search Results</div>`;
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
  }

  dropdown.innerHTML = html;
  dropdown.classList.add('recent-dropdown--visible', 'recent-dropdown--scrollable');
}

function clearSearch() {
  _searchClearing = true;
  const input = $('#ticker-input');
  if (input) { input.value = ''; input.blur(); }
  const dropdown = $('#recent-dropdown');
  if (dropdown) {
    dropdown.classList.remove('recent-dropdown--visible');
    dropdown.innerHTML = '';
  }
  state.searchResults = [];
  state.searchActiveIndex = -1;
  setTimeout(() => { _searchClearing = false; }, 50);
}

function renderWatchlistFilter(query) {
  const dropdown = $('#recent-dropdown');
  const val = query.toUpperCase();

  // Functions first
  let html = renderFunctionMatches(query);

  const filtered = state.watchlist.filter(
    (w) => w.symbol.includes(val) || w.name.toUpperCase().includes(val)
  );

  if (filtered.length > 0) {
    html += `<div class="recent-dropdown__header">Suggestions</div>`;
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

  loadSymbol(r.tvSymbol, r.tvSupported, r.name, r.yfExchange);

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

function loadSymbol(fullSymbol, tvSupported, companyName, yfExchange) {
  clearSearch();
  const parts = fullSymbol.split(':');
  const tvPrefix = parts.length > 1 ? parts[0] : 'NASDAQ';
  state.currentTicker = parts.length > 1 ? parts[1] : parts[0];
  state.currentSymbol = `${tvPrefix}:${state.currentTicker}`;
  // currentExchange is the INTERNAL key used for backend API calls
  // (may differ from the TV prefix — e.g. EURONEXT_AMS for ASML.AS).
  state.currentExchange = yfExchange || tvPrefix;

  // Determine TV support
  if (tvSupported !== undefined) {
    state.tvSupported = tvSupported;
  } else {
    state.tvSupported = isTvSupported(state.currentExchange);
  }

  // Route non-US stocks through yfinance + Lightweight Charts. TV's
  // embed coverage for international equities is inconsistent (missing
  // feeds, login walls, symbol mismatches), so we whitelist the
  // exchanges where the TV chart reliably works and fall back to
  // our own chart everywhere else.
  const TV_CHART_EXCHANGES = [
    'NASDAQ', 'NYSE', 'AMEX', 'NYSEARCA', 'OTC',
    'BINANCE', 'COINBASE', 'BITSTAMP', 'FX_IDC', 'FOREXCOM',
  ];
  if (!TV_CHART_EXCHANGES.includes(tvPrefix)) {
    state.tvSupported = false;
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
  state.activeFunction = null;    // leaving any function view
  updateSymbolBar(companyName);

  // If we were on the Home page or in a function view, flip to Overview.
  if (state.activeTab === 'home' || state.activeTab === null) {
    setActiveTab('overview');
  } else {
    loadTabContent(state.activeTab);
  }
  updateStatusBar();
}

function updateSymbolBar(companyName) {
  const tickerInput = $('#symbol-ticker-input');
  if (tickerInput) tickerInput.value = state.currentTicker;
  // Show the TV prefix in the symbol bar (cleaner than the internal
  // key — e.g. "EURONEXT" instead of "EURONEXT_AMS").
  $('#symbol-exchange').textContent = state.currentSymbol.split(':')[0];

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

// ── Symbol bar editable ticker input ──
function initSymbolBarInput() {
  const input = $('#symbol-ticker-input');
  if (!input) return;

  // Select all text on focus for easy replacement
  input.addEventListener('focus', () => {
    input.select();
  });

  // Enter = confirm ticker change
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const val = input.value.trim().toUpperCase();
      if (val && val !== state.currentTicker) {
        // Try to load as a ticker
        const currentFunction = state.activeFunction;
        loadSymbol(`NASDAQ:${val}`, true);
        // Re-open the same function after ticker change
        if (currentFunction) {
          setTimeout(() => openFunction(currentFunction), 300);
        }
      }
      input.blur();
    }
    if (e.key === 'Escape') {
      // Revert to current ticker and blur
      input.value = state.currentTicker;
      input.blur();
      if (state.activeTab !== 'home') {
        setActiveTab('home');
      }
    }
  });

  // Revert on blur if not confirmed
  input.addEventListener('blur', () => {
    input.value = state.currentTicker;
  });
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
  // Exiting a function view — clear it so Home / stock tabs render normally.
  if (tabName === 'home' || tabName !== null) {
    state.activeFunction = null;
  }
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
  } else if (state.symbolLoaded || tabName === 'watchlist') {
    if (symbolBar) symbolBar.style.display = '';
    if (navTabs) navTabs.style.display = '';
    // Restore exchange info, hide function badge when back on stock tabs
    const fnBadge = $('#symbol-fn-badge');
    const exchangeEl = $('#symbol-exchange');
    const dividerEl = $('#symbol-divider');
    if (fnBadge) fnBadge.style.display = 'none';
    if (exchangeEl) exchangeEl.style.display = '';
    if (dividerEl) dividerEl.style.display = '';
  }

  // Ticker-bound tab requested without a loaded symbol → fall back to Home (or auto-load Watchlist).
  if (tabName !== 'home' && !state.symbolLoaded) {
    if (tabName === 'watchlist') {
      if (state.watchlist && state.watchlist.length > 0) {
        const first = state.watchlist[0];
        loadSymbol(`${first.exchange}:${first.symbol}`);
        return;
      }
    } else {
      setActiveTab('home');
      return;
    }
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
            <div class="panel__title"><span class="panel__title-dot"></span> News</div>
            <div class="home-news-tabs" id="home-news-tabs">
              <button class="home-news-tab home-news-tab--active" data-feed="all_symbols">Markets</button>
              <button class="home-news-tab" data-feed="stock">Stocks</button>
              <button class="home-news-tab" data-feed="crypto">Crypto</button>
              <button class="home-news-tab" data-feed="forex">Forex</button>
              <button class="home-news-tab" data-feed="top">Top Stories</button>
            </div>
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
  injectTimeline('home-news-feed', 'all_symbols');

  // News tab switching — re-injects the widget with a new feed
  document.getElementById('home-news-tabs')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.home-news-tab');
    if (!btn) return;
    document.querySelectorAll('.home-news-tab').forEach((t) => t.classList.remove('home-news-tab--active'));
    btn.classList.add('home-news-tab--active');
    const feed = btn.dataset.feed;
    // Clear the current widget and inject the new one
    const container = document.getElementById('home-news-feed');
    if (container) container.innerHTML = '';
    injectTimeline('home-news-feed', feed);
  });
}

// ── Home page widget injectors ──
// NOTE on symbol curation: TradingView's free embed widgets only display
// data for symbols that have free public feeds. CME/NYMEX/COMEX futures,
// CBOE:VIX, TVC:DXY and TVC bond-yield tickers are gated behind a TV
// login and render as empty rows inside market-overview. We stick to
// FOREXCOM/INDEX/OANDA/TVC/BITSTAMP/BINANCE which are reliably public.
function injectMarketOverview(containerId) {
  // On mobile, hide the chart so more asset rows are visible
  const isMobile = window.innerWidth <= 700;
  injectWidget(containerId,
    'https://s3.tradingview.com/external-embedding/embed-widget-market-overview.js',
    {
      colorTheme: 'dark',
      dateRange: '12M',
      showChart: !isMobile,
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

function injectTimeline(containerId, feed = 'all_symbols') {
  // TradingView timeline widget supports:
  //   feedMode: 'all_symbols' → all market news
  //   feedMode: 'market' + market: 'stock'|'crypto'|'forex'|'index'
  // The 'top' feed is a shorthand for all_symbols with compact display.
  const config = {
    isTransparent: true,
    displayMode: 'regular',
    width: '100%',
    height: '100%',
    colorTheme: 'dark',
    locale: 'en',
  };

  if (feed === 'all_symbols' || feed === 'top') {
    config.feedMode = 'all_symbols';
  } else {
    config.feedMode = 'market';
    config.market = feed;  // 'stock', 'crypto', 'forex'
  }

  if (feed === 'top') {
    config.displayMode = 'compact';  // denser layout for top stories
  }

  injectWidget(containerId,
    'https://s3.tradingview.com/external-embedding/embed-widget-timeline.js',
    config
  );
}


// ═══════════════════════════════════════
// IMAP — Interactive Heatmaps
// ═══════════════════════════════════════
//
// Five TradingView heatmap widgets behind tabs: Stock, ETF, Crypto,
// FX Cross Rates, FX Heatmap. Each tab destroys the current widget
// and injects the new one — TradingView embeds don't support
// dynamic config changes.

const IMAP_TABS = [
  {
    id: 'stocks', label: 'Stocks',
    url: 'https://s3.tradingview.com/external-embedding/embed-widget-stock-heatmap.js',
    config: {
      dataSource: 'SPX500', grouping: 'sector',
      blockSize: 'market_cap_basic', blockColor: 'change',
      hasTopBar: true, isDataSetEnabled: true,
      isZoomEnabled: true, hasSymbolTooltip: true,
    },
  },
  {
    id: 'etfs', label: 'ETFs',
    url: 'https://s3.tradingview.com/external-embedding/embed-widget-etf-heatmap.js',
    config: {
      dataSource: 'AllUSEtf', grouping: 'asset_class',
      blockSize: 'aum', blockColor: 'change',
      hasTopBar: true, isDataSetEnabled: true,
      isZoomEnabled: true, hasSymbolTooltip: true,
    },
  },
  {
    id: 'crypto', label: 'Crypto',
    url: 'https://s3.tradingview.com/external-embedding/embed-widget-crypto-coins-heatmap.js',
    config: {
      dataSource: 'Crypto', blockSize: 'market_cap_calc',
      blockColor: 'change', hasTopBar: true,
      isDataSetEnabled: false, isZoomEnabled: true,
      hasSymbolTooltip: true,
    },
  },
  {
    id: 'fx-rates', label: 'FX Rates',
    url: 'https://s3.tradingview.com/external-embedding/embed-widget-forex-cross-rates.js',
    config: {
      currencies: ['EUR', 'USD', 'JPY', 'GBP', 'CHF', 'AUD', 'CAD', 'NZD', 'CNY'],
    },
  },
  {
    id: 'fx-heatmap', label: 'FX Heatmap',
    url: 'https://s3.tradingview.com/external-embedding/embed-widget-forex-heat-map.js',
    config: {
      currencies: ['EUR', 'USD', 'JPY', 'GBP', 'CHF', 'AUD', 'CAD', 'NZD', 'CNY'],
    },
  },
];

function renderIMAP(container) {
  container.className = 'dashboard dashboard--function';
  container.innerHTML = `
    <div class="function-wrapper">
      <header class="function-header">
        <div class="function-header__title-row">
          <div class="function-header__code">IMAP</div>
          <div class="function-header__name">
            <div class="function-header__name-main">Interactive Heatmaps</div>
            <div class="function-header__name-sub">Stock, ETF, crypto &amp; FX heatmaps</div>
          </div>
        </div>
      </header>

      <div class="function-toolbar">
        <div class="range-filter" id="imap-tabs">
          ${IMAP_TABS.map((t, i) => `
            <button class="country-btn ${i === 0 ? 'country-btn--active' : ''}"
                    data-imap="${t.id}">${t.label}</button>
          `).join('')}
        </div>
      </div>

      <div class="panel function-panel function-panel--heatmap">
        <div class="panel__body" id="imap-widget-container"></div>
      </div>
    </div>
  `;

  // Wire tab clicks
  document.querySelectorAll('#imap-tabs .country-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#imap-tabs .country-btn').forEach((b) =>
        b.classList.remove('country-btn--active')
      );
      btn.classList.add('country-btn--active');
      injectImapWidget(btn.dataset.imap);
    });
  });

  // Load the default tab
  injectImapWidget('stocks');
  setDataSource('TradingView');
}

function injectImapWidget(tabId) {
  const tab = IMAP_TABS.find((t) => t.id === tabId);
  if (!tab) return;

  const containerId = 'imap-widget-container';
  const el = document.getElementById(containerId);
  if (el) el.innerHTML = '';

  injectWidget(containerId, tab.url, {
    ...tab.config,
    colorTheme: 'dark',
    isTransparent: true,
    locale: 'en',
    width: '100%',
    height: '100%',
  });
}


// ═══════════════════════════════════════
// ECO — Economic Calendar
// ═══════════════════════════════════════
//
// Uses TradingView's embed-widget-events.js widget, which renders a
// compact but dataful table. The widget doesn't expose column headers,
// so we draw a static header bar above the iframe whose tracks
// approximately align with the widget's internal columns.

// ECO uses TradingView's built-in country filter — no custom filter needed.

function renderEcoCalendar(container) {
  container.className = 'dashboard dashboard--function';
  container.innerHTML = `
    <div class="function-wrapper">
      <header class="function-header">
        <div class="function-header__title-row">
          <div class="function-header__code">ECO</div>
          <div class="function-header__name">
            <div class="function-header__name-main">Economic Calendar</div>
            <div class="function-header__name-sub">Economic data releases &amp; events</div>
          </div>
        </div>
      </header>

      <div class="panel function-panel">
        <div class="eco-widget-headers">
          <div></div>
          <div class="eco-widget-headers__col">Actual</div>
          <div class="eco-widget-headers__col">Forecast</div>
          <div class="eco-widget-headers__col">Prior</div>
        </div>
        <div class="panel__body" id="eco-widget-container"></div>
      </div>
    </div>
  `;
  setDataSource('TradingView');
  injectEcoWidget();
}

function injectEcoWidget() {
  injectWidget('eco-widget-container',
    'https://s3.tradingview.com/external-embedding/embed-widget-events.js',
    {
      colorTheme: 'dark',
      isTransparent: true,
      width: '100%',
      height: '100%',
      locale: 'en',
      importanceFilter: '-1,0,1',
      countryFilter: 'us,eu,gb,de,fr,it,es,ch,jp,cn,in,kr,au,nz,ca,mx,br,tr,za',
    }
  );
}


// ═══════════════════════════════════════
// REUSABLE: COLUMN FILTERS
// ═══════════════════════════════════════
//
// Generic min/max filter system for function tables. Each filterable
// numeric column gets a pair of inputs. The filter state is a plain
// object: { column_key: { min: Number|null, max: Number|null }, … }.
//
// Usage:
//   renderColumnFilters(containerId, columnsSpec, filterState, onChange)
//
// columnsSpec is an array of { key, label, placeholder }.
// onChange is called after any filter value changes so the table can
// re-render with the new filters applied.

// Toggle filter visibility for a function view
function toggleFilters(barId, btnId) {
  const bar = document.getElementById(barId);
  const btn = document.getElementById(btnId);
  if (!bar) return;
  const show = bar.hidden;
  bar.hidden = !show;
  if (btn) btn.classList.toggle('filter-toggle--active', show);
}

function renderColumnFilters(containerId, columns, filterState, onChange) {
  const container = document.getElementById(containerId);
  if (!container) return;

  container.innerHTML = columns.map((col) => {
    const f = filterState[col.key] || {};
    return `
      <div class="filter-group">
        <span class="filter-group__label">${escHtml(col.label)}</span>
        <input class="filter-group__input" type="text"
               data-filter-key="${col.key}" data-filter-bound="min"
               placeholder="Min" value="${f.min != null ? f.min : ''}"
               title="Min ${col.label}">
        <span class="filter-group__sep">–</span>
        <input class="filter-group__input" type="text"
               data-filter-key="${col.key}" data-filter-bound="max"
               placeholder="Max" value="${f.max != null ? f.max : ''}"
               title="Max ${col.label}">
      </div>
    `;
  }).join('');

  // Wire input events (debounced). onChange receives the changed key
  // so callers can decide whether to refetch or just re-render.
  container.querySelectorAll('.filter-group__input').forEach((input) => {
    const debouncedApply = debounce(() => onChange(input.dataset.filterKey), 400);
    input.addEventListener('input', () => {
      const key = input.dataset.filterKey;
      const bound = input.dataset.filterBound;
      if (!filterState[key]) filterState[key] = {};
      filterState[key][bound] = parseFilterValue(input.value.trim());
      debouncedApply();
    });
  });
}

/**
 * Parse a human-entered filter value that may contain suffixes like
 * K, M, B, T (e.g. "1B" → 1_000_000_000, "500M" → 500_000_000).
 * Returns a number or null.
 */
function parseFilterValue(s) {
  if (!s) return null;
  s = s.replace(/[$,\s]/g, '');
  const multipliers = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };
  const last = s.slice(-1).toUpperCase();
  if (multipliers[last]) {
    const num = parseFloat(s.slice(0, -1));
    return isNaN(num) ? null : num * multipliers[last];
  }
  const num = parseFloat(s);
  return isNaN(num) ? null : num;
}

/**
 * Apply column filters to an array of rows.
 * filterState: { key: { min, max }, … }
 * Returns filtered array.
 */
function applyColumnFilters(rows, filterState) {
  return rows.filter((row) => {
    for (const [key, bounds] of Object.entries(filterState)) {
      const val = row[key];
      if (val == null) continue; // don't filter out rows with missing data
      if (bounds.min != null && val < bounds.min) return false;
      if (bounds.max != null && val > bounds.max) return false;
    }
    return true;
  });
}


// ═══════════════════════════════════════
// EVTS — Corporate Events (Earnings Calendar)
// ═══════════════════════════════════════
//
// Data source: NASDAQ's public earnings calendar API — all US-listed
// companies reporting each day (no curated universe, no API key).
// Currently US-only; other regions are surfaced as "coming soon"
// placeholder buttons to keep the UI honest.

let _evtsData = null;

const evtsState = {
  days: 14,
  scope: 'all',          // 'all' | 'watchlist'
  country: 'US',         // any code from _countries.py
  filters: {},           // { market_cap: {min, max}, eps_estimate: {min, max}, … }
  displayCurrency: '',   // '' = local currency, or 'USD'/'EUR'/'GBP'/… for conversion
  localCurrency: 'USD',  // set from backend response
  fxRates: null,         // cached from /api/fx/rates
};

// Filterable numeric columns in EVTS. Each entry generates a min/max
// filter pair in the toolbar. Adding a column here = instant filter.
const EVTS_FILTER_COLUMNS = [
  { key: 'market_cap',    label: 'Market Cap',  fmt: fmtBigNum, placeholder: 'e.g. 1B' },
  { key: 'eps_estimate',  label: 'EPS Est.',    fmt: (v) => v != null ? v.toFixed(2) : '—', placeholder: 'e.g. 0.5' },
  { key: 'last_year_eps', label: 'Last Yr EPS', fmt: (v) => v != null ? v.toFixed(2) : '—', placeholder: 'e.g. 1.0' },
];

// Country lists are fetched from the backend registry (/api/countries/*).
// Cached in state so we only fetch once per session.
// Fallback to hardcoded US-only if the API call fails.
let _scannerCountries = null;  // fetched from /api/countries/scanner

async function getScannerCountries() {
  if (_scannerCountries) return _scannerCountries;
  try {
    const resp = await fetch('/api/countries/scanner');
    if (resp.ok) {
      const data = await resp.json();
      // EU is a virtual region (no single tv_scanner slug) — add it
      // at the front if we have European countries.
      const hasEurope = data.some((c) => c.region === 'europe');
      const list = hasEurope
        ? [{ code: 'EU', name: 'Europe', flag: '🇪🇺', region: 'europe' }, ...data]
        : data;
      _scannerCountries = list;
      return list;
    }
  } catch (e) { console.warn('Failed to fetch scanner countries:', e); }
  _scannerCountries = [{ code: 'US', name: 'United States', flag: '🇺🇸', region: 'americas' }];
  return _scannerCountries;
}

function renderEventsCalendar(container) {
  container.className = 'dashboard dashboard--function';

  container.innerHTML = `
    <div class="function-wrapper">
      <header class="function-header">
        <div class="function-header__title-row">
          <div class="function-header__code">EVTS</div>
          <div class="function-header__name">
            <div class="function-header__name-main">Corporate Events</div>
            <div class="function-header__name-sub" id="evts-subtitle">Upcoming earnings calendar</div>
          </div>
        </div>
      </header>

      <div class="function-toolbar">
        <div class="function-toolbar__label">Country</div>
        <select class="evts-country-select" id="evts-country-select">
          <option value="US">🇺🇸 United States</option>
        </select>

        <div class="function-toolbar__label" style="margin-left:14px">Scope</div>
        <div class="range-filter" id="evts-scope-filter">
          <button class="country-btn country-btn--active" data-scope="all" id="evts-scope-all">All</button>
          <button class="country-btn" data-scope="watchlist">My Watchlist</button>
        </div>

        <div class="function-toolbar__label" style="margin-left:14px">Window</div>
        <div class="range-filter" id="evts-range-filter">
          <button class="country-btn" data-range="7">7d</button>
          <button class="country-btn country-btn--active" data-range="14">14d</button>
          <button class="country-btn" data-range="30">30d</button>
        </div>

        <div class="function-toolbar__label" style="margin-left:14px">Currency</div>
        <select class="evts-country-select" id="evts-currency-select" style="min-width:100px">
          <option value="">Local</option>
          <option value="USD">USD</option>
          <option value="EUR">EUR</option>
          <option value="GBP">GBP</option>
          <option value="JPY">JPY</option>
          <option value="CHF">CHF</option>
          <option value="CAD">CAD</option>
          <option value="AUD">AUD</option>
          <option value="HKD">HKD</option>
          <option value="CNY">CNY</option>
        </select>

        <div class="function-toolbar__actions">
          <button class="filter-toggle" id="evts-filter-toggle" onclick="toggleFilters('evts-filters-bar','evts-filter-toggle')">
            <span class="filter-toggle__icon">&#9707;</span> Filters
          </button>
          <button class="country-btn country-btn--ghost" onclick="reloadEvtsCalendar()">Refresh</button>
        </div>
      </div>

      <div class="function-toolbar function-toolbar--filters" id="evts-filters-bar" hidden>
        <div class="function-toolbar__label">Filters</div>
        <div class="filter-inputs" id="evts-filter-inputs"></div>
      </div>

      <div class="panel function-panel">
        <div class="panel__body" id="evts-table-container">
          <div class="evts-loading">
            <div class="search-loading__spinner"></div>
            <span>Loading earnings calendar…</span>
          </div>
        </div>
      </div>
    </div>
  `;

  // Render the filter inputs based on EVTS_FILTER_COLUMNS
  renderColumnFilters('evts-filter-inputs', EVTS_FILTER_COLUMNS, evtsState.filters, () => renderEvtsTable());

  // Wire scope + range filters
  $$('#evts-scope-filter .country-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('#evts-scope-filter .country-btn').forEach((b) => b.classList.remove('country-btn--active'));
      btn.classList.add('country-btn--active');
      evtsState.scope = btn.dataset.scope;
      renderEvtsTable();
    });
  });
  $$('#evts-range-filter .country-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('#evts-range-filter .country-btn').forEach((b) => b.classList.remove('country-btn--active'));
      btn.classList.add('country-btn--active');
      evtsState.days = parseInt(btn.dataset.range);
      loadEvtsCalendar();
    });
  });

  // Wire country dropdown
  const countrySelect = $('#evts-country-select');
  if (countrySelect) {
    countrySelect.addEventListener('change', () => {
      evtsState.country = countrySelect.value;
      updateEvtsScopeLabel();
      loadEvtsCalendar();
    });
  }

  // Wire currency dropdown
  const currencySelect = $('#evts-currency-select');
  if (currencySelect) {
    currencySelect.addEventListener('change', async () => {
      evtsState.displayCurrency = currencySelect.value;
      // Fetch FX rates if needed and not cached
      if (evtsState.displayCurrency && !evtsState.fxRates) {
        try {
          const resp = await fetch('/api/fx/rates');
          if (resp.ok) {
            const data = await resp.json();
            evtsState.fxRates = data.rates || {};
          }
        } catch (e) { console.warn('FX rates fetch failed:', e); }
      }
      renderEvtsTable();
    });
  }

  // Populate country dropdown from registry, then load data
  getScannerCountries().then((countries) => {
    populateEvtsCountryDropdown(countries);
    updateEvtsScopeLabel();
    loadEvtsCalendar();
  });
}

function populateEvtsCountryDropdown(countries) {
  const select = $('#evts-country-select');
  if (!select) return;

  // Group by region for a clean optgroup structure
  const regions = {
    americas:           'Americas',
    europe:             'Europe',
    asia_pacific:       'Asia Pacific',
    middle_east_africa: 'Middle East & Africa',
    other:              'Other',
  };

  const grouped = {};
  countries.forEach((c) => {
    const r = c.region || 'other';
    (grouped[r] = grouped[r] || []).push(c);
  });

  let html = '';
  for (const [key, label] of Object.entries(regions)) {
    const items = grouped[key];
    if (!items || items.length === 0) continue;
    html += `<optgroup label="${escHtml(label)}">`;
    items.forEach((c) => {
      const selected = c.code === evtsState.country ? 'selected' : '';
      html += `<option value="${escHtml(c.code)}" ${selected}>${c.flag} ${escHtml(c.name)}</option>`;
    });
    html += `</optgroup>`;
  }
  select.innerHTML = html;
}

function updateEvtsScopeLabel() {
  const countries = _scannerCountries || [];
  const country = countries.find((c) => c.code === evtsState.country);
  const label = country ? `All ${country.name}` : 'All';
  const btn = $('#evts-scope-all');
  if (btn) btn.textContent = label;
  const sub = $('#evts-subtitle');
  if (sub) {
    sub.textContent = evtsState.country === 'US'
      ? 'Upcoming earnings — full US market coverage (NASDAQ)'
      : `Upcoming earnings — all ${country ? country.name : evtsState.country} (TradingView scanner)`;
  }
}

async function loadEvtsCalendar() {
  const container = $('#evts-table-container');
  if (!container) return;
  container.innerHTML = `
    <div class="evts-loading">
      <div class="search-loading__spinner"></div>
      <span>Loading ${escHtml(evtsState.country)} earnings calendar…</span>
    </div>
  `;

  try {
    const resp = await fetch(
      `/api/earnings-calendar?days=${evtsState.days}&country=${evtsState.country}`
    );
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const payload = await resp.json();
    if (payload.error) throw new Error(payload.error);
    // Backend returns {rows, source, country, local_currency}
    _evtsData = payload.rows || [];
    evtsState.localCurrency = payload.local_currency || 'USD';
    setDataSource(payload.source || 'EVTS');
    renderEvtsTable();
  } catch (err) {
    console.error('Failed to load earnings calendar:', err);
    container.innerHTML = `
      <div class="evts-empty">
        <div class="evts-empty__icon">⚠</div>
        <div>Could not load earnings calendar.</div>
        <div class="text-muted" style="font-size:11px;margin-top:8px;">${escHtml(err.message)}</div>
        <button class="country-btn country-btn--ghost" style="margin-top:14px" onclick="reloadEvtsCalendar()">Retry</button>
      </div>
    `;
  }
}

function renderEvtsTable() {
  const container = $('#evts-table-container');
  if (!container || !_evtsData) return;

  // 1. Scope filter
  let rows = _evtsData;
  if (evtsState.scope === 'watchlist') {
    const wlSet = new Set(state.watchlist.map((w) => w.symbol.toUpperCase()));
    rows = rows.filter((e) => wlSet.has((e.ticker || '').toUpperCase()));
  }

  // 2. Currency conversion — build display-ready rows with converted
  //    numeric values BEFORE applying column filters, so min/max
  //    thresholds match what the user actually sees on screen.
  const toCcy = evtsState.displayCurrency;
  rows = rows.map((e) => {
    let fx = 1;
    if (toCcy && evtsState.fxRates) {
      const rc = (_scannerCountries || []).find((c) => c.name === e.country);
      const fromCcy = (rc && rc.currency) || evtsState.localCurrency;
      if (fromCcy !== toCcy) {
        fx = _fxConvertRate(fromCcy, toCcy, evtsState.fxRates);
      }
    }
    return {
      ...e,
      _eps_estimate:  e.eps_estimate != null ? e.eps_estimate * fx : null,
      _last_year_eps: e.last_year_eps != null ? e.last_year_eps * fx : null,
      _market_cap:    e.market_cap != null ? e.market_cap * fx : null,
    };
  });

  // 3. Column filters — operate on the converted (_) values
  rows = rows.filter((row) => {
    for (const [key, bounds] of Object.entries(evtsState.filters)) {
      // Map filter keys to the converted fields
      const displayKey = '_' + key;
      const val = row[displayKey] != null ? row[displayKey] : row[key];
      if (val == null) continue;
      if (bounds.min != null && val < bounds.min) return false;
      if (bounds.max != null && val > bounds.max) return false;
    }
    return true;
  });

  if (rows.length === 0) {
    const countries = _scannerCountries || [];
    const country = countries.find((c) => c.code === evtsState.country);
    const scopeLabel = country ? country.name : evtsState.country;
    const msg = evtsState.scope === 'watchlist'
      ? 'No earnings in the window for tickers in your watchlist.'
      : `No earnings in the next ${evtsState.days} days for ${scopeLabel}.`;
    container.innerHTML = `
      <div class="evts-empty">
        <div class="evts-empty__icon">📅</div>
        <div>${escHtml(msg)}</div>
      </div>
    `;
    return;
  }

  // Group by date
  const byDate = {};
  rows.forEach((e) => {
    (byDate[e.date] = byDate[e.date] || []).push(e);
  });
  const sortedDates = Object.keys(byDate).sort();

  let html = `
    <div class="evts-table">
      <div class="evts-table__header">
        <div>Date</div>
        <div>Time</div>
        <div>Ticker</div>
        <div>Company</div>
        <div class="evts-table__num">EPS Est.</div>
        <div class="evts-table__num">Last Yr</div>
        <div class="evts-table__num">Mkt Cap</div>
      </div>
  `;

  sortedDates.forEach((dateKey) => {
    const dayRows = byDate[dateKey];
    const label = fmtEvtsDate(dateKey);
    html += `<div class="evts-table__date-row">${escHtml(label)} — ${dayRows.length} companies</div>`;
    dayRows.forEach((e) => {
      // US rows (from NASDAQ API) have bare tickers → default to
      // NASDAQ prefix. Non-US rows come from the TV scanner with a
      // Yahoo ticker (e.g. "ASML.AS") — searchAndLoad resolves it via
      // /api/search which returns the correct yfExchange internal key.
      const clickAction = evtsState.country === 'US'
        ? `loadSymbol('NASDAQ:${escHtml(e.ticker)}', true)`
        : `searchAndLoad('${escHtml(e.ticker)}')`;
      html += `
        <div class="evts-table__row" onclick="${clickAction}">
          <div class="evts-table__date">${escHtml(fmtEvtsShortDate(dateKey))}</div>
          <div class="evts-table__time">${escHtml(fmtEvtsTime(e.time))}</div>
          <div class="evts-table__ticker">${escHtml(e.ticker)}</div>
          <div class="evts-table__name">${escHtml(e.name || '')}</div>
          <div class="evts-table__num">${e._eps_estimate != null ? e._eps_estimate.toFixed(2) : '—'}</div>
          <div class="evts-table__num">${e._last_year_eps != null ? e._last_year_eps.toFixed(2) : '—'}</div>
          <div class="evts-table__num">${e._market_cap != null ? fmtBigNum(e._market_cap) : '—'}</div>
        </div>
      `;
    });
  });
  html += `</div>`;
  container.innerHTML = html;
}

// Convert between currencies using the cached EUR-based rate table.
function _fxConvertRate(from, to, rates) {
  if (!from || !to || from === to) return 1;
  const rateFrom = rates[from];
  const rateTo = rates[to];
  if (!rateFrom || !rateTo) return 1;
  return rateTo / rateFrom;
}

function reloadEvtsCalendar() {
  _evtsData = null;
  loadEvtsCalendar();
}

// Resolve a raw Yahoo ticker (e.g. "7203.T", "ASML.AS") to a TV symbol
// via the backend search endpoint, then load it. Used by non-US EVTS rows.
async function searchAndLoad(ticker) {
  try {
    const resp = await fetch(`/api/search?q=${encodeURIComponent(ticker)}`);
    if (resp.ok) {
      const results = await resp.json();
      const match = (results || []).find(
        (r) => r.symbol === ticker || r.ticker === ticker
      );
      if (match) {
        loadSymbol(match.tvSymbol, match.tvSupported, match.name, match.yfExchange);
        return;
      }
    }
  } catch (err) {
    console.warn('searchAndLoad failed:', err);
  }
  showToast(`Could not resolve ${ticker}`);
}

function fmtEvtsTime(t) {
  if (!t) return '—';
  const map = {
    'time-pre-market':    'BMO',    // Before Market Open
    'time-after-hours':   'AMC',    // After Market Close
    'time-not-supplied':  '—',
  };
  return map[t] || t;
}

function fmtEvtsDate(iso) {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
}

function fmtEvtsShortDate(iso) {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ═══════════════════════════════════════
// MOST — Most Active
// ═══════════════════════════════════════

const mostState = {
  country: 'US',
  view: 'gainers',      // gainers | losers | active | premarket
  limit: 50,
  filters: {},
  displayCurrency: '',
  fxRates: null,
};

const MOST_VIEWS = [
  { key: 'gainers',   label: 'Gainers' },
  { key: 'losers',    label: 'Losers' },
  { key: 'active',    label: 'Most Active' },
  { key: 'premarket', label: 'Pre-Market' },
];

const MOST_FILTER_COLUMNS = [
  { key: 'market_cap', label: 'Market Cap', placeholder: 'e.g. 1B' },
  { key: 'change',     label: 'Change %',   placeholder: 'e.g. 5' },
  { key: 'rel_volume', label: 'Rel Vol',    placeholder: 'e.g. 2' },
];

let _mostData = null;

function renderMostActive(container) {
  container.className = 'dashboard dashboard--function';
  container.innerHTML = `
    <div class="function-wrapper">
      <header class="function-header">
        <div class="function-header__title-row">
          <div class="function-header__code">MOST</div>
          <div class="function-header__name">
            <div class="function-header__name-main">Most Active</div>
            <div class="function-header__name-sub" id="most-subtitle">Gainers, losers, volume leaders & pre-market</div>
          </div>
        </div>
      </header>

      <div class="function-toolbar">
        <div class="function-toolbar__label">Country</div>
        <select class="evts-country-select" id="most-country-select" style="min-width:180px">
          <option value="US">🇺🇸 United States</option>
        </select>

        <div class="function-toolbar__label" style="margin-left:14px">View</div>
        <div class="range-filter" id="most-view-filter">
          ${MOST_VIEWS.map((v) => `
            <button class="country-btn ${v.key === mostState.view ? 'country-btn--active' : ''}"
                    data-view="${v.key}">${v.label}</button>
          `).join('')}
        </div>

        <div class="function-toolbar__label" style="margin-left:14px">Currency</div>
        <select class="evts-country-select" id="most-currency-select" style="min-width:100px">
          <option value="">Local</option>
          <option value="USD">USD</option>
          <option value="EUR">EUR</option>
          <option value="GBP">GBP</option>
          <option value="JPY">JPY</option>
          <option value="CHF">CHF</option>
        </select>
        <button class="filter-toggle" id="most-filter-toggle" onclick="toggleFilters('most-filters-bar','most-filter-toggle')">
          <span class="filter-toggle__icon">&#9707;</span> Filters
        </button>
      </div>

      <div class="function-toolbar function-toolbar--filters" id="most-filters-bar" hidden>
        <div class="function-toolbar__label">Filters</div>
        <div class="filter-inputs" id="most-filter-inputs"></div>
      </div>

      <div class="panel function-panel">
        <div class="panel__body" id="most-table-container">
          <div class="evts-loading">
            <div class="search-loading__spinner"></div>
            <span>Loading movers…</span>
          </div>
        </div>
      </div>
    </div>
  `;

  // Filters
  // Market cap filter triggers a server-side refetch (scanner pre-filters);
  // other filters are client-side only.
  renderColumnFilters('most-filter-inputs', MOST_FILTER_COLUMNS, mostState.filters, (changedKey) => {
    if (changedKey === 'market_cap') {
      loadMostData();  // refetch with new min_mcap
    } else {
      renderMostTable();
    }
  });

  // View tabs
  $$('#most-view-filter .country-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('#most-view-filter .country-btn').forEach((b) => b.classList.remove('country-btn--active'));
      btn.classList.add('country-btn--active');
      mostState.view = btn.dataset.view;
      loadMostData();
    });
  });

  // Country dropdown
  const countrySelect = $('#most-country-select');
  if (countrySelect) {
    countrySelect.addEventListener('change', () => {
      mostState.country = countrySelect.value;
      // Hide pre-market tab for non-US
      const pmBtn = document.querySelector('#most-view-filter [data-view="premarket"]');
      if (pmBtn) pmBtn.style.display = mostState.country === 'US' ? '' : 'none';
      if (mostState.view === 'premarket' && mostState.country !== 'US') {
        mostState.view = 'gainers';
        $$('#most-view-filter .country-btn').forEach((b) => b.classList.remove('country-btn--active'));
        document.querySelector('#most-view-filter [data-view="gainers"]').classList.add('country-btn--active');
      }
      loadMostData();
    });
  }

  // Currency dropdown
  const ccySelect = $('#most-currency-select');
  if (ccySelect) {
    ccySelect.addEventListener('change', async () => {
      mostState.displayCurrency = ccySelect.value;
      if (mostState.displayCurrency && !mostState.fxRates) {
        try {
          const resp = await fetch('/api/fx/rates');
          if (resp.ok) mostState.fxRates = (await resp.json()).rates || {};
        } catch (e) { console.warn('FX fetch failed:', e); }
      }
      renderMostTable();
    });
  }

  // Populate country dropdown then load
  getScannerCountries().then((countries) => {
    if (countrySelect) {
      const regions = { americas: 'Americas', europe: 'Europe', asia_pacific: 'Asia Pacific', middle_east_africa: 'Middle East & Africa' };
      const grouped = {};
      countries.forEach((c) => (grouped[c.region] = grouped[c.region] || []).push(c));
      let html = '';
      for (const [key, label] of Object.entries(regions)) {
        if (!grouped[key]) continue;
        html += `<optgroup label="${escHtml(label)}">`;
        grouped[key].forEach((c) => {
          html += `<option value="${escHtml(c.code)}" ${c.code === mostState.country ? 'selected' : ''}>${c.flag} ${escHtml(c.name)}</option>`;
        });
        html += `</optgroup>`;
      }
      countrySelect.innerHTML = html;
    }
    loadMostData();
  });
}

async function loadMostData() {
  const container = $('#most-table-container');
  if (!container) return;
  container.innerHTML = `
    <div class="evts-loading">
      <div class="search-loading__spinner"></div>
      <span>Loading ${escHtml(mostState.view)}…</span>
    </div>
  `;

  try {
    // Pass server-side market cap filter if the user set one
    const mcapMin = mostState.filters.market_cap?.min;
    const mcapParam = mcapMin ? `&min_mcap=${Math.round(mcapMin)}` : '';
    const resp = await fetch(
      `/api/movers?country=${mostState.country}&view=${mostState.view}&limit=${mostState.limit}${mcapParam}`
    );
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const payload = await resp.json();
    if (payload.error) throw new Error(payload.error);
    _mostData = payload.rows || [];
    setDataSource(payload.source || 'TradingView');
    renderMostTable();
  } catch (err) {
    console.error('Failed to load movers:', err);
    container.innerHTML = `
      <div class="evts-empty">
        <div class="evts-empty__icon">⚠</div>
        <div>Could not load movers.</div>
        <div class="text-muted" style="font-size:11px;margin-top:8px;">${escHtml(err.message)}</div>
      </div>
    `;
  }
}

function renderMostTable() {
  const container = $('#most-table-container');
  if (!container || !_mostData) return;

  const isPremarket = mostState.view === 'premarket';
  const toCcy = mostState.displayCurrency;

  // FX-convert then filter
  let rows = _mostData.map((e) => {
    let fx = 1;
    if (toCcy && mostState.fxRates) {
      const rc = (_scannerCountries || []).find((c) => c.name === e.country);
      const fromCcy = (rc && rc.currency) || 'USD';
      if (fromCcy !== toCcy) fx = _fxConvertRate(fromCcy, toCcy, mostState.fxRates);
    }
    return { ...e, _market_cap: e.market_cap != null ? e.market_cap * fx : null };
  });

  // Apply column filters on converted values
  rows = rows.filter((row) => {
    for (const [key, bounds] of Object.entries(mostState.filters)) {
      const val = key === 'market_cap' ? row._market_cap : row[key];
      if (val == null) continue;
      if (bounds.min != null && val < bounds.min) return false;
      if (bounds.max != null && val > bounds.max) return false;
    }
    return true;
  });

  if (rows.length === 0) {
    container.innerHTML = `<div class="evts-empty"><div class="evts-empty__icon">📊</div><div>No movers match the current filters.</div></div>`;
    return;
  }

  // Build header + rows
  let html = `<div class="most-table">
    <div class="most-table__header">
      <div>#</div>
      <div>Ticker</div>
      <div>Company</div>
      <div class="most-table__num">Price</div>
      <div class="most-table__num">${isPremarket ? 'PM Chg%' : 'Change%'}</div>
      <div class="most-table__num">${isPremarket ? 'PM Gap%' : 'Rel Vol'}</div>
      <div class="most-table__num">Volume</div>
      <div class="most-table__num">Mkt Cap</div>
      <div>Sector</div>
    </div>`;

  rows.forEach((e, i) => {
    const chg = isPremarket ? e.premarket_change : e.change;
    const chgClass = chg != null ? (chg >= 0 ? 'most-table__positive' : 'most-table__negative') : '';
    const col3 = isPremarket ? e.premarket_gap : e.rel_volume;

    const clickAction = mostState.country === 'US'
      ? `loadSymbol('NASDAQ:${escHtml(e.ticker)}', true)`
      : `searchAndLoad('${escHtml(e.ticker)}')`;

    html += `
      <div class="most-table__row" onclick="${clickAction}">
        <div class="most-table__rank">${i + 1}</div>
        <div class="most-table__ticker">${escHtml(e.ticker)}</div>
        <div class="most-table__name">${escHtml(e.name || '')}</div>
        <div class="most-table__num">${e.close != null ? e.close.toFixed(2) : '—'}</div>
        <div class="most-table__num ${chgClass}">${chg != null ? (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%' : '—'}</div>
        <div class="most-table__num">${col3 != null ? (isPremarket ? col3.toFixed(2) + '%' : col3.toFixed(1) + 'x') : '—'}</div>
        <div class="most-table__num">${e.volume != null ? fmtBigNum(e.volume) : '—'}</div>
        <div class="most-table__num">${e._market_cap != null ? fmtBigNum(e._market_cap) : '—'}</div>
        <div class="most-table__sector">${escHtml(e.sector || '')}</div>
      </div>
    `;
  });
  html += `</div>`;
  container.innerHTML = html;
}


// ═══════════════════════════════════════
// MOV — Index Movers
// ═══════════════════════════════════════

const movState = {
  index: 'SPX',
  sort: 'contribution',   // contribution | gainers | losers
  period: '1D',            // 1D | 1W | 1M | 3M | 6M | YTD | 1Y
  filters: {},
  displayCurrency: '',
  fxRates: null,
};

// TradingView scanner column names for each performance period
const MOV_PERIOD_COLUMNS = {
  '1D':  'change',
  '1W':  'Perf.W',
  '1M':  'Perf.1M',
  '3M':  'Perf.3M',
  '6M':  'Perf.6M',
  'YTD': 'Perf.YTD',
  '1Y':  'Perf.Y',
};

const MOV_INDICES = [
  { key: 'SPX',  label: 'S&P 500' },
  { key: 'NDX',  label: 'NASDAQ 100' },
  { key: 'DJI',  label: 'Dow Jones 30' },
  { key: 'SX5E', label: 'Euro Stoxx 50' },
  { key: 'DAX',  label: 'DAX 40' },
  { key: 'FTSE', label: 'FTSE 100' },
  { key: 'CAC',  label: 'CAC 40' },
  { key: 'NKY',  label: 'Nikkei 225' },
  { key: 'HSI',  label: 'Hang Seng' },
];

const MOV_FILTER_COLUMNS = [
  { key: 'market_cap',    label: 'Market Cap',    placeholder: 'e.g. 1B' },
  { key: 'change',        label: 'Change %',      placeholder: 'e.g. 2' },
  { key: 'weight',        label: 'Weight %',      placeholder: 'e.g. 1' },
  { key: 'contribution',  label: 'Contribution',  placeholder: 'e.g. 0.1' },
];

let _movData = null;

function renderIndexMovers(container) {
  container.className = 'dashboard dashboard--function';
  container.innerHTML = `
    <div class="function-wrapper">
      <header class="function-header">
        <div class="function-header__title-row">
          <div class="function-header__code">MOV</div>
          <div class="function-header__name">
            <div class="function-header__name-main">Index Movers</div>
            <div class="function-header__name-sub" id="mov-subtitle">Which stocks drive the index up or down</div>
          </div>
        </div>
      </header>

      <div class="function-toolbar">
        <div class="function-toolbar__label">Index</div>
        <select class="evts-country-select" id="mov-index-select" style="min-width:160px">
          ${MOV_INDICES.map((idx) =>
            `<option value="${idx.key}" ${idx.key === movState.index ? 'selected' : ''}>${escHtml(idx.label)}</option>`
          ).join('')}
        </select>

        <div class="function-toolbar__label" style="margin-left:14px">Period</div>
        <div class="range-filter" id="mov-period-filter">
          ${Object.keys(MOV_PERIOD_COLUMNS).map((p) =>
            `<button class="country-btn ${p === movState.period ? 'country-btn--active' : ''}" data-period="${p}">${p}</button>`
          ).join('')}
        </div>

        <div class="function-toolbar__label" style="margin-left:14px">Sort</div>
        <div class="range-filter" id="mov-sort-filter">
          <button class="country-btn country-btn--active" data-sort="contribution">Impact</button>
          <button class="country-btn" data-sort="gainers">Gainers</button>
          <button class="country-btn" data-sort="losers">Losers</button>
        </div>

        <div class="function-toolbar__label" style="margin-left:14px">Ccy</div>
        <select class="evts-country-select" id="mov-currency-select" style="min-width:80px">
          <option value="">Local</option>
          <option value="USD">USD</option>
          <option value="EUR">EUR</option>
          <option value="GBP">GBP</option>
          <option value="JPY">JPY</option>
        </select>

        <button class="filter-toggle" id="mov-filter-toggle" onclick="toggleFilters('mov-filters-bar','mov-filter-toggle')">
          <span class="filter-toggle__icon">&#9707;</span> Filters
        </button>
      </div>

      <div class="function-toolbar function-toolbar--filters" id="mov-filters-bar" hidden>
        <div class="function-toolbar__label">Filters</div>
        <div class="filter-inputs" id="mov-filter-inputs"></div>
      </div>

      <div class="panel function-panel">
        <div class="panel__body" id="mov-table-container">
          <div class="evts-loading">
            <div class="search-loading__spinner"></div>
            <span>Loading index movers…</span>
          </div>
        </div>
      </div>
    </div>
  `;

  renderColumnFilters('mov-filter-inputs', MOV_FILTER_COLUMNS, movState.filters, () => renderMovTable());

  // Index dropdown
  $('#mov-index-select')?.addEventListener('change', (e) => {
    movState.index = e.target.value;
    loadMovData();
  });

  // Period tabs
  $$('#mov-period-filter .country-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('#mov-period-filter .country-btn').forEach((b) => b.classList.remove('country-btn--active'));
      btn.classList.add('country-btn--active');
      movState.period = btn.dataset.period;
      loadMovData();
    });
  });

  // Sort tabs
  $$('#mov-sort-filter .country-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('#mov-sort-filter .country-btn').forEach((b) => b.classList.remove('country-btn--active'));
      btn.classList.add('country-btn--active');
      movState.sort = btn.dataset.sort;
      loadMovData();
    });
  });

  // Currency dropdown
  $('#mov-currency-select')?.addEventListener('change', async (e) => {
    movState.displayCurrency = e.target.value;
    if (movState.displayCurrency && !movState.fxRates) {
      try {
        const resp = await fetch('/api/fx/rates');
        if (resp.ok) movState.fxRates = (await resp.json()).rates || {};
      } catch (err) { console.warn('FX fetch failed:', err); }
    }
    renderMovTable();
  });

  loadMovData();
}

async function loadMovData() {
  const container = $('#mov-table-container');
  if (!container) return;
  const idx = MOV_INDICES.find((i) => i.key === movState.index);
  container.innerHTML = `
    <div class="evts-loading">
      <div class="search-loading__spinner"></div>
      <span>Loading ${escHtml(idx ? idx.label : movState.index)} movers…</span>
    </div>
  `;

  try {
    const resp = await fetch(
      `/api/index-movers?index=${movState.index}&sort=${movState.sort}&period=${movState.period}`
    );
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const payload = await resp.json();
    if (payload.error) throw new Error(payload.error);
    _movData = payload.rows || [];
    setDataSource(payload.source || 'TradingView');
    // Update subtitle
    const sub = $('#mov-subtitle');
    if (sub) sub.textContent = `${payload.label || movState.index} — ${_movData.length} constituents`;
    renderMovTable();
  } catch (err) {
    console.error('Failed to load index movers:', err);
    container.innerHTML = `
      <div class="evts-empty">
        <div class="evts-empty__icon">⚠</div>
        <div>Could not load index movers.</div>
        <div class="text-muted" style="font-size:11px;margin-top:8px;">${escHtml(err.message)}</div>
      </div>
    `;
  }
}

function renderMovTable() {
  const container = $('#mov-table-container');
  if (!container || !_movData) return;

  // FX conversion
  const toCcy = movState.displayCurrency;
  let rows = _movData.map((e) => {
    let fx = 1;
    if (toCcy && movState.fxRates) {
      const rc = (_scannerCountries || []).find((c) => c.name === e.country);
      const fromCcy = (rc && rc.currency) || 'USD';
      if (fromCcy !== toCcy) fx = _fxConvertRate(fromCcy, toCcy, movState.fxRates);
    }
    return { ...e, _market_cap: e.market_cap != null ? e.market_cap * fx : null };
  });

  // Apply filters on converted values
  rows = rows.filter((row) => {
    for (const [key, bounds] of Object.entries(movState.filters)) {
      const val = key === 'market_cap' ? row._market_cap : row[key];
      if (val == null) continue;
      if (bounds.min != null && val < bounds.min) return false;
      if (bounds.max != null && val > bounds.max) return false;
    }
    return true;
  });

  if (rows.length === 0) {
    container.innerHTML = `<div class="evts-empty"><div class="evts-empty__icon">📊</div><div>No results match the filters.</div></div>`;
    return;
  }

  const periodLabel = movState.period === '1D' ? 'Change%' : movState.period + ' Perf%';

  let html = `<div class="most-table">
    <div class="most-table__header">
      <div>#</div>
      <div>Ticker</div>
      <div>Company</div>
      <div class="most-table__num">Price</div>
      <div class="most-table__num">${escHtml(periodLabel)}</div>
      <div class="most-table__num">Weight%</div>
      <div class="most-table__num">Contribution</div>
      <div class="most-table__num">Mkt Cap</div>
      <div>Sector</div>
    </div>`;

  rows.forEach((e, i) => {
    const chgClass = e.change != null ? (e.change >= 0 ? 'most-table__positive' : 'most-table__negative') : '';
    const ctbClass = e.contribution != null ? (e.contribution >= 0 ? 'most-table__positive' : 'most-table__negative') : '';

    html += `
      <div class="most-table__row" onclick="searchAndLoad('${escHtml(e.ticker)}')">
        <div class="most-table__rank">${i + 1}</div>
        <div class="most-table__ticker">${escHtml(e.ticker)}</div>
        <div class="most-table__name">${escHtml(e.name || '')}</div>
        <div class="most-table__num">${e.close != null ? e.close.toFixed(2) : '—'}</div>
        <div class="most-table__num ${chgClass}">${e.change != null ? (e.change >= 0 ? '+' : '') + e.change.toFixed(2) + '%' : '—'}</div>
        <div class="most-table__num">${e.weight != null ? e.weight.toFixed(2) + '%' : '—'}</div>
        <div class="most-table__num ${ctbClass}">${e.contribution != null ? (e.contribution >= 0 ? '+' : '') + e.contribution.toFixed(3) : '—'}</div>
        <div class="most-table__num">${e._market_cap != null ? fmtBigNum(e._market_cap) : '—'}</div>
        <div class="most-table__sector">${escHtml(e.sector || '')}</div>
      </div>
    `;
  });
  html += `</div>`;
  container.innerHTML = html;
}


// ═══════════════════════════════════════
// EQS — Equity Screener (custom, scanner-API-driven)
// ═══════════════════════════════════════

const eqsState = {
  market: 'america',
  preset: 'overview',
  filters: [],           // [{field, op, value}]
  sort: { field: 'market_cap_basic', order: 'desc' },
  limit: 100,
};

let _eqsFields = null;   // fetched from /api/eqs/fields
let _eqsData = null;

function renderEquityScreener(container) {
  container.className = 'dashboard dashboard--function';
  container.innerHTML = `
    <div class="function-wrapper">
      <header class="function-header">
        <div class="function-header__title-row">
          <div class="function-header__code">EQS</div>
          <div class="function-header__name">
            <div class="function-header__name-main">Equity Screener</div>
            <div class="function-header__name-sub" id="eqs-subtitle">Screen stocks by fundamentals, technicals & price metrics</div>
          </div>
        </div>
      </header>

      <div class="function-toolbar">
        <div class="function-toolbar__label">Market</div>
        <select class="evts-country-select" id="eqs-market-select" style="min-width:160px">
          <option value="america">🇺🇸 United States</option>
        </select>

        <div class="function-toolbar__label" style="margin-left:14px">View</div>
        <div class="range-filter" id="eqs-preset-filter"></div>

        <button class="filter-toggle" id="eqs-filter-toggle" onclick="toggleFilters('eqs-filters-bar','eqs-filter-toggle')">
          <span class="filter-toggle__icon">&#9707;</span> Filters
        </button>
      </div>

      <div class="function-toolbar function-toolbar--filters" id="eqs-filters-bar" hidden>
        <div class="function-toolbar__label">Filters</div>
        <div class="eqs-filter-builder" id="eqs-filter-builder">
          <button class="country-btn country-btn--ghost" onclick="addEqsFilter()">+ Add Filter</button>
        </div>
      </div>

      <div class="panel function-panel">
        <div class="panel__body" id="eqs-table-container">
          <div class="evts-loading">
            <div class="search-loading__spinner"></div>
            <span>Loading screener…</span>
          </div>
        </div>
      </div>
    </div>
  `;

  // Fetch fields + presets, then populate UI
  _loadEqsFields().then(() => {
    _ensureFieldMap();
    _renderEqsPresets();
    _populateEqsMarkets();
    runEqsScan();
  });

  // Market change
  $('#eqs-market-select')?.addEventListener('change', (e) => {
    eqsState.market = e.target.value;
    runEqsScan();
  });

  setDataSource('TradingView');
}

async function _loadEqsFields() {
  if (_eqsFields) return;
  try {
    const resp = await fetch('/api/eqs/fields');
    if (resp.ok) _eqsFields = await resp.json();
  } catch (e) { console.warn('Failed to load EQS fields:', e); }
  if (!_eqsFields) _eqsFields = { categories: [], fields: {}, presets: {} };
}

function _renderEqsPresets() {
  const bar = $('#eqs-preset-filter');
  if (!bar || !_eqsFields) return;
  const presets = _eqsFields.presets || {};
  bar.innerHTML = Object.entries(presets).map(([key, cfg]) =>
    `<button class="country-btn ${key === eqsState.preset ? 'country-btn--active' : ''}" data-preset="${key}">${escHtml(cfg.label)}</button>`
  ).join('');
  $$('#eqs-preset-filter .country-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('#eqs-preset-filter .country-btn').forEach((b) => b.classList.remove('country-btn--active'));
      btn.classList.add('country-btn--active');
      eqsState.preset = btn.dataset.preset;
      runEqsScan();
    });
  });
}

function _populateEqsMarkets() {
  const select = $('#eqs-market-select');
  if (!select) return;
  fetch('/api/eqs/markets').then(r => r.ok ? r.json() : []).then((markets) => {
    const regions = { americas: 'Americas', europe: 'Europe', asia_pacific: 'Asia Pacific', middle_east_africa: 'Middle East & Africa' };
    const grouped = {};
    markets.forEach((m) => (grouped[m.region] = grouped[m.region] || []).push(m));
    let html = '';
    for (const [key, label] of Object.entries(regions)) {
      if (!grouped[key]) continue;
      html += `<optgroup label="${escHtml(label)}">`;
      grouped[key].forEach((m) => {
        html += `<option value="${escHtml(m.tv_scanner)}" ${m.tv_scanner === eqsState.market ? 'selected' : ''}>${m.flag} ${escHtml(m.name)}</option>`;
      });
      html += `</optgroup>`;
    }
    select.innerHTML = html;
  }).catch(() => {});
}

// ── Filter builder ──
function addEqsFilter() {
  eqsState.filters.push({ field: 'market_cap_basic', op: 'greater', value: '' });
  _renderEqsFilterRows();
}

function removeEqsFilter(idx) {
  eqsState.filters.splice(idx, 1);
  _renderEqsFilterRows();
}

function _renderEqsFilterRows() {
  const builder = $('#eqs-filter-builder');
  if (!builder || !_eqsFields) return;

  const cats = _eqsFields.categories || [];
  const fields = _eqsFields.fields || {};

  let html = '';
  eqsState.filters.forEach((f, i) => {
    // Build field <select> grouped by category
    let fieldOpts = '';
    cats.forEach((cat) => {
      const items = fields[cat] || [];
      if (!items.length) return;
      fieldOpts += `<optgroup label="${escHtml(cat)}">`;
      items.forEach((item) => {
        fieldOpts += `<option value="${escHtml(item.key)}" ${item.key === f.field ? 'selected' : ''}>${escHtml(item.label)}</option>`;
      });
      fieldOpts += `</optgroup>`;
    });

    html += `
      <div class="eqs-filter-row">
        <select class="eqs-filter-field" data-idx="${i}">${fieldOpts}</select>
        <select class="eqs-filter-op" data-idx="${i}">
          <option value="greater" ${f.op === 'greater' ? 'selected' : ''}>&gt;</option>
          <option value="egreater" ${f.op === 'egreater' ? 'selected' : ''}>≥</option>
          <option value="less" ${f.op === 'less' ? 'selected' : ''}>&lt;</option>
          <option value="eless" ${f.op === 'eless' ? 'selected' : ''}>≤</option>
          <option value="equal" ${f.op === 'equal' ? 'selected' : ''}>=</option>
        </select>
        <input class="eqs-filter-value filter-group__input" type="text" data-idx="${i}"
               placeholder="Value" value="${f.value !== '' && f.value != null ? f.value : ''}"
               style="width:100px">
        <button class="eqs-filter-remove" onclick="removeEqsFilter(${i})" title="Remove">✕</button>
      </div>
    `;
  });
  html += `<button class="country-btn country-btn--ghost" onclick="addEqsFilter()">+ Add Filter</button>`;
  html += `<button class="country-btn country-btn--ghost" style="margin-left:8px" onclick="runEqsScan()">Apply</button>`;
  builder.innerHTML = html;

  // Wire filter change events
  builder.querySelectorAll('.eqs-filter-field').forEach((el) => {
    el.addEventListener('change', () => { eqsState.filters[+el.dataset.idx].field = el.value; });
  });
  builder.querySelectorAll('.eqs-filter-op').forEach((el) => {
    el.addEventListener('change', () => { eqsState.filters[+el.dataset.idx].op = el.value; });
  });
  builder.querySelectorAll('.eqs-filter-value').forEach((el) => {
    el.addEventListener('change', () => {
      const raw = el.value.trim();
      eqsState.filters[+el.dataset.idx].value = parseFilterValue(raw) ?? raw;
    });
  });
}

// ── Scan ──
async function runEqsScan() {
  const container = $('#eqs-table-container');
  if (!container) return;
  container.innerHTML = `
    <div class="evts-loading">
      <div class="search-loading__spinner"></div>
      <span>Scanning…</span>
    </div>
  `;

  // Get columns from the active preset
  const preset = (_eqsFields?.presets || {})[eqsState.preset];
  const columns = preset ? preset.columns : ['close', 'change', 'volume', 'market_cap_basic'];

  // Build server-side filters (only valid ones)
  const apiFilters = eqsState.filters
    .filter((f) => f.field && f.value !== '' && f.value != null)
    .map((f) => ({ field: f.field, op: f.op, value: f.value }));

  try {
    const resp = await fetch('/api/eqs/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        market:  eqsState.market,
        columns: columns,
        filters: apiFilters,
        sort:    eqsState.sort,
        limit:   eqsState.limit,
      }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const payload = await resp.json();
    if (payload.error) throw new Error(payload.error);
    _eqsData = payload;
    renderEqsTable();
    const sub = $('#eqs-subtitle');
    if (sub) sub.textContent = `${payload.total} results`;
  } catch (err) {
    console.error('EQS scan failed:', err);
    container.innerHTML = `
      <div class="evts-empty">
        <div class="evts-empty__icon">⚠</div>
        <div>Scan failed.</div>
        <div class="text-muted" style="font-size:11px;margin-top:8px;">${escHtml(err.message)}</div>
      </div>
    `;
  }
}

function renderEqsTable() {
  const container = $('#eqs-table-container');
  if (!container || !_eqsData) return;

  const rows = _eqsData.rows || [];
  const columns = (_eqsData.columns || []).slice(2); // skip name, description (shown as Ticker + Company)

  if (rows.length === 0) {
    container.innerHTML = `<div class="evts-empty"><div class="evts-empty__icon">📊</div><div>No stocks match the criteria.</div></div>`;
    return;
  }

  // Build header
  let html = `<div class="eqs-table"><div class="eqs-table__header">
    <div class="eqs-table__th" data-sort="name">Ticker</div>
    <div class="eqs-table__th">Company</div>`;
  columns.forEach((col) => {
    const fieldInfo = _FIELD_MAP_JS[col] || { label: col };
    const isNum = !['text'].includes(fieldInfo.type || 'number');
    html += `<div class="eqs-table__th ${isNum ? 'eqs-table__num' : ''}" data-sort="${escHtml(col)}">${escHtml(fieldInfo.label)}</div>`;
  });
  html += `</div>`;

  // Build rows
  rows.forEach((row) => {
    html += `<div class="eqs-table__row" onclick="searchAndLoad('${escHtml(row.ticker)}')">
      <div class="eqs-table__ticker">${escHtml(row.ticker)}</div>
      <div class="eqs-table__name">${escHtml(row.name || '')}</div>`;
    columns.forEach((col) => {
      const val = row[col];
      const fieldInfo = _FIELD_MAP_JS[col] || {};
      html += `<div class="eqs-table__num">${_fmtEqsValue(val, fieldInfo.type)}</div>`;
    });
    html += `</div>`;
  });
  html += `</div>`;

  container.innerHTML = html;

  // Sortable headers
  container.querySelectorAll('.eqs-table__th[data-sort]').forEach((th) => {
    th.style.cursor = 'pointer';
    th.addEventListener('click', () => {
      const field = th.dataset.sort;
      if (eqsState.sort.field === field) {
        eqsState.sort.order = eqsState.sort.order === 'desc' ? 'asc' : 'desc';
      } else {
        eqsState.sort = { field, order: 'desc' };
      }
      runEqsScan();
    });
  });
}

// Client-side field label lookup (mirrors backend catalog)
const _FIELD_MAP_JS = {};
(function _initFieldMap() {
  // Will be populated from the API on first load
})();
async function _ensureFieldMap() {
  if (Object.keys(_FIELD_MAP_JS).length > 0) return;
  await _loadEqsFields();
  if (!_eqsFields) return;
  for (const cat of Object.values(_eqsFields.fields || {})) {
    for (const f of cat) {
      _FIELD_MAP_JS[f.key] = f;
    }
  }
}

function _fmtEqsValue(val, type) {
  if (val == null || val === '') return '—';
  if (type === 'percent') return (typeof val === 'number' ? val.toFixed(2) + '%' : String(val));
  if (type === 'price') return (typeof val === 'number' ? val.toFixed(2) : String(val));
  if (type === 'number') {
    if (typeof val === 'number') {
      const abs = Math.abs(val);
      if (abs >= 1e12) return (val / 1e12).toFixed(2) + 'T';
      if (abs >= 1e9) return (val / 1e9).toFixed(2) + 'B';
      if (abs >= 1e6) return (val / 1e6).toFixed(1) + 'M';
      if (abs >= 1e3) return (val / 1e3).toFixed(1) + 'K';
      return val.toFixed(2);
    }
    return String(val);
  }
  if (type === 'date' && typeof val === 'number') {
    return new Date(val * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  return String(val);
}


function fmtBigNum(n) {
  const abs = Math.abs(n);
  if (abs >= 1e12) return (n / 1e12).toFixed(2) + 'T';
  if (abs >= 1e9)  return (n / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6)  return (n / 1e6).toFixed(1) + 'M';
  if (abs >= 1e3)  return (n / 1e3).toFixed(1) + 'K';
  return String(n);
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

async function renderNewsListForWl(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;

  container.innerHTML = `
    <div class="news__loading" style="padding: 20px;">
      <div class="loading-spinner"></div>
      <div class="loading-text">Loading news...</div>
    </div>
  `;

  // Fetch or reuse news
  if (!state.newsData || state.currentTicker !== state._lastNewsTicker) {
    state.newsData = await fetchNews(state.currentTicker, state.currentExchange);
    state._lastNewsTicker = state.currentTicker;
  }

  if (!state.newsData || state.newsData.error || state.newsData.length === 0) {
    container.innerHTML = `
      <div class="news__empty" style="padding: 20px;">
        <p>${state.newsData?.error || 'No news available for this ticker.'}</p>
      </div>
    `;
    return;
  }

  const articles = state.newsData;

  container.innerHTML = `
    <div class="news-feed" style="margin-top: 0;">
      ${articles.map((a) => `
        <div class="news-feed__item" onclick="openArticle(${JSON.stringify(a.link).replace(/"/g, '&quot;')}, ${JSON.stringify(a.title).replace(/"/g, '&quot;')}, ${JSON.stringify(a.publisher).replace(/"/g, '&quot;')}, ${a.publishedAt})">
          <span class="news-feed__time">${timeAgo(a.publishedAt)}</span>
          <div class="news-feed__content">
            <div class="news-feed__title" style="white-space: normal; line-height: 1.3;">${escHtml(a.title)}</div>
            <div class="news-feed__publisher">${escHtml(a.publisher)}</div>
          </div>
        </div>
      `).join('')}
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

// ═══════════════════════════════════════
// FA — FINANCIAL ANALYSIS
// Bloomberg-style Highlights / IS / BS / CF / Ratios with
// period (annual/quarterly) and display-currency toggles.
// ═══════════════════════════════════════

const FA_TABS = [
  { key: 'highlights', label: 'Highlights' },
  { key: 'income',     label: 'Income Statement' },
  { key: 'balance',    label: 'Balance Sheet' },
  { key: 'cashflow',   label: 'Cash Flow' },
  { key: 'ratios',     label: 'Ratios' },
];

const faState = {
  period: 'annual',        // 'annual' | 'quarterly'
  ccy: null,               // null = native currency, or 'USD' etc.
  activeTab: 'highlights',
  data: null,              // latest API response
  loading: false,
  error: null,
  currencies: null,        // cached list from /api/fa/currencies
};

function renderFinancials(container) {
  // Reset data cache when ticker changes; keep active tab (may have been
  // pre-set by IS / BS / CF sub-tab shortcuts in openFunction()).
  if (faState._lastSymbol !== state.currentSymbol) {
    faState.activeTab = faState.activeTab || 'highlights';
    faState.data = null;
    faState.error = null;
    faState._lastSymbol = state.currentSymbol;
  }
  if (!faState.activeTab) faState.activeTab = 'highlights';

  container.className = 'dashboard dashboard--function';
  container.innerHTML = `
    <div class="function-wrapper" id="fa-wrapper">
      <header class="function-header">
        <div class="function-header__title-row">
          <div class="function-header__code">FA</div>
          <div class="function-header__name">
            <div class="function-header__name-main">Financial Analysis</div>
            <div class="function-header__name-sub" id="fa-subtitle">
              Income statement, balance sheet, cash flow &amp; ratios — ${escHtml(state.currentTicker || '')}
            </div>
          </div>
        </div>
      </header>

      <div class="function-toolbar">
        <div class="function-toolbar__label">Period</div>
        <div class="range-filter" id="fa-period-filter">
          <button class="country-btn ${faState.period === 'annual' ? 'country-btn--active' : ''}"
                  data-period="annual">Annual</button>
          <button class="country-btn ${faState.period === 'quarterly' ? 'country-btn--active' : ''}"
                  data-period="quarterly">Quarterly</button>
        </div>

        <div class="function-toolbar__label" style="margin-left:14px">Currency</div>
        <select class="evts-country-select" id="fa-ccy-select" style="min-width:110px">
          <option value="">Native</option>
        </select>

        <div class="fa-toolbar__info" id="fa-toolbar-info" style="margin-left:auto; font-size:11px; color:var(--text-tertiary); font-family:var(--font-mono)"></div>
      </div>

      <nav class="fa-tabs" id="fa-tabs">
        ${FA_TABS.map((t) => `
          <button class="fa-tab ${t.key === faState.activeTab ? 'fa-tab--active' : ''}"
                  data-fa-tab="${t.key}">${t.label}</button>
        `).join('')}
      </nav>

      <div class="panel function-panel fa-panel">
        <div class="panel__body" id="fa-body">
          <div class="evts-loading">
            <div class="search-loading__spinner"></div>
            <span>Loading financial data…</span>
          </div>
        </div>
      </div>
    </div>
  `;

  // Wire period toggle
  const periodFilter = document.getElementById('fa-period-filter');
  if (periodFilter) {
    periodFilter.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-period]');
      if (!btn) return;
      const p = btn.getAttribute('data-period');
      if (p && p !== faState.period) {
        faState.period = p;
        periodFilter.querySelectorAll('button').forEach((b) => {
          b.classList.toggle('country-btn--active', b === btn);
        });
        faLoadData();
      }
    });
  }

  // Wire currency selector
  const ccySelect = document.getElementById('fa-ccy-select');
  if (ccySelect) {
    ccySelect.addEventListener('change', (e) => {
      const v = e.target.value;
      faState.ccy = v || null;
      faLoadData();
    });
  }

  // Wire tab switching — rerenders only the body
  const tabsEl = document.getElementById('fa-tabs');
  if (tabsEl) {
    tabsEl.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-fa-tab]');
      if (!btn) return;
      const tabKey = btn.getAttribute('data-fa-tab');
      if (tabKey === faState.activeTab) return;
      faState.activeTab = tabKey;
      tabsEl.querySelectorAll('.fa-tab').forEach((b) => {
        b.classList.toggle('fa-tab--active', b === btn);
      });
      faRenderBody();
    });
  }

  // Populate currency dropdown then load data
  faLoadCurrencies().then(() => faLoadData());
}

async function faLoadCurrencies() {
  if (faState.currencies) {
    faPopulateCurrencySelect();
    return;
  }
  try {
    const resp = await fetch('/api/fa/currencies');
    const data = await resp.json();
    faState.currencies = data.currencies || ['USD', 'EUR', 'GBP', 'JPY', 'CHF'];
  } catch (e) {
    faState.currencies = ['USD', 'EUR', 'GBP', 'JPY', 'CHF'];
  }
  faPopulateCurrencySelect();
}

function faPopulateCurrencySelect() {
  const sel = document.getElementById('fa-ccy-select');
  if (!sel) return;
  const current = faState.ccy || '';
  sel.innerHTML = '<option value="">Native</option>' +
    faState.currencies.map((c) => `<option value="${c}" ${c === current ? 'selected' : ''}>${c}</option>`).join('');
}

async function faLoadData() {
  const body = document.getElementById('fa-body');
  if (body) {
    body.innerHTML = `
      <div class="evts-loading">
        <div class="search-loading__spinner"></div>
        <span>Loading ${faState.period} data…</span>
      </div>
    `;
  }

  faState.loading = true;
  faState.error = null;

  const exchange = state.currentExchange || '';
  const ticker = state.currentTicker || '';
  if (!ticker) {
    faState.loading = false;
    if (body) body.innerHTML = '<div class="evts-empty"><div class="evts-empty__icon">◆</div><div>Load a ticker to see financial data</div></div>';
    return;
  }

  const params = new URLSearchParams({
    exchange,
    period: faState.period,
  });
  if (faState.ccy) params.set('ccy', faState.ccy);

  try {
    const resp = await fetch(`/api/fa/statements/${encodeURIComponent(ticker)}?${params}`);
    const data = await resp.json();
    if (data.error) {
      throw new Error(data.error);
    }
    faState.data = data;
  } catch (e) {
    faState.error = String(e.message || e);
  } finally {
    faState.loading = false;
  }

  // Update toolbar info with currency + period count
  const infoEl = document.getElementById('fa-toolbar-info');
  if (infoEl && faState.data) {
    const d = faState.data;
    const ccy = d.displayCurrency || d.currency || '';
    const periodsCount = (d.periods || []).length;
    const converted = d.fxRate ? ` · fx ${d.fxRate.toFixed(4)}` : '';
    infoEl.textContent = `${periodsCount} ${faState.period === 'annual' ? 'years' : 'quarters'} · ${ccy}${converted}`;
  }

  faRenderBody();
}

function faRenderBody() {
  const body = document.getElementById('fa-body');
  if (!body) return;

  if (faState.error) {
    body.innerHTML = `
      <div class="evts-empty">
        <div class="evts-empty__icon">⚠</div>
        <div>Could not load financial data</div>
        <div class="text-muted" style="font-size:11px; margin-top:4px">${escHtml(faState.error)}</div>
      </div>
    `;
    return;
  }
  if (!faState.data) return;

  const tab = faState.activeTab;
  switch (tab) {
    case 'highlights': body.innerHTML = faRenderHighlights(faState.data); break;
    case 'income':     body.innerHTML = faRenderStatement(faState.data, 'income',   'Income Statement'); break;
    case 'balance':    body.innerHTML = faRenderStatement(faState.data, 'balance',  'Balance Sheet'); break;
    case 'cashflow':   body.innerHTML = faRenderStatement(faState.data, 'cashflow', 'Cash Flow'); break;
    case 'ratios':     body.innerHTML = faRenderRatios(faState.data); break;
  }
}

// ── Table rendering helpers ──────────────────────────────────────

function faFmtNum(v, opts = {}) {
  if (v == null || v === undefined || Number.isNaN(v)) return '<span class="fa-cell--empty">—</span>';
  const { decimals = null, compact = true, percent = false, suffix = '' } = opts;
  if (percent) {
    return `${(v * 100).toFixed(decimals != null ? decimals : 2)}%`;
  }
  const abs = Math.abs(v);
  if (compact) {
    if (abs >= 1e12) return `${(v / 1e12).toFixed(2)}T${suffix}`;
    if (abs >= 1e9)  return `${(v / 1e9).toFixed(2)}B${suffix}`;
    if (abs >= 1e6)  return `${(v / 1e6).toFixed(2)}M${suffix}`;
    if (abs >= 1e3)  return `${(v / 1e3).toFixed(2)}K${suffix}`;
  }
  return `${v.toFixed(decimals != null ? decimals : 2)}${suffix}`;
}

function faFmtPeriod(dateStr, period) {
  if (!dateStr) return '';
  // dateStr is 'YYYY-MM-DD'
  const parts = dateStr.split('-');
  if (parts.length !== 3) return dateStr;
  const y = parts[0], m = parts[1];
  if (period === 'quarterly') {
    const month = parseInt(m, 10);
    const q = Math.ceil(month / 3);
    return `Q${q} ${y}`;
  }
  // Annual — show FY + short year
  return `FY ${y}`;
}

function faRenderStatement(data, sectionKey, title) {
  const rows = data[sectionKey] || [];
  const periods = data.periods || [];
  const ccy = data.displayCurrency || data.currency || '';

  if (rows.length === 0 || periods.length === 0) {
    return `
      <div class="evts-empty">
        <div class="evts-empty__icon">◆</div>
        <div>No ${title.toLowerCase()} data available</div>
        <div class="text-muted" style="font-size:11px; margin-top:4px">yfinance did not return figures for ${escHtml(data.symbol)} (${faState.period}).</div>
      </div>
    `;
  }

  // Header row: "Item" + one column per period
  const headerCells = periods.map((p) => `<th class="fa-th fa-th--num">${faFmtPeriod(p, data.period)}</th>`).join('');

  // Data rows
  const bodyRows = rows.map((row) => {
    const isEpsRow = /EPS$/i.test(row.key) || /Shares/i.test(row.key);
    const cells = row.values.map((v) => {
      if (v == null) return `<td class="fa-td fa-td--num fa-cell--empty">—</td>`;
      const fmt = isEpsRow
        ? faFmtNum(v, { compact: false, decimals: 2 })
        : faFmtNum(v, { compact: true });
      const cls = v < 0 ? 'fa-td fa-td--num fa-neg' : 'fa-td fa-td--num';
      return `<td class="${cls}">${fmt}</td>`;
    }).join('');
    return `
      <tr class="fa-row">
        <td class="fa-td fa-td--label">${escHtml(row.label)}</td>
        ${cells}
      </tr>
    `;
  }).join('');

  return `
    <div class="fa-table-wrap">
      <table class="fa-table">
        <thead>
          <tr>
            <th class="fa-th fa-th--label">Item</th>
            ${headerCells}
          </tr>
          <tr class="fa-subheader">
            <th class="fa-th fa-th--label fa-th--muted">${escHtml(title)}</th>
            ${periods.map(() => `<th class="fa-th fa-th--muted fa-th--num">${escHtml(ccy)}</th>`).join('')}
          </tr>
        </thead>
        <tbody>${bodyRows}</tbody>
      </table>
    </div>
  `;
}

function faRenderHighlights(data) {
  const hl = data.highlights || {};
  const ccy = data.displayCurrency || data.currency || '';

  const card = (title, items) => `
    <div class="fa-hl-card">
      <div class="fa-hl-card__title">${title}</div>
      <div class="fa-hl-card__items">
        ${items.map(([label, value, muted]) => `
          <div class="fa-hl-item">
            <span class="fa-hl-item__label">${label}</span>
            <span class="fa-hl-item__value ${muted ? 'fa-hl-item__value--muted' : ''}">${value}</span>
          </div>
        `).join('')}
      </div>
    </div>
  `;

  const n = (v, opts) => v == null ? '—' : faFmtNum(v, opts);
  const nMon = (v) => v == null ? '—' : `${faFmtNum(v, { compact: true })} ${ccy}`;
  const nPct = (v) => v == null ? '—' : faFmtNum(v, { percent: true });
  const nRat = (v) => v == null ? '—' : faFmtNum(v, { compact: false, decimals: 2, suffix: 'x' });

  return `
    <div class="fa-highlights">
      ${card('VALUATION', [
        ['Market Cap',         nMon(hl.marketCap)],
        ['Enterprise Value',   nMon(hl.enterpriseValue)],
        ['Trailing P/E',       nRat(hl.trailingPE)],
        ['Forward P/E',        nRat(hl.forwardPE)],
        ['PEG Ratio',          nRat(hl.pegRatio)],
        ['Price / Book',       nRat(hl.priceToBook)],
        ['Price / Sales',      nRat(hl.priceToSales)],
        ['EV / Revenue',       nRat(hl.evToRevenue)],
        ['EV / EBITDA',        nRat(hl.evToEbitda)],
      ])}
      ${card('PROFITABILITY', [
        ['Gross Margin',       nPct(hl.grossMargins)],
        ['Operating Margin',   nPct(hl.operatingMargins)],
        ['Profit Margin',      nPct(hl.profitMargins)],
        ['Return on Equity',   nPct(hl.returnOnEquity)],
        ['Return on Assets',   nPct(hl.returnOnAssets)],
      ])}
      ${card('GROWTH (YoY)', [
        ['Revenue Growth',     nPct(hl.revenueGrowth)],
        ['Earnings Growth',    nPct(hl.earningsGrowth)],
        ['Quarterly Earn. Growth', nPct(hl.earningsQuarterlyGrowth)],
      ])}
      ${card('FINANCIAL HEALTH', [
        ['Total Cash',         nMon(hl.totalCash)],
        ['Total Debt',         nMon(hl.totalDebt)],
        ['Debt / Equity',      n(hl.debtToEquity, { compact: false, decimals: 2 })],
        ['Current Ratio',      nRat(hl.currentRatio)],
        ['Quick Ratio',        nRat(hl.quickRatio)],
      ])}
      ${card('PER-SHARE (TTM)', [
        ['Revenue',            nMon(hl.revenue)],
        ['Net Income',         nMon(hl.netIncome)],
        ['EBITDA',             nMon(hl.ebitda)],
        ['Operating Cash Flow', nMon(hl.operatingCashFlow)],
        ['Free Cash Flow',     nMon(hl.freeCashFlow)],
        ['Trailing EPS',       nMon(hl.trailingEps)],
        ['Forward EPS',        nMon(hl.forwardEps)],
        ['Book Value',         nMon(hl.bookValue)],
      ])}
      ${card('SHAREHOLDER', [
        ['Dividend Yield',     nPct(hl.dividendYield)],
        ['Payout Ratio',       nPct(hl.payoutRatio)],
        ['Shares Outstanding', n(hl.sharesOutstanding, { compact: true })],
        ['Float',              n(hl.floatShares, { compact: true })],
        ['Beta',               n(hl.beta, { compact: false, decimals: 2 })],
      ])}
    </div>
  `;
}

function faRenderRatios(data) {
  const rows = data.income || [];
  const periods = data.periods || [];
  if (rows.length === 0 || periods.length === 0) {
    return `
      <div class="evts-empty">
        <div class="evts-empty__icon">◆</div>
        <div>Not enough data to compute ratios</div>
      </div>
    `;
  }

  // Pull helper
  const getRow = (section, key) => (data[section] || []).find((r) => r.key === key);
  const revenueRow       = getRow('income', 'TotalRevenue');
  const grossProfitRow   = getRow('income', 'GrossProfit');
  const opIncomeRow      = getRow('income', 'OperatingIncome');
  const netIncomeRow     = getRow('income', 'NetIncome');
  const ebitdaRow        = getRow('income', 'EBITDA');
  const totalAssetsRow   = getRow('balance', 'TotalAssets');
  const totalEquityRow   = getRow('balance', 'StockholdersEquity');
  const totalDebtRow     = getRow('balance', 'TotalDebt');
  const currentAssetsRow = getRow('balance', 'CurrentAssets');
  const currentLiabRow   = getRow('balance', 'CurrentLiabilities');
  const opCashFlowRow    = getRow('cashflow', 'OperatingCashFlow');
  const fcfRow           = getRow('cashflow', 'FreeCashFlow');

  const series = (nameRow, denRow, label, opts = { percent: true }) => {
    if (!nameRow || !denRow) return null;
    const values = nameRow.values.map((n, i) => {
      const d = denRow.values[i];
      if (n == null || d == null || d === 0) return null;
      return n / d;
    });
    return { label, values, opts };
  };

  const ratioRows = [
    series(grossProfitRow,   revenueRow,     'Gross Margin'),
    series(opIncomeRow,      revenueRow,     'Operating Margin'),
    series(netIncomeRow,     revenueRow,     'Net Profit Margin'),
    series(ebitdaRow,        revenueRow,     'EBITDA Margin'),
    series(netIncomeRow,     totalEquityRow, 'ROE'),
    series(netIncomeRow,     totalAssetsRow, 'ROA'),
    series(totalDebtRow,     totalEquityRow, 'Debt / Equity', { compact: false, decimals: 2 }),
    series(totalDebtRow,     totalAssetsRow, 'Debt / Assets'),
    series(currentAssetsRow, currentLiabRow, 'Current Ratio', { compact: false, decimals: 2, suffix: 'x' }),
    series(opCashFlowRow,    revenueRow,     'Op. Cash / Revenue'),
    series(fcfRow,           revenueRow,     'FCF Margin'),
  ].filter(Boolean);

  if (ratioRows.length === 0) {
    return `
      <div class="evts-empty">
        <div class="evts-empty__icon">◆</div>
        <div>Not enough data to compute ratios</div>
      </div>
    `;
  }

  const headerCells = periods.map((p) => `<th class="fa-th fa-th--num">${faFmtPeriod(p, data.period)}</th>`).join('');

  const bodyRows = ratioRows.map((r) => {
    const cells = r.values.map((v) => {
      if (v == null) return `<td class="fa-td fa-td--num fa-cell--empty">—</td>`;
      const isPct = r.opts.percent !== false && !r.opts.suffix;
      const fmt = isPct
        ? faFmtNum(v, { percent: true, decimals: 2 })
        : faFmtNum(v, r.opts);
      const cls = v < 0 ? 'fa-td fa-td--num fa-neg' : 'fa-td fa-td--num';
      return `<td class="${cls}">${fmt}</td>`;
    }).join('');
    return `
      <tr class="fa-row">
        <td class="fa-td fa-td--label">${escHtml(r.label)}</td>
        ${cells}
      </tr>
    `;
  }).join('');

  return `
    <div class="fa-table-wrap">
      <table class="fa-table">
        <thead>
          <tr>
            <th class="fa-th fa-th--label">Ratio</th>
            ${headerCells}
          </tr>
        </thead>
        <tbody>${bodyRows}</tbody>
      </table>
    </div>
  `;
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
  container.className = 'dashboard dashboard--watchlist';

  const ws = state.worksheets.find(w => w.id === state.activeWorksheetId);
  let tickers = ws ? [...ws.tickers] : [];

  // Sorting
  if (state.wlSortCol) {
    tickers.sort((a, b) => {
      let valA, valB;
      const qA = state.wlQuoteData[a.symbol] || {};
      const qB = state.wlQuoteData[b.symbol] || {};
      
      switch (state.wlSortCol) {
        case 'ticker': valA = a.symbol; valB = b.symbol; break;
        case 'name': valA = a.name; valB = b.name; break;
        case 'last': valA = qA.last || 0; valB = qB.last || 0; break;
        case 'chg': valA = qA.change || 0; valB = qB.change || 0; break;
        case 'chgpct': valA = qA.changePct || 0; valB = qB.changePct || 0; break;
        case 'rvol': valA = qA.relativeVolume || 0; valB = qB.relativeVolume || 0; break;
        default: valA = 0; valB = 0;
      }
      
      if (valA < valB) return -1 * state.wlSortDir;
      if (valA > valB) return 1 * state.wlSortDir;
      return 0;
    });
  }

  // Worksheet tabs — double-click tab name to rename
  const wsTabs = state.worksheets.map(w => {
    const active = w.id === state.activeWorksheetId;
    return `
      <div class="ws-tab ${active ? 'ws-tab--active' : ''}" onclick="switchWorksheet(${w.id})">
        <span class="ws-tab__name" ondblclick="event.stopPropagation(); wlStartRenameSheet(${w.id})"
              title="Double-click to rename">${escHtml(w.name)}</span>
        ${state.worksheets.length > 1 ? `<span class="ws-tab__close" onclick="event.stopPropagation(); deleteWorksheet(${w.id})" title="Delete worksheet">&times;</span>` : ''}
      </div>
    `;
  }).join('');

  // Persistent Add-ticker row HTML
  const addRowHtml = `
    <tr id="wl-add-row" class="wl-row wl-row--add">
      <td colspan="9" class="wl-add-cell">
        <div class="wl-add-wrapper">
          <input type="text" id="wl-add-input" class="wl-add-input" placeholder="+ Add Ticker..."
                 oninput="wlAddTickerSearch(this.value)"
                 onfocus="this.placeholder='Type ticker or company name...'"
                 onblur="setTimeout(() => { if ($('#wl-add-dropdown')) $('#wl-add-dropdown').style.display = 'none'; }, 200);"
                 onkeydown="if(event.key==='Escape'){this.value=''; this.blur();} else if(event.key==='Enter'){const d=document.getElementById('wl-add-dropdown'); if(d&&d.firstElementChild) d.firstElementChild.click();}" autocomplete="off" />
          <div class="wl-add-dropdown" id="wl-add-dropdown" style="display:none"></div>
        </div>
      </td>
    </tr>
  `;

  // Helper for News Heat bars — delegates to the global function
  // so both initial render and in-place updates use the same visual
  const renderHeatBars = wlRenderHeatBars;

  const getSortIcon = (col) => {
    if (state.wlSortCol !== col) return '';
    return state.wlSortDir === 1 ? ' \u2191' : ' \u2193';
  };

  // Table rows
  const rows = tickers.map((t, idx) => {
    const q = state.wlQuoteData[t.symbol] || {};
    const isActive = t.symbol === state.currentTicker;
    
    // Inline editing mode
    if (state.wlEditingSymbol === t.symbol) {
       return `
        <tr class="wl-row wl-row--edit">
            <td colspan="9" class="wl-add-cell">
                <div class="wl-add-wrapper">
                  <input type="text" id="wl-edit-input" class="wl-add-input" value="${escHtml(t.symbol)}" placeholder="Type to replace ticker..."
                         oninput="wlEditTickerSearch(this.value)"
                         onkeydown="if(event.key==='Escape'){state.wlEditingSymbol=null; wlUpdateTableData();} else if(event.key==='Enter'){const d=document.getElementById('wl-edit-dropdown'); if(d&&d.firstElementChild) d.firstElementChild.click();}" autocomplete="off" />
                  <div class="wl-add-dropdown" id="wl-edit-dropdown" style="display:none"></div>
                </div>
            </td>
        </tr>
       `;
    }

    const last = q.last != null ? q.last.toFixed(2) : '\u2014';
    let chgHtml = '\u2014';
    let chgPctHtml = '\u2014';
    if (q.change != null) {
      const sign = q.change >= 0 ? '+' : '';
      const cls = q.change >= 0 ? 'wl-pos' : 'wl-neg';
      chgHtml = `<span class="${cls}">${sign}${q.change.toFixed(2)}</span>`;
      chgPctHtml = `<span class="${cls}">${sign}${q.changePct.toFixed(2)}%</span>`;
    }

    let rvolHtml = '\u2014';
    if (q.relativeVolume != null) {
      const rvClass = q.relativeVolume >= 1.5 ? 'wl-rv-high' : q.relativeVolume >= 0.8 ? 'wl-rv-normal' : 'wl-rv-low';
      rvolHtml = `<span class="${rvClass}">${q.relativeVolume.toFixed(1)}x</span>`;
    }

    let earningsHtml = '';
    if (q.earningsPublished) {
      earningsHtml = '<span class="wl-earnings wl-earnings--published" title="Earnings recently published">E</span>';
    } else if (q.earningsUpcoming) {
      earningsHtml = '<span class="wl-earnings wl-earnings--upcoming" title="Earnings upcoming">E</span>';
    }

    // click event for news heat switches split screen to CN for this ticker
    const heatHtml = `<div onclick="event.stopPropagation(); toggleWlSplitMode('${escHtml(t.symbol)}', 'news');" class="heat-wrapper" title="News Heat">${renderHeatBars(q.newsHeat || '')}</div>`;

    return `
      <tr class="wl-row ${isActive ? 'wl-row--active' : ''}" data-wl-symbol="${escHtml(t.symbol)}"
          onclick="toggleWlSplitMode('${escHtml(t.symbol)}')"
          ondblclick="startWlInlineEdit('${escHtml(t.symbol)}')">
        <td class="wl-cell wl-ticker">${escHtml(t.symbol)}</td>
        <td class="wl-cell wl-name">${escHtml(t.name || '')}</td>
        <td class="wl-cell wl-num wl-last">${last}</td>
        <td class="wl-cell wl-num wl-chg">${chgHtml}</td>
        <td class="wl-cell wl-num wl-chg-pct">${chgPctHtml}</td>
        <td class="wl-cell wl-num wl-rvol">${rvolHtml}</td>
        <td class="wl-cell wl-indicator wl-earnings">${earningsHtml}</td>
        <td class="wl-cell wl-indicator wl-heat">${heatHtml}</td>
        <td class="wl-cell wl-actions">
          <button class="wl-remove-btn" onclick="event.stopPropagation(); removeFromWatchlist('${escHtml(t.symbol)}')" title="Remove">&times;</button>
        </td>
      </tr>
    `;
  }).join('');

  // View Modes and Right-hand Panel
  const isNewsMode = state.wlSplitMode === 'news';
  const splitTitle = isNewsMode ? `News \u2014 ${state.currentTicker || 'Select a ticker'}` : `Chart \u2014 ${state.currentTicker || 'Select a ticker'}`;
  
  const isMax = state.wlViewMode === 'max';
  const is1Split = state.wlViewMode === '1-split';
  const is2Split = state.wlViewMode === '2-split';

  let splitPanel = '';
  if (is1Split) {
    splitPanel = `
      <div class="panel wl-chart-panel">
        <div class="panel__header" style="display:flex; justify-content:space-between; align-items:center;">
          <div class="panel__title"><span class="panel__title-dot"></span> ${splitTitle}</div>
          <div class="panel__actions" style="display:flex; gap:10px;">
             <span class="wl-split-toggle ${!isNewsMode ? 'wl-split-toggle--active' : ''}" onclick="toggleWlSplitMode(null, 'chart')">Chart</span>
             <span class="wl-split-toggle ${isNewsMode ? 'wl-split-toggle--active' : ''}" onclick="toggleWlSplitMode(null, 'news')">News</span>
          </div>
        </div>
        <div class="panel__body" id="wl-split-container" style="overflow-y:auto; padding:0"></div>
      </div>
    `;
  } else if (is2Split) {
    splitPanel = `
      <div class="wl-chart-panel" style="display:flex; flex-direction:column; gap:var(--gap); background:transparent; border:none;">
        <div class="panel" style="flex:1; min-height:0; display:flex; flex-direction:column;">
          <div class="panel__header">
            <div class="panel__title"><span class="panel__title-dot"></span> Chart \u2014 ${state.currentTicker || 'Select a ticker'}</div>
          </div>
          <div class="panel__body" id="wl-split-chart-container" style="overflow:hidden; padding:0;"></div>
        </div>
        <div class="panel" style="flex:1; min-height:0; display:flex; flex-direction:column;">
          <div class="panel__header">
            <div class="panel__title"><span class="panel__title-dot"></span> News \u2014 ${state.currentTicker || 'Select a ticker'}</div>
          </div>
          <div class="panel__body" id="wl-split-news-container" style="overflow-y:auto; padding:0;"></div>
        </div>
      </div>
    `;
  }

  container.innerHTML = `
    <div class="wl-wrapper ${isMax ? 'wl-wrapper--maximized' : ''}">
      <div class="wl-toolbar">
        <div class="ws-tabs">
          ${wsTabs}
          <button class="ws-tab ws-tab--add" onclick="addWorksheet()" title="Add worksheet">+</button>
        </div>
        <div class="wl-toolbar__actions" style="display:flex; align-items:center; gap:8px;">
          <div style="display:flex; background:var(--bg-tertiary); border-radius:var(--radius); border:1px solid var(--border-primary); overflow:hidden;">
            <button class="wl-split-toggle ${isMax ? 'wl-split-toggle--active' : ''}" onclick="setWlViewMode('max')" style="border-radius:0; border-right:1px solid var(--border-primary); padding:4px 8px;" title="Maximized Table">Max.</button>
            <button class="wl-split-toggle ${is1Split ? 'wl-split-toggle--active' : ''}" onclick="setWlViewMode('1-split')" style="border-radius:0; border-right:1px solid var(--border-primary); padding:4px 8px;" title="Table + Chart/News">1-Split</button>
            <button class="wl-split-toggle ${is2Split ? 'wl-split-toggle--active' : ''}" onclick="setWlViewMode('2-split')" style="border-radius:0; padding:4px 8px;" title="Table + Chart + News">2-Split</button>
          </div>
          <button class="wl-export-btn" onclick="wlExportCSV()" title="Export to CSV">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
          </button>
        </div>
      </div>

      <div class="wl-content">
        <div class="wl-table-panel ${isMax ? 'wl-table-panel--full' : ''}">
          <div class="wl-table-scroll">
            <table class="wl-table">
              <thead>
                <tr>
                  <th class="wl-th" style="cursor:pointer" onclick="wlSortBy('ticker')">Ticker${getSortIcon('ticker')}</th>
                  <th class="wl-th wl-th--name" style="cursor:pointer" onclick="wlSortBy('name')">Name${getSortIcon('name')}</th>
                  <th class="wl-th wl-th--num" style="cursor:pointer" onclick="wlSortBy('last')">Last${getSortIcon('last')}</th>
                  <th class="wl-th wl-th--num" style="cursor:pointer" onclick="wlSortBy('chg')">Chg${getSortIcon('chg')}</th>
                  <th class="wl-th wl-th--num" style="cursor:pointer" onclick="wlSortBy('chgpct')">Chg%${getSortIcon('chgpct')}</th>
                  <th class="wl-th wl-th--num" style="cursor:pointer" onclick="wlSortBy('rvol')">rVol${getSortIcon('rvol')}</th>
                  <th class="wl-th wl-th--indicator" title="Earnings">E</th>
                  <th class="wl-th wl-th--indicator" title="News Heat">News</th>
                  <th class="wl-th wl-th--actions"></th>
                </tr>
              </thead>
              <tbody>
                ${rows}
                ${addRowHtml}
              </tbody>
            </table>
          </div>
        </div>
        ${splitPanel}
      </div>
    </div>
  `;

  // Inject content into right panel if not maximized
  if (!isMax && state.symbolLoaded) {
    if (is1Split) {
      if (isNewsMode) {
          // Render simple news list, passing the container
          renderNewsListForWl('wl-split-container');
      } else {
          injectChart('wl-split-container', state.currentSymbol, state.currentExchange);
      }
    } else if (is2Split) {
      injectChart('wl-split-chart-container', state.currentSymbol, state.currentExchange);
      renderNewsListForWl('wl-split-news-container');
    }
  }

  // Set focus automatically if we were editing or add mode
  if (state.wlEditingSymbol) {
      setTimeout(() => { const i = $('#wl-edit-input'); if(i) { i.focus(); i.select(); } }, 50);
  }

  // Fetch enriched quotes
  wlFetchQuotes();
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
  widgetDiv.style.height = '66px';

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

// Global heat-bars renderer — used by both the initial table render
// and the in-place update path so the visual stays consistent.
function wlRenderHeatBars(heat) {
  let bars = 0;
  if (heat === 'low') bars = 1;
  if (heat === 'medium') bars = 2;
  if (heat === 'high') bars = 4;
  let html = '<div class="heat-bars">';
  for (let i = 1; i <= 4; i++) {
    html += `<div class="heat-bar ${i <= bars ? 'heat-bar--active' : ''}"></div>`;
  }
  html += '</div>';
  return html;
}

function saveWorksheets() {
  localStorage.setItem('terminal_worksheets', JSON.stringify(state.worksheets));
  localStorage.setItem('terminal_active_ws', String(state.activeWorksheetId));
}

function addToWatchlist(symbol, exchange, name) {
  // If called without args, use current ticker
  if (!symbol) {
    symbol = state.currentTicker;
    exchange = state.currentExchange;
    name = state.companyInfo?.name || symbol;
  }
  const ws = state.worksheets.find(w => w.id === state.activeWorksheetId);
  if (!ws) return;
  if (!ws.tickers.find(t => t.symbol === symbol)) {
    ws.tickers.push({ symbol, exchange, name });
    saveWorksheets();
    if (state.activeTab === 'watchlist') renderWatchlist($('#dashboard'));
  }
}

function removeFromWatchlist(symbol) {
  const ws = state.worksheets.find(w => w.id === state.activeWorksheetId);
  if (!ws) return;
  ws.tickers = ws.tickers.filter(t => t.symbol !== symbol);
  saveWorksheets();
  if (state.activeTab === 'watchlist') renderWatchlist($('#dashboard'));
}

function addWorksheet() {
  const maxId = Math.max(...state.worksheets.map(w => w.id), 0);
  const newId = maxId + 1;
  state.worksheets.push({ id: newId, name: `Sheet ${newId}`, tickers: [] });
  state.activeWorksheetId = newId;
  saveWorksheets();
  if (state.activeTab === 'watchlist') renderWatchlist($('#dashboard'));
}

function switchWorksheet(id) {
  state.activeWorksheetId = id;
  state.wlQuoteData = {};
  saveWorksheets();
  if (state.activeTab === 'watchlist') renderWatchlist($('#dashboard'));
}

function deleteWorksheet(id) {
  if (state.worksheets.length <= 1) {
    showToast('Cannot delete the last worksheet');
    return;
  }
  state.worksheets = state.worksheets.filter(w => w.id !== id);
  if (state.activeWorksheetId === id) {
    state.activeWorksheetId = state.worksheets[0].id;
  }
  saveWorksheets();
  if (state.activeTab === 'watchlist') renderWatchlist($('#dashboard'));
}

function renameWorksheet(id, newName) {
  const ws = state.worksheets.find(w => w.id === id);
  if (ws) {
    ws.name = newName.trim() || ws.name;
    saveWorksheets();
  }
}

// ── Sheet rename UI: replace tab name with an input ──
function wlStartRenameSheet(sheetId) {
  const ws = state.worksheets.find(w => w.id === sheetId);
  if (!ws) return;
  const tabEl = document.querySelector(`.ws-tab--active .ws-tab__name`);
  if (!tabEl) return;

  const origName = ws.name;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'ws-tab__rename-input';
  input.value = origName;
  input.style.cssText = `
    background: var(--bg-primary, #0a0a0f);
    border: 1px solid var(--accent, #ff8c00);
    color: var(--text-primary, #d4d4d4);
    font-family: var(--font-mono, monospace);
    font-size: 11px;
    padding: 2px 6px;
    width: ${Math.max(60, origName.length * 8)}px;
    outline: none;
    border-radius: 2px;
  `;

  tabEl.replaceWith(input);
  input.focus();
  input.select();

  const commit = () => {
    const val = input.value.trim();
    renameWorksheet(sheetId, val || origName);
    if (state.activeTab === 'watchlist') renderWatchlist($('#dashboard'));
  };

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = origName; input.blur(); }
  });
}

// ── CSV export ──
function wlExportCSV() {
  const ws = state.worksheets.find(w => w.id === state.activeWorksheetId);
  if (!ws || !ws.tickers.length) {
    showToast('Nothing to export');
    return;
  }

  const headers = ['Symbol', 'Name', 'Exchange', 'Last', 'Change', 'Change%', 'Volume', 'RelVol', 'MarketCap', 'NewsHeat', 'EarningsDate'];
  const rows = ws.tickers.map((t) => {
    const q = state.wlQuoteData[t.symbol] || {};
    return [
      t.symbol,
      `"${(t.name || '').replace(/"/g, '""')}"`,
      t.exchange || '',
      q.last != null ? q.last.toFixed(2) : '',
      q.change != null ? q.change.toFixed(2) : '',
      q.changePct != null ? q.changePct.toFixed(2) : '',
      q.volume != null ? q.volume : '',
      q.relativeVolume != null ? q.relativeVolume.toFixed(2) : '',
      q.marketCap != null ? q.marketCap : '',
      q.newsHeat || '',
      q.earningsDate || '',
    ].join(',');
  });

  const csv = [headers.join(','), ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${ws.name.replace(/\s+/g, '_')}_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function setWlViewMode(mode) {
  state.wlViewMode = mode;
  if (state.activeTab === 'watchlist') renderWatchlist($('#dashboard'));
}

// ── Worksheet Interactive Helpers ──

function wlSortBy(col) {
  if (state.wlSortCol === col) {
    // Toggle direction or unsort
    if (state.wlSortDir === 1) state.wlSortDir = -1;
    else state.wlSortCol = null;
  } else {
    state.wlSortCol = col;
    state.wlSortDir = 1;
  }
  if (state.activeTab === 'watchlist') renderWatchlist($('#dashboard'));
}

function toggleWlSplitMode(symbol, mode) {
  if (mode) state.wlSplitMode = mode;
  if (symbol) {
    let fullSym = `NASDAQ:${symbol}`;
    let name = symbol;
    let exchange = 'NASDAQ';
    const ws = state.worksheets.find(w => w.id === state.activeWorksheetId);
    if (ws) {
        const t = ws.tickers.find(tk => tk.symbol === symbol);
        if (t) {
            exchange = t.exchange || 'NASDAQ';
            fullSym = `${exchange}:${t.symbol}`;
            name = t.name;
        }
    }

    // Fast path: if we're already on the watchlist tab, avoid a full re-render.
    // Instead, update symbol state in-place and only refresh the split pane content.
    if (state.activeTab === 'watchlist') {
      const parts = fullSym.split(':');
      const tvPrefix = parts.length > 1 ? parts[0] : 'NASDAQ';
      state.currentTicker = parts.length > 1 ? parts[1] : parts[0];
      state.currentSymbol = `${tvPrefix}:${state.currentTicker}`;
      state.currentExchange = exchange;
      state.tvSupported = isTvSupported(state.currentExchange);
      const TV_CHART_EXCHANGES = [
        'NASDAQ', 'NYSE', 'AMEX', 'NYSEARCA', 'OTC',
        'BINANCE', 'COINBASE', 'BITSTAMP', 'FX_IDC', 'FOREXCOM',
      ];
      if (!TV_CHART_EXCHANGES.includes(tvPrefix)) {
        state.tvSupported = false;
      }
      state.symbolLoaded = true;
      state.companyInfo = null;
      state.newsData = null;

      // Update recent symbols
      state.recentSymbols = [
        state.currentSymbol,
        ...state.recentSymbols.filter((s) => s !== state.currentSymbol),
      ].slice(0, 20);
      localStorage.setItem('terminal_recent', JSON.stringify(state.recentSymbols));

      updateSymbolBar(name);
      updateStatusBar();

      // Update active row highlighting without full re-render
      document.querySelectorAll('.wl-row').forEach(row => {
        const sym = row.getAttribute('data-wl-symbol');
        row.classList.toggle('wl-row--active', sym === symbol);
      });

      // Refresh only the split pane content (chart/news)
      wlRefreshSplitPanes();
      return;
    }

    loadSymbol(fullSym, undefined, name);
    return;
  }

  if (state.activeTab === 'watchlist') renderWatchlist($('#dashboard'));
}

// Refresh only the split pane content without rebuilding the full watchlist DOM.
// This prevents layout shift / flicker when switching tickers.
function wlRefreshSplitPanes() {
  destroyLightweightCharts();

  const isMax = state.wlViewMode === 'max';
  const is1Split = state.wlViewMode === '1-split';
  const is2Split = state.wlViewMode === '2-split';
  const isNewsMode = state.wlSplitMode === 'news';

  if (isMax || !state.symbolLoaded) return;

  if (is1Split) {
    // Update the split panel header title
    const panelHeader = document.querySelector('.wl-chart-panel .panel__title');
    if (panelHeader) {
      const label = isNewsMode ? 'News' : 'Chart';
      panelHeader.innerHTML = `<span class="panel__title-dot"></span> ${label} \u2014 ${state.currentTicker || 'Select a ticker'}`;
    }
    const container = document.getElementById('wl-split-container');
    if (container) {
      container.innerHTML = '';
      if (isNewsMode) {
        renderNewsListForWl('wl-split-container');
      } else {
        injectChart('wl-split-container', state.currentSymbol, state.currentExchange);
      }
    }
  } else if (is2Split) {
    // Update panel headers
    const headers = document.querySelectorAll('.wl-chart-panel .panel__title');
    if (headers[0]) headers[0].innerHTML = `<span class="panel__title-dot"></span> Chart \u2014 ${state.currentTicker || 'Select a ticker'}`;
    if (headers[1]) headers[1].innerHTML = `<span class="panel__title-dot"></span> News \u2014 ${state.currentTicker || 'Select a ticker'}`;

    const chartContainer = document.getElementById('wl-split-chart-container');
    const newsContainer = document.getElementById('wl-split-news-container');
    if (chartContainer) {
      chartContainer.innerHTML = '';
      injectChart('wl-split-chart-container', state.currentSymbol, state.currentExchange);
    }
    if (newsContainer) {
      newsContainer.innerHTML = '';
      renderNewsListForWl('wl-split-news-container');
    }
  }
}

// Inline Editing
function startWlInlineEdit(symbol) {
  state.wlEditingSymbol = symbol;
  if (state.activeTab === 'watchlist') renderWatchlist($('#dashboard'));
}

async function wlEditTickerSearch(query) {
  if (!query || query.length < 1) return;
  try {
    const resp = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
    const data = await resp.json();
    const dropdown = document.getElementById('wl-edit-dropdown');
    if (!dropdown) return;
    const results = (Array.isArray(data) ? data : data.results || []).slice(0, 6);
    if (results.length === 0) {
      dropdown.innerHTML = '<div class="wl-add-no-results">No results</div>';
      dropdown.style.display = 'block';
      return;
    }
    dropdown.innerHTML = results.map(r => `
      <div class="wl-add-result" onclick="wlSelectEditTicker('${escHtml(r.symbol)}', '${escHtml(r.exchange || '')}', '${escHtml(r.name || r.symbol)}')">
        <span class="wl-add-result__ticker">${escHtml(r.symbol)}</span>
        <span class="wl-add-result__name">${escHtml(r.name || '')}</span>
      </div>
    `).join('');
    dropdown.style.display = 'block';
  } catch (e) {
    console.error('Watchlist edit search error:', e);
  }
}

function wlSelectEditTicker(newSymbol, newExchange, newName) {
  const ws = state.worksheets.find(w => w.id === state.activeWorksheetId);
  if (ws && state.wlEditingSymbol) {
    const idx = ws.tickers.findIndex(t => t.symbol === state.wlEditingSymbol);
    if (idx !== -1) {
      ws.tickers[idx] = { symbol: newSymbol, exchange: newExchange, name: newName };
      saveWorksheets();
    }
  }
  state.wlEditingSymbol = null;
  wlFetchQuotes();
  if (state.activeTab === 'watchlist') renderWatchlist($('#dashboard'));
}

// Add Row (Persistent)
async function wlAddTickerSearch(query) {
  if (!query || query.length < 1) return;
  try {
    const resp = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
    const data = await resp.json();
    const dropdown = document.getElementById('wl-add-dropdown');
    if (!dropdown) return;
    const results = (Array.isArray(data) ? data : data.results || []).slice(0, 6);
    if (results.length === 0) {
      dropdown.innerHTML = '<div class="wl-add-no-results">No results</div>';
      dropdown.style.display = 'block';
      return;
    }
    dropdown.innerHTML = results.map(r => `
      <div class="wl-add-result" onclick="wlSelectAddTicker('${escHtml(r.symbol)}', '${escHtml(r.exchange || '')}', '${escHtml(r.name || r.symbol)}')">
        <span class="wl-add-result__ticker">${escHtml(r.symbol)}</span>
        <span class="wl-add-result__name">${escHtml(r.name || '')}</span>
      </div>
    `).join('');
    dropdown.style.display = 'block';
  } catch (e) {
    console.error('Watchlist add search error:', e);
  }
}

function wlSelectAddTicker(symbol, exchange, name) {
  addToWatchlist(symbol, exchange, name);
  const addInput = document.getElementById('wl-add-input');
  if (addInput) addInput.value = '';
  wlFetchQuotes();
}

function wlCancelAdd() {
  const addInput = document.getElementById('wl-add-input');
  if (addInput) {
      addInput.value = '';
      addInput.blur();
  }
}

// ── Fetch enriched quote data for all tickers in active worksheet ──
async function wlFetchQuotes() {
  const tickers = state.watchlist.map(t => t.symbol);
  if (tickers.length === 0) return;

  try {
    const resp = await fetch(`/api/watchlist/quotes?tickers=${encodeURIComponent(tickers.join(','))}`);
    const data = await resp.json();
    if (data.quotes) {
      data.quotes.forEach(q => {
        state.wlQuoteData[q.symbol] = q;
      });
      wlUpdateTableData();

      // Fire lazy enrichment per ticker (non-blocking)
      tickers.forEach(sym => wlEnrichTicker(sym));
    }
  } catch (e) {
    console.error('Watchlist quotes fetch error:', e);
  }
}

async function wlEnrichTicker(symbol) {
  try {
    const resp = await fetch(`/api/watchlist/enrich/${encodeURIComponent(symbol)}`);
    const data = await resp.json();
    if (state.wlQuoteData[symbol]) {
      Object.assign(state.wlQuoteData[symbol], data);
      wlUpdateTableData();
    }
  } catch (e) {
    // Non-critical — enrichment is optional
  }
}

// ── Update table cells in place (no full re-render) ──
function wlUpdateTableData() {
  state.watchlist.forEach(t => {
    const q = state.wlQuoteData[t.symbol];
    if (!q) return;
    
    const row = document.querySelector(`[data-wl-symbol="${t.symbol}"]`);
    if (!row) return;

    const setCell = (cls, val) => {
      const el = row.querySelector(`.${cls}`);
      if (el) el.textContent = val;
    };
    const setCellHtml = (cls, html) => {
      const el = row.querySelector(`.${cls}`);
      if (el) el.innerHTML = html;
    };

    setCell('wl-last', q.last != null ? q.last.toFixed(2) : '\u2014');
    
    if (q.change != null) {
      const sign = q.change >= 0 ? '+' : '';
      const cls = q.change >= 0 ? 'wl-pos' : 'wl-neg';
      setCellHtml('wl-chg', `<span class="${cls}">${sign}${q.change.toFixed(2)}</span>`);
      setCellHtml('wl-chg-pct', `<span class="${cls}">${sign}${q.changePct.toFixed(2)}%</span>`);
    }

    if (q.relativeVolume != null) {
      const rvClass = q.relativeVolume >= 1.5 ? 'wl-rv-high' : q.relativeVolume >= 0.8 ? 'wl-rv-normal' : 'wl-rv-low';
      setCellHtml('wl-rvol', `<span class="${rvClass}">${q.relativeVolume.toFixed(1)}x</span>`);
    } else {
      setCell('wl-rvol', '\u2014');
    }

    // Earnings indicator
    let earningsHtml = '';
    if (q.earningsPublished) {
      earningsHtml = '<span class="wl-earnings wl-earnings--published" title="Earnings recently published">E</span>';
    } else if (q.earningsUpcoming) {
      earningsHtml = '<span class="wl-earnings wl-earnings--upcoming" title="Earnings upcoming">E</span>';
    }
    setCellHtml('wl-earnings', earningsHtml);

    // News heat — use the same heat-bars visualization as the initial render
    const heat = q.newsHeat || '';
    const heatBarsHtml = wlRenderHeatBars(heat);
    setCellHtml('wl-heat', `<div class="heat-wrapper" title="News Heat: ${heat || 'none'}"
      onclick="event.stopPropagation(); toggleWlSplitMode('${t.symbol}', 'news');">${heatBarsHtml}</div>`);
  });
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

    // Also update mobile menu clock
    const mobileClock = document.getElementById('mobile-clock');
    if (mobileClock) mobileClock.textContent = time;

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

  // If a function view is active, its renderer owns the data-source label.
  if (state.activeFunction) {
    return;
  }

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

// Override the status-bar data-source label (used by function views).
function setDataSource(source) {
  const el = $('#status-datasource');
  if (el) el.textContent = `Data: ${source}`;
}


// ═══════════════════════════════════════
// KEYBOARD SHORTCUTS
// ═══════════════════════════════════════

function initKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    // Don't trigger shortcuts when typing in inputs (except ticker input ESC)
    const inInput = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA';
    const isTickerInput = e.target.id === 'symbol-ticker-input';

    if (inInput && !isTickerInput) return;
    // Let the ticker input handle its own Enter/Escape
    if (isTickerInput) return;

    // Escape — multi-level Bloomberg behavior
    if (e.key === 'Escape') {
      // Priority 1: close article modal if open
      const modal = document.getElementById('article-modal');
      const addRowInput = document.getElementById('wl-add-input');
      
      if (modal && modal.classList.contains('article-modal--visible')) {
        closeArticleModal();
        return;
      }
      
      // Special case: if focused in the worksheet add row
      if (addRowInput && document.activeElement === addRowInput) {
        wlCancelAdd();
        return;
      }

      // Priority 2: if in a stock-specific function and symbol input NOT focused -> focus symbol input
      const symbolInput = $('#symbol-ticker-input');
      if (document.activeElement !== symbolInput && (state.activeFunction || state.symbolLoaded)) {
        if (symbolInput) {
          symbolInput.focus();
          return;
        }
      }

      // Priority 3: return to Home (if already focused, or if no stock loaded)
      if (state.activeTab !== 'home') {
        setActiveTab('home');
        if (symbolInput) symbolInput.blur();
      }
      return;
    }

    // / or Cmd+K = focus search
    if (e.key === '/' || (e.metaKey && e.key === 'k')) {
      e.preventDefault();
      $('#ticker-input').focus();
    }

    // 1-6 = ticker tabs (only active when a symbol is loaded).
    if (e.key >= '1' && e.key <= '6' && state.symbolLoaded) {
      const tabs = ['overview', 'chart', 'news', 'financials', 'profile', 'watchlist'];
      const idx = parseInt(e.key) - 1;
      if (tabs[idx]) setActiveTab(tabs[idx]);
    }
  });
}


// ═══════════════════════════════════════
// OMON — OPTIONS MONITOR (CHAIN)
// ═══════════════════════════════════════

const omonState = {
  expiration: null,
  expirations: [],
  chain: null,
  loading: false,
  greeksVisible: true,
};

function renderOMON(container) {
  container.className = 'dashboard dashboard--function';
  container.innerHTML = `
    <div class="function-wrapper">
      <header class="function-header">
        <div class="function-header__title-row">
          <div class="function-header__code">OMON</div>
          <div class="function-header__name">
            <div class="function-header__name-main">Options Monitor</div>
            <div class="function-header__name-sub">Options chain with Greeks &amp; volume — ${escHtml(state.currentTicker || '')}</div>
          </div>
        </div>
      </header>

      <div class="function-toolbar">
        <div class="function-toolbar__label">Expiry</div>
        <div class="omon-expiry-pills" id="omon-expiry-pills">
          <div class="evts-loading" style="padding:4px 12px">
            <div class="search-loading__spinner"></div>
            <span>Loading expirations…</span>
          </div>
        </div>
        <div style="margin-left:auto; display:flex; align-items:center; gap:8px">
          <button class="country-btn country-btn--active" id="omon-greeks-toggle" onclick="omonToggleGreeks()">Greeks</button>
          <button class="country-btn" onclick="openFunction('IVOL')">Vol Curve ↗</button>
        </div>
      </div>

      <div class="omon-summary" id="omon-summary"></div>

      <div class="panel function-panel">
        <div class="panel__body" id="omon-chain-container">
          <div class="evts-loading">
            <div class="search-loading__spinner"></div>
            <span>Select an expiration date…</span>
          </div>
        </div>
      </div>
    </div>
  `;

  omonLoadExpirations();
}

async function omonLoadExpirations() {
  const exchange = state.currentExchange || '';
  const ticker = state.currentTicker || '';

  try {
    const resp = await fetch(`/api/omon/expirations/${encodeURIComponent(ticker)}?exchange=${encodeURIComponent(exchange)}`);
    const data = await resp.json();

    if (data.error && (!data.expirations || data.expirations.length === 0)) {
      const cont = document.getElementById('omon-chain-container');
      if (cont) {
        cont.innerHTML = `
          <div class="omon-no-data">
            <div class="omon-no-data__icon">⚠</div>
            <div class="omon-no-data__title">No Options Data</div>
            <div class="omon-no-data__msg">Options data is not available for ${escHtml(ticker)}. This feature is currently supported for US-listed stocks only.</div>
          </div>
        `;
      }
      document.getElementById('omon-expiry-pills').innerHTML = '<span class="text-muted" style="font-size:11px">No expirations</span>';
      return;
    }

    omonState.expirations = data.expirations || [];
    omonRenderExpiryPills();

    // Auto-select the nearest expiration
    if (omonState.expirations.length > 0) {
      omonSelectExpiry(omonState.expirations[0].date);
    }
  } catch (err) {
    console.error('OMON expirations error:', err);
  }
}

function omonRenderExpiryPills() {
  const el = document.getElementById('omon-expiry-pills');
  if (!el) return;

  el.innerHTML = omonState.expirations.map((exp) => `
    <button class="country-btn ${exp.date === omonState.expiration ? 'country-btn--active' : ''}"
            data-expiry="${exp.date}"
            onclick="omonSelectExpiry('${exp.date}')">
      ${escHtml(exp.label)}
      <span class="omon-expiry-days">${exp.days}d</span>
    </button>
  `).join('');
}

async function omonSelectExpiry(expDate) {
  omonState.expiration = expDate;
  omonState.loading = true;
  omonRenderExpiryPills();

  const cont = document.getElementById('omon-chain-container');
  if (cont) {
    cont.innerHTML = `
      <div class="evts-loading">
        <div class="search-loading__spinner"></div>
        <span>Loading chain for ${expDate}…</span>
      </div>
    `;
  }

  const exchange = state.currentExchange || '';
  const ticker = state.currentTicker || '';

  try {
    const resp = await fetch(`/api/omon/chain/${encodeURIComponent(ticker)}?exchange=${encodeURIComponent(exchange)}&expiration=${encodeURIComponent(expDate)}`);
    const data = await resp.json();
    omonState.chain = data;
    omonState.loading = false;
    omonRenderChain();
    omonRenderSummary();
  } catch (err) {
    console.error('OMON chain error:', err);
    omonState.loading = false;
    if (cont) {
      cont.innerHTML = '<div class="omon-no-data"><div class="omon-no-data__icon">⚠</div><div>Error loading chain</div></div>';
    }
  }
}

function omonRenderSummary() {
  const el = document.getElementById('omon-summary');
  if (!el || !omonState.chain) return;

  const s = omonState.chain.summary || {};
  const price = omonState.chain.underlyingPrice;
  const days = omonState.chain.daysToExpiry;

  el.innerHTML = `
    <div class="omon-summary__item">
      <span class="omon-summary__label">Underlying</span>
      <span class="omon-summary__value">$${price ? price.toLocaleString() : '—'}</span>
    </div>
    <div class="omon-summary__item">
      <span class="omon-summary__label">DTE</span>
      <span class="omon-summary__value">${days ?? '—'}</span>
    </div>
    <div class="omon-summary__sep"></div>
    <div class="omon-summary__item">
      <span class="omon-summary__label">Call Vol</span>
      <span class="omon-summary__value omon-summary__value--call">${(s.callVolume ?? 0).toLocaleString()}</span>
    </div>
    <div class="omon-summary__item">
      <span class="omon-summary__label">Put Vol</span>
      <span class="omon-summary__value omon-summary__value--put">${(s.putVolume ?? 0).toLocaleString()}</span>
    </div>
    <div class="omon-summary__item">
      <span class="omon-summary__label">P/C Ratio</span>
      <span class="omon-summary__value">${s.pcRatio ?? '—'}</span>
    </div>
    <div class="omon-summary__sep"></div>
    <div class="omon-summary__item">
      <span class="omon-summary__label">Call OI</span>
      <span class="omon-summary__value">${(s.callOI ?? 0).toLocaleString()}</span>
    </div>
    <div class="omon-summary__item">
      <span class="omon-summary__label">Put OI</span>
      <span class="omon-summary__value">${(s.putOI ?? 0).toLocaleString()}</span>
    </div>
  `;
}

function omonRenderChain() {
  const container = document.getElementById('omon-chain-container');
  if (!container || !omonState.chain) return;

  const { calls, puts, underlyingPrice } = omonState.chain;
  const showGreeks = omonState.greeksVisible;

  // Build unified strike list
  const strikeSet = new Set();
  calls.forEach((c) => strikeSet.add(c.strike));
  puts.forEach((p) => strikeSet.add(p.strike));
  const strikes = Array.from(strikeSet).sort((a, b) => a - b);

  // Index by strike
  const callMap = {};
  calls.forEach((c) => { callMap[c.strike] = c; });
  const putMap = {};
  puts.forEach((p) => { putMap[p.strike] = p; });

  // Greek headers — CALLS: read right-to-left from strike (Vega furthest left)
  const greekHeadersCall = showGreeks
    ? '<th class="omon-th omon-th--greek">Vega</th><th class="omon-th omon-th--greek">Theta</th><th class="omon-th omon-th--greek">Gamma</th><th class="omon-th omon-th--greek">Delta</th>'
    : '';
  // Greek headers — PUTS: read left-to-right from strike (Vega furthest right)
  const greekHeadersPut = showGreeks
    ? '<th class="omon-th omon-th--greek">Delta</th><th class="omon-th omon-th--greek">Gamma</th><th class="omon-th omon-th--greek">Theta</th><th class="omon-th omon-th--greek">Vega</th>'
    : '';

  let html = `
    <div class="omon-chain-scroll">
      <table class="omon-table">
        <thead>
          <tr>
            <th colspan="${showGreeks ? 10 : 6}" class="omon-th-group omon-th-group--call">CALLS</th>
            <th class="omon-th-group omon-th-group--strike">STRIKE</th>
            <th colspan="${showGreeks ? 10 : 6}" class="omon-th-group omon-th-group--put">PUTS</th>
          </tr>
          <tr>
            ${greekHeadersCall}
            <th class="omon-th">Open Interest</th>
            <th class="omon-th">Volume</th>
            <th class="omon-th omon-th--iv">IV</th>
            <th class="omon-th omon-th--last">Last</th>
            <th class="omon-th">Bid</th>
            <th class="omon-th">Ask</th>
            <th class="omon-th omon-th--strike"></th>
            <th class="omon-th">Bid</th>
            <th class="omon-th">Ask</th>
            <th class="omon-th omon-th--last">Last</th>
            <th class="omon-th omon-th--iv">IV</th>
            <th class="omon-th">Volume</th>
            <th class="omon-th">Open Interest</th>
            ${greekHeadersPut}
          </tr>
        </thead>
        <tbody>
  `;

  strikes.forEach((strike) => {
    const c = callMap[strike] || {};
    const p = putMap[strike] || {};
    const callITM = strike < underlyingPrice;
    const putITM = strike > underlyingPrice;
    const atm = Math.abs(strike - underlyingPrice) / underlyingPrice < 0.005;

    const fmtG = (v) => v != null && v !== undefined ? v.toFixed(3) : '\u2014';
    const fmtN = (v) => v != null && v !== undefined ? Number(v).toLocaleString() : '\u2014';
    const fmtP = (v) => v != null && v !== undefined ? Number(v).toFixed(2) : '\u2014';

    const callIV = c.impliedVolatility || 0;
    const putIV = p.impliedVolatility || 0;

    // Calls: Vega, Theta, Gamma, Delta (furthest to nearest from strike)
    const callGreeks = showGreeks ? `
      <td class="omon-td omon-td--greek ${callITM ? 'omon-cell--itm-call' : ''}">${fmtG(c.vega)}</td>
      <td class="omon-td omon-td--greek ${callITM ? 'omon-cell--itm-call' : ''}">${fmtG(c.theta)}</td>
      <td class="omon-td omon-td--greek ${callITM ? 'omon-cell--itm-call' : ''}">${fmtG(c.gamma)}</td>
      <td class="omon-td omon-td--greek ${callITM ? 'omon-cell--itm-call' : ''}">${fmtG(c.delta)}</td>
    ` : '';

    // Puts: Delta, Gamma, Theta, Vega (nearest to furthest from strike)
    const putGreeks = showGreeks ? `
      <td class="omon-td omon-td--greek ${putITM ? 'omon-cell--itm-put' : ''}">${fmtG(p.delta)}</td>
      <td class="omon-td omon-td--greek ${putITM ? 'omon-cell--itm-put' : ''}">${fmtG(p.gamma)}</td>
      <td class="omon-td omon-td--greek ${putITM ? 'omon-cell--itm-put' : ''}">${fmtG(p.theta)}</td>
      <td class="omon-td omon-td--greek ${putITM ? 'omon-cell--itm-put' : ''}">${fmtG(p.vega)}</td>
    ` : '';

    html += `
      <tr class="omon-row ${atm ? 'omon-row--atm' : ''}">
        ${callGreeks}
        <td class="omon-td ${callITM ? 'omon-cell--itm-call' : ''}">${fmtN(c.openInterest)}</td>
        <td class="omon-td ${callITM ? 'omon-cell--itm-call' : ''}">${fmtN(c.volume)}</td>
        <td class="omon-td omon-td--iv ${callITM ? 'omon-cell--itm-call' : ''}">${callIV ? (callIV).toFixed(1) + '%' : '—'}</td>
        <td class="omon-td omon-td--last ${callITM ? 'omon-cell--itm-call' : ''}">${fmtP(c.lastPrice)}</td>
        <td class="omon-td omon-td--bid ${callITM ? 'omon-cell--itm-call' : ''}">${fmtP(c.bid)}</td>
        <td class="omon-td omon-td--ask ${callITM ? 'omon-cell--itm-call' : ''}">${fmtP(c.ask)}</td>
        <td class="omon-td omon-td--strike ${atm ? 'omon-td--atm' : ''}">${strike.toFixed(2)}</td>
        <td class="omon-td omon-td--bid ${putITM ? 'omon-cell--itm-put' : ''}">${fmtP(p.bid)}</td>
        <td class="omon-td omon-td--ask ${putITM ? 'omon-cell--itm-put' : ''}">${fmtP(p.ask)}</td>
        <td class="omon-td omon-td--last ${putITM ? 'omon-cell--itm-put' : ''}">${fmtP(p.lastPrice)}</td>
        <td class="omon-td omon-td--iv ${putITM ? 'omon-cell--itm-put' : ''}">${putIV ? (putIV).toFixed(1) + '%' : '—'}</td>
        <td class="omon-td ${putITM ? 'omon-cell--itm-put' : ''}">${fmtN(p.volume)}</td>
        <td class="omon-td ${putITM ? 'omon-cell--itm-put' : ''}">${fmtN(p.openInterest)}</td>
        ${putGreeks}
      </tr>
    `;
  });

  html += '</tbody></table></div>';
  container.innerHTML = html;

  // Auto-scroll to ATM
  setTimeout(() => {
    const atmRow = container.querySelector('.omon-row--atm');
    if (atmRow) {
      atmRow.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, 100);
}

function omonToggleGreeks() {
  omonState.greeksVisible = !omonState.greeksVisible;
  const btn = document.getElementById('omon-greeks-toggle');
  if (btn) btn.classList.toggle('country-btn--active', omonState.greeksVisible);
  omonRenderChain();
}


// ═══════════════════════════════════════
// IVOL — OPTIONS VOLATILITY CURVE
// ═══════════════════════════════════════

const ivolState = {
  expirations: [],
  selectedExpiries: [],
  chartInstance: null,
  data: null,
};

const IVOL_COLORS = [
  { border: '#ff8c00', bg: 'rgba(255,140,0,0.08)' },
  { border: '#26a69a', bg: 'rgba(38,166,154,0.08)' },
  { border: '#42a5f5', bg: 'rgba(66,165,245,0.08)' },
  { border: '#ab47bc', bg: 'rgba(171,71,188,0.08)' },
  { border: '#ef5350', bg: 'rgba(239,83,80,0.08)' },
  { border: '#66bb6a', bg: 'rgba(102,187,106,0.08)' },
];

function renderIVOL(container) {
  container.className = 'dashboard dashboard--function';
  container.innerHTML = `
    <div class="function-wrapper">
      <header class="function-header">
        <div class="function-header__title-row">
          <div class="function-header__code">IVOL</div>
          <div class="function-header__name">
            <div class="function-header__name-main">Options Volatility</div>
            <div class="function-header__name-sub">Implied volatility smile &amp; skew curves — ${escHtml(state.currentTicker || '')}</div>
          </div>
        </div>
      </header>

      <div class="function-toolbar">
        <div class="function-toolbar__label">Expirations</div>
        <div class="omon-expiry-pills" id="ivol-expiry-pills">
          <div class="evts-loading" style="padding:4px 12px">
            <div class="search-loading__spinner"></div>
            <span>Loading…</span>
          </div>
        </div>
        <div style="margin-left:auto; display:flex; align-items:center; gap:8px">
          <button class="country-btn" onclick="openFunction('OMON')">Chain ↗</button>
        </div>
      </div>

      <div class="panel function-panel">
        <div class="panel__body ovol-chart-panel" id="ivol-chart-container">
          <canvas id="ivol-canvas"></canvas>
        </div>
      </div>
    </div>
  `;

  ivolLoadData();
}

async function ivolLoadData() {
  const exchange = state.currentExchange || '';
  const ticker = state.currentTicker || '';

  try {
    const resp = await fetch(`/api/omon/expirations/${encodeURIComponent(ticker)}?exchange=${encodeURIComponent(exchange)}`);
    const expData = await resp.json();

    if (expData.error && (!expData.expirations || expData.expirations.length === 0)) {
      document.getElementById('ivol-chart-container').innerHTML = `
        <div class="omon-no-data">
          <div class="omon-no-data__icon">⚠</div>
          <div class="omon-no-data__title">No Options Data</div>
          <div class="omon-no-data__msg">Options volatility data is not available for ${escHtml(ticker)}.</div>
        </div>
      `;
      return;
    }

    ivolState.expirations = expData.expirations || [];
    ivolState.selectedExpiries = ivolState.expirations.slice(0, 4).map((e) => e.date);
    ivolRenderExpiryPills();
    await ivolFetchCurves();
  } catch (err) {
    console.error('IVOL load error:', err);
  }
}

function ivolRenderExpiryPills() {
  const el = document.getElementById('ivol-expiry-pills');
  if (!el) return;

  el.innerHTML = ivolState.expirations.map((exp) => {
    const active = ivolState.selectedExpiries.includes(exp.date);
    const colorIdx = ivolState.selectedExpiries.indexOf(exp.date);
    const dotColor = active && colorIdx >= 0 && colorIdx < IVOL_COLORS.length
      ? IVOL_COLORS[colorIdx].border : '';
    const dot = active && dotColor
      ? `<span class="ovol-color-dot" style="background:${dotColor}"></span>` : '';
    return `
      <button class="country-btn ${active ? 'country-btn--active' : ''}"
              onclick="ivolToggleExpiry('${exp.date}')">
        ${dot}${escHtml(exp.label)}
        <span class="omon-expiry-days">${exp.days}d</span>
      </button>
    `;
  }).join('');
}

async function ivolToggleExpiry(expDate) {
  const idx = ivolState.selectedExpiries.indexOf(expDate);
  if (idx >= 0) {
    if (ivolState.selectedExpiries.length <= 1) return;
    ivolState.selectedExpiries.splice(idx, 1);
  } else {
    if (ivolState.selectedExpiries.length >= 6) {
      showToast('Maximum 6 expirations');
      return;
    }
    ivolState.selectedExpiries.push(expDate);
    ivolState.selectedExpiries.sort();
  }
  ivolRenderExpiryPills();
  await ivolFetchCurves();
}

async function ivolFetchCurves() {
  const exchange = state.currentExchange || '';
  const ticker = state.currentTicker || '';

  try {
    const resp = await fetch(
      `/api/omon/volatility/${encodeURIComponent(ticker)}?exchange=${encodeURIComponent(exchange)}&expirations=${encodeURIComponent(ivolState.selectedExpiries.join(','))}`
    );
    const data = await resp.json();
    ivolState.data = data;
    ivolRenderChart();
  } catch (err) {
    console.error('IVOL fetch error:', err);
  }
}

function ivolRenderChart() {
  const canvas = document.getElementById('ivol-canvas');
  if (!canvas || !ivolState.data) return;

  if (ivolState.chartInstance) {
    ivolState.chartInstance.destroy();
    ivolState.chartInstance = null;
  }

  const { curves, underlyingPrice } = ivolState.data;
  if (!curves || curves.length === 0) return;

  const datasets = curves.map((curve, i) => {
    const color = IVOL_COLORS[i % IVOL_COLORS.length];
    return {
      label: curve.label,
      data: curve.points.map((pt) => ({ x: pt.strike, y: pt.iv })),
      borderColor: color.border,
      backgroundColor: color.bg,
      borderWidth: 2.5,
      pointRadius: 1.5,
      pointHoverRadius: 5,
      pointBackgroundColor: color.border,
      tension: 0.3,
      fill: true,
    };
  });

  // Strike range — center around ATM ±30%
  const rangeMin = underlyingPrice ? underlyingPrice * 0.7 : undefined;
  const rangeMax = underlyingPrice ? underlyingPrice * 1.3 : undefined;

  const ctx = canvas.getContext('2d');

  // ATM vertical line plugin
  const atmLinePlugin = {
    id: 'atmLine',
    afterDraw(chart) {
      if (!underlyingPrice) return;
      const xScale = chart.scales.x;
      const yScale = chart.scales.y;
      const xPixel = xScale.getPixelForValue(underlyingPrice);
      if (xPixel < xScale.left || xPixel > xScale.right) return;

      const ctx2 = chart.ctx;
      ctx2.save();
      ctx2.beginPath();
      ctx2.setLineDash([4, 4]);
      ctx2.strokeStyle = 'rgba(255,140,0,0.5)';
      ctx2.lineWidth = 1.5;
      ctx2.moveTo(xPixel, yScale.top);
      ctx2.lineTo(xPixel, yScale.bottom);
      ctx2.stroke();

      // Label
      ctx2.setLineDash([]);
      ctx2.fillStyle = 'rgba(255,140,0,0.15)';
      const label = 'ATM $' + underlyingPrice.toFixed(0);
      const textWidth = ctx2.measureText(label).width;
      ctx2.fillRect(xPixel - textWidth / 2 - 4, yScale.top + 2, textWidth + 8, 16);
      ctx2.fillStyle = '#ff8c00';
      ctx2.font = "10px 'JetBrains Mono', monospace";
      ctx2.textAlign = 'center';
      ctx2.fillText(label, xPixel, yScale.top + 14);
      ctx2.restore();
    },
  };

  ivolState.chartInstance = new Chart(ctx, {
    type: 'line',
    data: { datasets },
    plugins: [atmLinePlugin],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'nearest',
        intersect: false,
      },
      plugins: {
        legend: {
          position: 'top',
          labels: {
            color: '#8a8f98',
            font: { family: "'JetBrains Mono', 'Fira Code', monospace", size: 11 },
            usePointStyle: true,
            pointStyle: 'line',
            padding: 16,
          },
        },
        tooltip: {
          backgroundColor: '#1a1a2e',
          borderColor: '#2a2a3e',
          borderWidth: 1,
          titleColor: '#e0e0e0',
          bodyColor: '#c0c0c0',
          titleFont: { family: "'JetBrains Mono', monospace", size: 12 },
          bodyFont: { family: "'JetBrains Mono', monospace", size: 11 },
          callbacks: {
            title: (items) => 'Strike: $' + (items[0]?.parsed?.x?.toFixed(2) ?? '\u2014'),
            label: (item) => '  ' + item.dataset.label + ': ' + item.parsed.y?.toFixed(1) + '% IV',
          },
        },
      },
      scales: {
        x: {
          type: 'linear',
          min: rangeMin,
          max: rangeMax,
          title: {
            display: true,
            text: 'Strike Price ($)',
            color: '#8a8f98',
            font: { family: "'JetBrains Mono', monospace", size: 11 },
          },
          ticks: {
            color: '#6a6f78',
            font: { family: "'JetBrains Mono', monospace", size: 10 },
            callback: (v) => '$' + Number(v).toFixed(0),
          },
          grid: { color: 'rgba(255,255,255,0.04)' },
        },
        y: {
          title: {
            display: true,
            text: 'Implied Volatility (%)',
            color: '#8a8f98',
            font: { family: "'JetBrains Mono', monospace", size: 11 },
          },
          ticks: {
            color: '#6a6f78',
            font: { family: "'JetBrains Mono', monospace", size: 10 },
            callback: (v) => Number(v).toFixed(0) + '%',
          },
          grid: { color: 'rgba(255,255,255,0.04)' },
        },
      },
    },
  });
}
