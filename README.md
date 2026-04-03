# Terminal — Stock Analysis Dashboard

A Bloomberg-inspired, browser-based stock terminal for single-stock deep dives. Built as a lightweight, zero-dependency static site that embeds live TradingView widgets for real-time data.

> **Why this exists:** A free, self-hosted replacement for a Bloomberg terminal — focused on single-stock analysis with a professional-grade UI. Type any ticker, get an instant 360° view.

---

## Technology

| Layer | Tech | Notes |
|-------|------|-------|
| **Structure** | HTML5 | Single `index.html`, semantic elements |
| **Styling** | Vanilla CSS | Custom design system with CSS variables, JetBrains Mono + Inter fonts, dark Bloomberg-inspired palette |
| **Logic** | Vanilla JavaScript | No frameworks, no build step. ~400 lines in `app.js` |
| **Data** | [TradingView Widgets](https://www.tradingview.com/widget/) | Free embeddable widgets — no API key required |
| **Hosting** | Static files | Serve with any HTTP server (`python3 -m http.server`) |

### No dependencies

No `node_modules`, no `package.json`, no build tools. Open `index.html` via any local server and it works.

---

## Data Sources

All market data is sourced from **TradingView** via their free embeddable widget library:

| Widget | Data Provided | Used In |
|--------|---------------|---------|
| **Advanced Chart** | Interactive candlestick/line chart with indicators, timeframes, drawing tools | Overview, Chart, Watchlist tabs |
| **Symbol Overview** | Current price, daily change, market cap, mini chart | Overview tab (top-right) |
| **Timeline** | Company-specific news feed, press releases, analyst commentary | Overview tab (bottom-right), News tab |
| **Financials** | Income Statement, Balance Sheet, Cash Flow — with quarterly & annual period toggle | Financials tab |
| **Symbol Profile** | Sector, industry, employee count, business description | Profile tab |
| **Ticker Tape** | Scrolling real-time prices for major indices, forex, crypto | Header bar (always visible) |

### Ticker Format

Symbols follow TradingView's `EXCHANGE:TICKER` format:

- `NASDAQ:AAPL` — Apple on NASDAQ
- `NYSE:JPM` — JPMorgan on NYSE
- `AMEX:SPY` — SPDR S&P 500 ETF
- `BINANCE:BTCUSDT` — Bitcoin on Binance

You can also type just the ticker (e.g., `AAPL`) and the app will guess the exchange.

---

## Tabs

### 1. Overview
The main dashboard. Three-panel layout:
- **Left (large):** Full interactive TradingView chart with all indicators and drawing tools
- **Top-right:** Symbol Overview widget showing current price, daily change %, market cap, and a mini price chart
- **Bottom-right:** Company news timeline — latest headlines, press releases, and analyst commentary for the active ticker

### 2. Chart
Full-screen interactive TradingView chart. All tools available: candlestick styles, technical indicators (RSI, MACD, Bollinger Bands, etc.), drawing tools, timeframe selectors (1m to monthly).

### 3. News
Full-screen news timeline for the active ticker. Shows chronological company-specific news, earnings releases, analyst ratings, and market commentary sourced from TradingView's news aggregation.

### 4. Financials
Full-screen financial data view powered by TradingView's Financials widget:
- **Income Statement** — Revenue, EBITDA, Net Income, EPS
- **Balance Sheet** — Total Assets, Liabilities, Equity, Debt
- **Cash Flow** — Operating, Investing, Financing cash flows
- **Period toggle** — Switch between **Quarterly** and **Annual** reporting periods
- **Ratios & Margins** — Key profitability and valuation metrics

### 5. Profile
Split view:
- **Left:** Company profile — sector, industry, employee count, and full business description
- **Right:** Financial summary

### 6. Watchlist
Split view:
- **Left:** Interactive chart for the selected symbol
- **Right:** Clickable watchlist with pre-loaded tickers (AAPL, MSFT, GOOGL, AMZN, TSLA, NVDA, META, JPM, V, BRK.B). Click any ticker to load it across all tabs.

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `/` or `⌘K` | Focus the ticker search bar |
| `1` – `6` | Switch between tabs |
| `Enter` | Submit ticker search |
| `Esc` | Close search / dropdown |

---

## Running Locally

```bash
cd terminal
python3 -m http.server 8888
# Open http://localhost:8888
```

Or use any static file server (e.g., `npx serve`, VS Code Live Server, nginx).

---

## Project Structure

```
terminal/
├── index.html      # App shell (header, ticker tape, tabs, status bar)
├── styles.css      # Full design system (Bloomberg dark theme)
├── app.js          # All logic (widget injection, search, tabs, shortcuts)
└── README.md       # This file
```

---

## Future Improvements

- [ ] Proper financial data via yfinance Python backend (IS, BS, CF with custom period selection)
- [ ] Custom metric calculations (ROE, ROIC, FCF Yield, etc.)
- [ ] Multi-ticker comparison view
- [ ] Portfolio tracking & P&L
- [ ] Earnings calendar integration
- [ ] Persistent watchlist (currently resets on reload)
- [ ] Screener / universe filtering
