/* ═══════════════════════════════════════════════════════════
   TERMINAL — Help Modal
   Function documentation, keyboard shortcuts, and tour entry
   point. Replaces F1 from the tour so users can pull up a
   searchable reference without triggering a full walkthrough.

   Exposes:
     window.showHelp()         — open the modal
     window.showHelpFor(code)  — open and scroll to a function card
     window.closeHelp()        — close the modal
   ═══════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // ── Help data ─────────────────────────────────────────────
  // Each entry augments an entry in the FUNCTIONS registry
  // (defined in app.js) with richer docs: category, related
  // functions, a long-form description, and how-to-invoke copy.
  // Codes must match FUNCTIONS[*].code so we can join on them.
  const HELP_EXTRA = {
    // ── Market-level ──
    ECO: {
      category: 'market',
      longDesc: 'Macro economic calendar — GDP, CPI, payrolls, central bank decisions with impact ratings and Actual / Forecast / Prior values. Filter by country.',
      related: ['EVTS', 'MOV'],
    },
    EVTS: {
      category: 'market',
      longDesc: 'Upcoming earnings with EPS estimates, market cap, reporting time. Full US coverage via NASDAQ; international via TradingView scanner. Currency-aware.',
      related: ['ECO', 'EQS', 'MOST'],
    },
    EQS: {
      category: 'market',
      longDesc: 'Multi-factor equity screener. Pick a market, stack filters (fundamentals, technicals, price), save your presets. Powered by the TradingView scanner.',
      related: ['MOST', 'MOV', 'EVTS'],
    },
    MOST: {
      category: 'market',
      longDesc: 'Top gainers, losers, volume leaders, and US pre-market movers. Market-cap floor prevents microcap noise.',
      related: ['MOV', 'EQS', 'IMAP'],
    },
    MOV: {
      category: 'market',
      longDesc: 'Which index constituents drove the index up or down, ranked by contribution in basis points. Answers "why did the S&P move?" — not just "how much".',
      related: ['MOST', 'EQS', 'IMAP'],
    },
    IMAP: {
      category: 'market',
      longDesc: 'Interactive heatmaps for stocks, ETFs, crypto, and FX with sector / asset-class breakdowns.',
      related: ['MOST', 'MOV', 'EQS'],
    },

    // ── Stock-specific ──
    DES: {
      category: 'security',
      longDesc: 'Company overview — price, market cap, sector, valuation multiples (P/E, P/B, P/S, PEG), margins, earnings dates, beta, 52-week range. The front page for a single name.',
      related: ['FA', 'GP', 'CN'],
    },
    GP: {
      category: 'security',
      longDesc: 'Interactive price chart. TradingView embed where supported, Lightweight Charts + yfinance fallback otherwise.',
      related: ['DES', 'CN', 'OMON'],
    },
    CN: {
      category: 'security',
      longDesc: 'Recent news with an in-app reader modal (full-text extraction via trafilatura). Headlines, publishers, timestamps, thumbnails, summaries.',
      related: ['DES', 'GP'],
    },
    FA: {
      category: 'security',
      longDesc: 'Financial analysis — margins, ROE, ROA, growth, PE / PEG, dividend yield, payout ratio, beta. Overhaul planned: full IS / BS / CF with quarterly & annual periods.',
      related: ['IS', 'BS', 'CF', 'DES'],
    },
    IS: {
      category: 'security',
      longDesc: 'Income Statement view — revenue, expenses, net income. Part of the FA module.',
      related: ['FA', 'BS', 'CF'],
    },
    BS: {
      category: 'security',
      longDesc: 'Balance Sheet view — assets, liabilities, equity. Part of the FA module.',
      related: ['FA', 'IS', 'CF'],
    },
    CF: {
      category: 'security',
      longDesc: 'Cash Flow view — operating, investing, financing. Part of the FA module.',
      related: ['FA', 'IS', 'BS'],
    },
    OMON: {
      category: 'security',
      longDesc: 'Full options chain for a single expiration with Black-Scholes Greeks (delta, gamma, theta, vega). Calls and puts side by side.',
      related: ['IVOL', 'VCONE', 'GP'],
    },
    IVOL: {
      category: 'security',
      longDesc: 'Implied volatility smile / skew across expirations. OI-weighted IV per strike, with per-expiration curve overlay so you can compare term structure visually.',
      related: ['OMON', 'VCONE'],
    },
    VCONE: {
      category: 'security',
      longDesc: 'Volatility cone — historical realized vol distribution across multiple windows vs current IV. Spots where realized is cheap / rich relative to history.',
      related: ['IVOL', 'OMON'],
    },

    // ── Navigation / agentic ──
    W: {
      category: 'nav',
      longDesc: 'Personal worksheet(s) with live enriched quotes — price, change %, volume, relative volume, market cap, earnings proximity, news heat. Split-view with chart.',
      related: ['WF', 'DES', 'EQS'],
    },
    WF: {
      category: 'nav',
      longDesc: 'Agentic research workflows — chain functions together with Claude / GPT / Gemini / Perplexity analysis. Builder UI, saved workflows, natural-language compiler.',
      related: ['W', 'EQS', 'EVTS'],
    },

    // ── Not yet implemented ──
    CMDTY: {
      category: 'soon',
      longDesc: 'Commodity overview — major commodities snapshot. Not started yet.',
      related: [],
    },
    FX: {
      category: 'soon',
      longDesc: 'Currency cross rates. FX is already wired as a cross-cutting conversion service (ECB rates, used by EVTS / MOST / MOV currency dropdowns); a dedicated FX function is planned.',
      related: [],
    },
    WEIF: {
      category: 'soon',
      longDesc: 'World Equity Futures — global index futures. Not started yet.',
      related: [],
    },
  };

  const CATEGORY_META = {
    market:   { label: 'Market-level',    hint: 'No ticker required — global data',          order: 1 },
    security: { label: 'Security-specific', hint: 'Requires a loaded ticker',                order: 2 },
    nav:      { label: 'Navigation & agent', hint: 'Worksheets & agentic workflows',         order: 3 },
    soon:     { label: 'Coming soon',     hint: 'Listed in autocomplete with a SOON badge',  order: 4 },
  };

  const SHORTCUTS = [
    { keys: ['/'],               desc: 'Focus the global search bar' },
    { keys: ['⌘', 'K'],          desc: 'Focus search (alternate)' },
    { keys: ['1'], extra: '…6',  desc: 'Switch stock tabs (Overview, Chart, News, Financials, Profile, Watchlist)' },
    { keys: ['Esc'],             desc: 'Focus ticker input · leave a function · return home (priority-based)' },
    { keys: ['F1'],              desc: 'Open this Help page' },
    { keys: ['Enter'],           desc: 'Load highlighted result · confirm ticker swap' },
    { keys: ['↑', '↓'],          desc: 'Navigate autocomplete suggestions' },
  ];

  // ── DOM builders ──────────────────────────────────────────
  let _rootEl = null;

  function _buildDOM() {
    const root = document.createElement('div');
    root.id = 'help-root';
    root.className = 'help-root';
    root.innerHTML = `
      <div class="help-backdrop" data-help-close></div>
      <div class="help-modal" role="dialog" aria-modal="true" aria-labelledby="help-title">
        <header class="help-modal__header">
          <div class="help-modal__titleblock">
            <span class="help-modal__badge">HELP</span>
            <h2 class="help-modal__title" id="help-title">Terminal Reference</h2>
          </div>
          <div class="help-modal__actions">
            <button class="help-modal__btn help-modal__btn--primary" id="help-start-tour" title="Replay the first-time tour">
              ▶ Start Tour
            </button>
            <button class="help-modal__close" data-help-close title="Close (Esc)" aria-label="Close">✕</button>
          </div>
        </header>

        <div class="help-modal__searchbar">
          <span class="help-modal__search-icon">⌕</span>
          <input type="text" class="help-modal__search" id="help-search"
                 placeholder="Search functions — try 'options', 'EVTS', or 'volatility'..."
                 spellcheck="false" autocomplete="off">
          <span class="help-modal__search-hint"><span class="kbd">Esc</span></span>
        </div>

        <div class="help-modal__body" id="help-body">
          <!-- Shortcuts section -->
          <section class="help-section" data-help-section="shortcuts">
            <h3 class="help-section__title">Keyboard Shortcuts</h3>
            <p class="help-section__hint">Keyboard-first — the fast path around the terminal.</p>
            <div class="help-shortcuts" id="help-shortcuts"></div>
          </section>

          <!-- Function sections are injected by _renderFunctions -->
          <div id="help-functions"></div>

          <footer class="help-modal__footer">
            <span>Terminal · Function reference · Press <span class="kbd">F1</span> to reopen this anytime</span>
          </footer>
        </div>
      </div>
    `;
    document.body.appendChild(root);
    return root;
  }

  function _renderShortcuts() {
    const host = document.getElementById('help-shortcuts');
    if (!host) return;
    host.innerHTML = SHORTCUTS.map(s => {
      const keysHtml = s.keys.map(k => `<span class="kbd">${_esc(k)}</span>`).join(' ')
        + (s.extra ? ` <span class="help-shortcut__keys-extra">${_esc(s.extra)}</span>` : '');
      return `
        <div class="help-shortcut">
          <div class="help-shortcut__keys">${keysHtml}</div>
          <div class="help-shortcut__desc">${_esc(s.desc)}</div>
        </div>`;
    }).join('');
  }

  function _renderFunctions() {
    const host = document.getElementById('help-functions');
    if (!host) return;
    const fns = (window.FUNCTIONS || []).slice();
    // Group by category
    const groups = {};
    fns.forEach(fn => {
      const extra = HELP_EXTRA[fn.code] || {};
      const cat = extra.category || 'security';
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(Object.assign({}, fn, extra));
    });

    const ordered = Object.keys(groups).sort((a, b) => {
      const ao = (CATEGORY_META[a] && CATEGORY_META[a].order) || 99;
      const bo = (CATEGORY_META[b] && CATEGORY_META[b].order) || 99;
      return ao - bo;
    });

    host.innerHTML = ordered.map(cat => {
      const meta = CATEGORY_META[cat] || { label: cat, hint: '' };
      const cards = groups[cat].map(_renderCard).join('');
      return `
        <section class="help-section" data-help-section="fn" data-help-cat="${_esc(cat)}">
          <h3 class="help-section__title">${_esc(meta.label)}</h3>
          ${meta.hint ? `<p class="help-section__hint">${_esc(meta.hint)}</p>` : ''}
          <div class="help-fn-grid">${cards}</div>
        </section>
      `;
    }).join('');

    // Wire "Open" buttons & related pills
    host.querySelectorAll('[data-help-open]').forEach(el => {
      el.addEventListener('click', () => {
        const code = el.getAttribute('data-help-open');
        if (!code) return;
        if (typeof window.openFunction === 'function') {
          closeHelp();
          setTimeout(() => window.openFunction(code), 80);
        }
      });
    });
    host.querySelectorAll('[data-help-related]').forEach(el => {
      el.addEventListener('click', () => {
        const code = el.getAttribute('data-help-related');
        if (!code) return;
        _scrollToCard(code);
      });
    });
  }

  function _renderCard(fn) {
    const aliases = (fn.aliases || []).filter(a => a !== fn.code);
    const soon = fn.category === 'soon' || fn.implemented === false;
    const related = (fn.related || []).filter(Boolean);
    const howTo = soon
      ? `<span class="help-card__soon">Not yet implemented</span>`
      : `<span class="help-card__howto">Type <span class="kbd">${_esc(fn.code)}</span> in search, or press <span class="kbd">Enter</span> on any alias.</span>`;
    return `
      <article class="help-card ${soon ? 'help-card--soon' : ''}"
               data-help-code="${_esc(fn.code)}"
               id="help-card-${_esc(fn.code)}">
        <header class="help-card__header">
          <span class="help-card__code">${_esc(fn.code)}</span>
          <div class="help-card__titleblock">
            <h4 class="help-card__name">${_esc(fn.name || '')}</h4>
            <p class="help-card__desc">${_esc(fn.desc || '')}</p>
          </div>
          ${soon ? '<span class="help-card__badge help-card__badge--soon">SOON</span>' : ''}
        </header>

        <p class="help-card__long">${_esc(fn.longDesc || fn.desc || '')}</p>

        ${aliases.length ? `
          <div class="help-card__row">
            <span class="help-card__label">Aliases</span>
            <div class="help-card__aliases">
              ${aliases.map(a => `<span class="help-card__alias kbd">${_esc(a)}</span>`).join(' ')}
            </div>
          </div>` : ''}

        <div class="help-card__row">
          <span class="help-card__label">How to open</span>
          <div class="help-card__howto-wrap">${howTo}</div>
        </div>

        ${related.length ? `
          <div class="help-card__row">
            <span class="help-card__label">Related</span>
            <div class="help-card__related">
              ${related.map(r => `<button type="button" class="help-card__related-pill" data-help-related="${_esc(r)}">${_esc(r)}</button>`).join('')}
            </div>
          </div>` : ''}

        ${soon ? '' : `
          <div class="help-card__footer">
            <button class="help-card__open" data-help-open="${_esc(fn.code)}" type="button">Open ${_esc(fn.code)} →</button>
          </div>`}
      </article>
    `;
  }

  function _scrollToCard(code) {
    const card = document.getElementById('help-card-' + code);
    if (!card) return;
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    card.classList.add('help-card--flash');
    setTimeout(() => card.classList.remove('help-card--flash'), 1400);
  }

  function _filter(query) {
    const q = (query || '').trim().toLowerCase();
    const cards = document.querySelectorAll('.help-card');
    cards.forEach(card => {
      if (!q) { card.style.display = ''; return; }
      const hay = card.textContent.toLowerCase();
      card.style.display = hay.includes(q) ? '' : 'none';
    });
    // Hide sections with no visible cards
    document.querySelectorAll('[data-help-section="fn"]').forEach(sec => {
      const any = Array.from(sec.querySelectorAll('.help-card'))
        .some(c => c.style.display !== 'none');
      sec.style.display = any ? '' : 'none';
    });
  }

  // ── Public API ────────────────────────────────────────────
  function showHelp(focusCode) {
    // Hide the tour if it's running — Help is the canonical reference
    // and the tour will be replayable from the button inside the modal.
    if (typeof window.endTourSilently === 'function') window.endTourSilently();

    if (!_rootEl) {
      _rootEl = _buildDOM();
      _renderShortcuts();
      _renderFunctions();

      // Wire close / tour / search
      _rootEl.querySelectorAll('[data-help-close]').forEach(el => {
        el.addEventListener('click', closeHelp);
      });
      const tourBtn = _rootEl.querySelector('#help-start-tour');
      if (tourBtn) tourBtn.addEventListener('click', () => {
        closeHelp();
        setTimeout(() => {
          if (typeof window.startTour === 'function') window.startTour();
        }, 80);
      });
      const searchEl = _rootEl.querySelector('#help-search');
      if (searchEl) {
        searchEl.addEventListener('input', (e) => _filter(e.target.value));
        searchEl.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') {
            if (searchEl.value) { searchEl.value = ''; _filter(''); }
            else closeHelp();
          }
        });
      }
    }

    _rootEl.classList.add('help-root--visible');
    requestAnimationFrame(() => {
      if (focusCode) _scrollToCard(focusCode);
      else {
        const body = document.getElementById('help-body');
        if (body) body.scrollTop = 0;
      }
      const searchEl = document.getElementById('help-search');
      if (searchEl && !focusCode) searchEl.focus();
    });
  }

  function closeHelp() {
    if (_rootEl) _rootEl.classList.remove('help-root--visible');
  }

  function isHelpOpen() {
    return !!(_rootEl && _rootEl.classList.contains('help-root--visible'));
  }

  // ── Global keyboard — F1 toggles help ─────────────────────
  document.addEventListener('keydown', (e) => {
    if (e.key === 'F1') {
      // Don't hijack F1 in text inputs (dev shortcut territory)
      const t = e.target;
      const tag = t && t.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (t && t.isContentEditable)) return;
      // Skip when the terminal isn't rendered yet (welcome / login screen)
      const app = document.getElementById('app');
      if (!app || app.style.display === 'none') return;
      e.preventDefault();
      if (isHelpOpen()) closeHelp();
      else showHelp();
      return;
    }
    if (e.key === 'Escape' && isHelpOpen()) {
      const searchEl = document.getElementById('help-search');
      if (searchEl && document.activeElement === searchEl && searchEl.value) {
        // let the input's own handler clear its value first
        return;
      }
      e.preventDefault();
      e.stopPropagation();   // don't also fire the app's "return home" escape
      closeHelp();
    }
  }, true);

  // ── Wire the ? button in the user nav + mobile menu ───────
  function _wireButtons() {
    const btn = document.getElementById('help-btn');
    if (btn && !btn._helpBound) {
      btn.addEventListener('click', () => showHelp());
      btn._helpBound = true;
    }
    const mbtn = document.getElementById('mobile-help-btn');
    if (mbtn && !mbtn._helpBound) {
      mbtn.addEventListener('click', () => {
        // Close mobile menu first if open
        const mm = document.getElementById('mobile-menu');
        if (mm) mm.classList.remove('mobile-menu--visible');
        showHelp();
      });
      mbtn._helpBound = true;
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _wireButtons);
  } else {
    _wireButtons();
  }
  // Also try again after a tick in case the user-nav was hidden at load
  setTimeout(_wireButtons, 500);

  // ── Utility ───────────────────────────────────────────────
  function _esc(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // Expose
  window.showHelp = showHelp;
  window.showHelpFor = (code) => showHelp(code);
  window.closeHelp = closeHelp;
})();
