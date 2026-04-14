/* ═══════════════════════════════════════════════════════════
   TERMINAL — Onboarding Tour
   First-time user walkthrough explaining how to navigate.
   Exposes:
     window.startTour()      — force-start the tour
     window.maybeStartTour() — start only if user hasn't completed it
   ═══════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  const STORAGE_KEY = 'terminal_tour_done_v1';
  const SPOTLIGHT_PADDING = 8;

  // ── Tour steps ────────────────────────────────────────────
  // Each step targets a DOM selector (or null for centered modal).
  // `prep()` runs before the step is shown — useful for scrolling
  // hidden elements into view or loading a demo symbol.
  const STEPS = [
    {
      target: null,
      placement: 'center',
      title: 'Welcome to TERMINAL',
      body: `
        <p>A Bloomberg-inspired research workstation — keyboard-first,
        function-driven, and wired to live market data.</p>
        <p>This quick tour (≈60 seconds) walks you through how to
        navigate. You can press <span class="kbd">Esc</span> to skip
        at any time, or replay it later from <span class="kbd">F1</span>.</p>
      `,
    },
    {
      target: '.search-container',
      placement: 'bottom',
      title: 'Universal Search',
      body: `
        <p>The command center. Search here to jump anywhere.</p>
        <ul class="tour-tip__list">
          <li><b>Tickers</b> — type <span class="kbd">AAPL</span>,
              <span class="kbd">TSLA</span>, or a company name
              (e.g. <i>Toyota</i>).</li>
          <li><b>Function codes</b> — type
              <span class="kbd">EVTS</span> (earnings),
              <span class="kbd">ECO</span> (economic calendar),
              <span class="kbd">EQS</span> (screener),
              <span class="kbd">WF</span> (workflows), and more.</li>
        </ul>
        <p>Press <span class="kbd">/</span> or
        <span class="kbd">⌘K</span> from anywhere to focus the search.</p>
      `,
      prep: () => {
        const input = document.getElementById('ticker-input');
        if (input) input.blur();
      },
    },
    {
      target: '#ticker-tape',
      placement: 'bottom',
      title: 'Live Ticker Tape',
      body: `
        <p>Live quotes stream across the top. <b>Click any ticker</b>
        to load it straight into the terminal — no external redirects.</p>
        <p>Hit the <span class="kbd">⚙</span> on the right edge to
        customize. You can curate your own list, or flip the tape to
        <b>mirror your active watchlist</b> so the symbols you track
        are always in view.</p>
      `,
    },
    {
      target: '#symbol-bar',
      placement: 'bottom',
      title: 'Active Symbol Bar',
      body: `
        <p>Once a ticker is loaded, it anchors here — exchange, name,
        and the current function badge stay visible so you always
        know what you're looking at.</p>
        <p>Press <span class="kbd">Esc</span> to focus the ticker
        field, then type a <b>ticker</b> or a <b>company name</b> —
        live autosuggestions appear below. Use the arrow keys to
        highlight a match and <span class="kbd">Enter</span> to swap
        without leaving the current function.</p>
      `,
      prep: ensureDemoSymbol,
    },
    {
      target: '#nav-tabs',
      placement: 'bottom',
      title: 'Stock-Context Tabs',
      body: `
        <p>Six views for the loaded security — each bound to a number key:</p>
        <ul class="tour-tip__list tour-tip__list--compact">
          <li><span class="kbd">1</span> Overview &nbsp;·&nbsp;
              <span class="kbd">2</span> Chart &nbsp;·&nbsp;
              <span class="kbd">3</span> News</li>
          <li><span class="kbd">4</span> Financials &nbsp;·&nbsp;
              <span class="kbd">5</span> Profile &nbsp;·&nbsp;
              <span class="kbd">6</span> Watchlist</li>
        </ul>
        <p>Tabs only appear when a symbol is loaded. Hit
        <span class="kbd">Esc</span> to return home.</p>
      `,
      prep: ensureDemoSymbol,
    },
    {
      target: '#status-bar',
      placement: 'top',
      title: 'Status Bar & Shortcuts',
      body: `
        <p>Bottom strip shows the live feed status, the active symbol,
        the data source, and handy keyboard hints. Keep an eye on the
        <span style="color: var(--green)">●</span> dot — it tells you
        when data is flowing.</p>
      `,
    },
    {
      target: '#help-btn',
      placement: 'bottom-left',
      title: 'Help is always here',
      body: `
        <p>Click the <span class="kbd">?</span> up top — or press
        <span class="kbd">F1</span> from anywhere — to open the
        <b>Help page</b>.</p>
        <p>It's a searchable reference for every function (market and
        stock-specific), with aliases, how-to-invoke hints, and
        related-function jump links. You can <b>replay this tour</b>
        from there any time.</p>
      `,
    },
    {
      target: '#settings-btn',
      placement: 'bottom-left',
      title: 'Agent Settings',
      body: `
        <p>Before running <b>Workflows</b> (type <span class="kbd">WF</span>),
        open Settings and drop in an API key for your preferred LLM
        provider — Anthropic, OpenAI, Gemini, Perplexity, or OpenRouter.</p>
        <p>Keys are encrypted per-user and never leave your browser
        except on a workflow run.</p>
      `,
      prep: () => {
        // If a settings modal is open from a previous step, close it.
        const m = document.getElementById('settings-modal');
        if (m) m.classList.remove('article-modal--visible');
      },
    },
    {
      target: null,
      placement: 'center',
      title: "You're ready",
      body: `
        <p>That's the lay of the land. A few parting tips:</p>
        <ul class="tour-tip__list">
          <li>Press <span class="kbd">/</span> to search anything.</li>
          <li>Press <span class="kbd">Esc</span> to step back.</li>
          <li>Press <span class="kbd">F1</span> for Help — function docs plus a button to replay this tour.</li>
        </ul>
        <p>Happy trading.</p>
      `,
      nextLabel: 'Finish',
    },
  ];

  // ── Helpers ───────────────────────────────────────────────
  function ensureDemoSymbol() {
    // If no symbol is loaded yet, quietly load AAPL so the symbol bar
    // and tabs are visible for the following steps. We don't want the
    // tour to land on invisible elements.
    const st = window.state;
    if (!st) return;
    if (st.symbolLoaded) return;
    if (typeof window.loadSymbol === 'function') {
      try { window.loadSymbol('NASDAQ:AAPL', true, 'Apple Inc.'); } catch (_) { /* noop */ }
    } else if (typeof window.setActiveTab === 'function') {
      // Fallback: at least show the overview tab scaffolding.
      try { window.setActiveTab('overview'); } catch (_) { /* noop */ }
    }
  }

  function visible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }

  // ── Tour controller ───────────────────────────────────────
  let tourState = null;

  function buildDOM() {
    const root = document.createElement('div');
    root.id = 'tour-root';
    root.className = 'tour-root';
    root.innerHTML = `
      <div class="tour-backdrop" data-tour-skip></div>
      <div class="tour-spotlight" id="tour-spotlight"></div>
      <div class="tour-tip" id="tour-tip" role="dialog" aria-modal="true" aria-labelledby="tour-tip-title">
        <div class="tour-tip__header">
          <span class="tour-tip__badge">TOUR</span>
          <span class="tour-tip__progress" id="tour-tip-progress"></span>
          <button class="tour-tip__close" id="tour-skip" title="Skip tour (Esc)" aria-label="Skip tour">✕</button>
        </div>
        <h3 class="tour-tip__title" id="tour-tip-title"></h3>
        <div class="tour-tip__body" id="tour-tip-body"></div>
        <div class="tour-tip__footer">
          <button class="tour-tip__btn tour-tip__btn--ghost" id="tour-back">Back</button>
          <div class="tour-tip__spacer"></div>
          <button class="tour-tip__btn tour-tip__btn--ghost" id="tour-skip-text">Skip</button>
          <button class="tour-tip__btn tour-tip__btn--primary" id="tour-next">Next</button>
        </div>
        <div class="tour-tip__arrow" id="tour-tip-arrow"></div>
      </div>
    `;
    document.body.appendChild(root);
    return root;
  }

  function positionStep(step) {
    const tip = document.getElementById('tour-tip');
    const spot = document.getElementById('tour-spotlight');
    const arrow = document.getElementById('tour-tip-arrow');
    if (!tip || !spot) return;

    const target = step.target ? document.querySelector(step.target) : null;
    const targetVisible = target && visible(target);
    const placement = step.placement || 'bottom';

    // Spotlight
    if (targetVisible && placement !== 'center') {
      const r = target.getBoundingClientRect();
      const pad = SPOTLIGHT_PADDING;
      spot.style.display = 'block';
      spot.style.top  = `${r.top - pad}px`;
      spot.style.left = `${r.left - pad}px`;
      spot.style.width  = `${r.width  + pad * 2}px`;
      spot.style.height = `${r.height + pad * 2}px`;
    } else {
      spot.style.display = 'none';
    }

    // Tooltip position
    tip.classList.remove(
      'tour-tip--center',
      'tour-tip--bottom',
      'tour-tip--top',
      'tour-tip--left',
      'tour-tip--right',
      'tour-tip--bottom-left'
    );

    if (!targetVisible || placement === 'center') {
      tip.classList.add('tour-tip--center');
      tip.style.top = '';
      tip.style.left = '';
      arrow.style.display = 'none';
      return;
    }

    const r = target.getBoundingClientRect();
    const tipRect = tip.getBoundingClientRect(); // current size before repositioning
    const margin = 16;
    arrow.style.display = '';

    let top = 0, left = 0, arrowLeft = '50%', arrowTop = '0', cls = '';

    switch (placement) {
      case 'top':
        cls = 'tour-tip--top';
        top = r.top - tipRect.height - margin;
        left = r.left + r.width / 2 - tipRect.width / 2;
        arrowLeft = `${r.left + r.width / 2 - left}px`;
        arrowTop = `${tipRect.height}px`;
        break;
      case 'left':
        cls = 'tour-tip--left';
        top = r.top + r.height / 2 - tipRect.height / 2;
        left = r.left - tipRect.width - margin;
        break;
      case 'right':
        cls = 'tour-tip--right';
        top = r.top + r.height / 2 - tipRect.height / 2;
        left = r.right + margin;
        break;
      case 'bottom-left':
        cls = 'tour-tip--bottom-left';
        top = r.bottom + margin;
        left = r.right - tipRect.width;
        arrowLeft = `${r.left + r.width / 2 - left}px`;
        arrowTop = '-6px';
        break;
      case 'bottom':
      default:
        cls = 'tour-tip--bottom';
        top = r.bottom + margin;
        left = r.left + r.width / 2 - tipRect.width / 2;
        arrowLeft = `${r.left + r.width / 2 - left}px`;
        arrowTop = '-6px';
        break;
    }

    // Clamp to viewport
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    left = Math.max(12, Math.min(left, vw - tipRect.width - 12));
    top  = Math.max(12, Math.min(top,  vh - tipRect.height - 12));

    tip.classList.add(cls);
    tip.style.top  = `${top}px`;
    tip.style.left = `${left}px`;
    arrow.style.left = arrowLeft;
    arrow.style.top  = arrowTop;
  }

  function renderStep() {
    if (!tourState) return;
    const step = STEPS[tourState.index];
    if (!step) return endTour(true);

    if (typeof step.prep === 'function') {
      try { step.prep(); } catch (_) { /* noop */ }
    }

    const title = document.getElementById('tour-tip-title');
    const body  = document.getElementById('tour-tip-body');
    const prog  = document.getElementById('tour-tip-progress');
    const back  = document.getElementById('tour-back');
    const next  = document.getElementById('tour-next');

    title.textContent = step.title || '';
    body.innerHTML = step.body || '';
    prog.textContent = `${tourState.index + 1} / ${STEPS.length}`;
    back.disabled = tourState.index === 0;
    next.textContent = step.nextLabel
      || (tourState.index === STEPS.length - 1 ? 'Finish' : 'Next');

    // Give the tooltip a frame to measure before positioning
    requestAnimationFrame(() => positionStep(step));
  }

  function reposition() {
    if (!tourState) return;
    const step = STEPS[tourState.index];
    if (step) positionStep(step);
  }

  function endTour(completed) {
    if (!tourState) return;
    try {
      if (completed) localStorage.setItem(STORAGE_KEY, '1');
    } catch (_) { /* noop */ }

    window.removeEventListener('resize', reposition);
    window.removeEventListener('scroll', reposition, true);
    document.removeEventListener('keydown', tourState.keyHandler, true);

    const root = document.getElementById('tour-root');
    if (root) root.remove();
    tourState = null;
  }

  function next() {
    if (!tourState) return;
    if (tourState.index >= STEPS.length - 1) return endTour(true);
    tourState.index++;
    renderStep();
  }

  function back() {
    if (!tourState) return;
    if (tourState.index <= 0) return;
    tourState.index--;
    renderStep();
  }

  function startTour() {
    // Avoid double-start
    if (tourState) return;

    // Don't start if the login screen is still showing
    const welcome = document.getElementById('welcome-page');
    if (welcome && welcome.style.display !== 'none') return;

    const root = buildDOM();

    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        endTour(false);
      } else if (e.key === 'ArrowRight' || e.key === 'Enter') {
        e.preventDefault();
        next();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        back();
      }
    };

    tourState = { index: 0, keyHandler: onKey };

    // Wire buttons
    root.querySelector('#tour-next').addEventListener('click', next);
    root.querySelector('#tour-back').addEventListener('click', back);
    root.querySelector('#tour-skip').addEventListener('click', () => endTour(false));
    root.querySelector('#tour-skip-text').addEventListener('click', () => endTour(false));
    root.querySelector('[data-tour-skip]').addEventListener('click', () => endTour(false));

    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);

    renderStep();
  }

  function maybeStartTour() {
    let done = false;
    try { done = localStorage.getItem(STORAGE_KEY) === '1'; } catch (_) {}
    if (done) return;
    // Wait one frame so the terminal finishes its initial layout.
    requestAnimationFrame(() => {
      setTimeout(startTour, 300);
    });
  }

  function resetTour() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
  }

  // Silently dismiss a running tour without marking it complete.
  // Used by help.js when the user opens Help during a live tour.
  function endTourSilently() {
    if (tourState) endTour(false);
  }

  // Expose
  window.startTour = startTour;
  window.maybeStartTour = maybeStartTour;
  window.resetTour = resetTour;
  window.endTourSilently = endTourSilently;
})();
