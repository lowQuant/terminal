# IBKR integration — setup guide

The `PORT` function lets you view your Interactive Brokers portfolio
(positions, cash balances, NAV) inside the terminal. It uses IBKR's
**Flex Web Service** — a read-only XML API that IBKR provides for
portfolio reporting.

## Why this is safe

The Flex token is **read-only by design**. It cannot:

- Place, modify, or cancel orders
- Transfer funds
- Change account settings or permissions

It only generates the reports you define in Account Management. You
can revoke it in one click at any time. The token lives in your
Supabase profile (`profiles.broker_config`), which is row-level-
security protected so no other user can read it, and it's transmitted
to the backend only when you open the `PORT` view or run a workflow
that uses the `PORT` tool — never stored server-side, never logged.

## One-time setup

### 1. Enable Flex Web Service on your IBKR account

In **IBKR Account Management** → **Settings** → **Account Settings**
→ **Reporting** → **Flex Web Service**:

1. Click **Configure** next to *Flex Web Service*
2. Enable the service
3. Click **Generate token** — copy this token somewhere safe for the
   next step. It looks like a long hex string.

### 2. Create a Flex Query

Still in Account Management: **Reporting** → **Flex Queries** →
**Create (Activity Flex Query)**:

1. Give it a name, e.g. `terminal-portfolio`
2. Set **Period** to `Last Business Day` (or `Month to Date` if you
   want NAV history)
3. Set **Format** to `XML` and version to `3`
4. Under **Sections**, tick these (untick all others — smaller query
   = faster response):

   | Section | Why |
   |---|---|
   | **Open Positions** | Positions with symbol, quantity, mark, cost basis, unrealized P&L |
   | **Cash Report** | Cash balances per currency (plus base summary) |
   | **Net Asset Value in Base Currency** | NAV snapshot / time series |
   | **Account Information** | Account ID (used for the header) |

5. For each section, click its gear icon and enable **all** columns
   (or at minimum: symbol, description, assetCategory, currency,
   listingExchange, position, markPrice, positionValue,
   costBasisPrice, costBasisMoney, fifoPnlUnrealized, percentOfNAV
   for Open Positions; currency, endingCash, endingSettledCash for
   Cash Report; reportDate, total for NAV).
6. Save — note the **Query ID** (a number) shown in the Flex Queries
   list.

### 3. Paste credentials into the terminal

1. Open the terminal, click your avatar → **Settings**
2. Scroll to the **Brokerage** section
3. Paste your **Flex Token** and **Query ID**
4. Click **Save**

### 4. View your portfolio

Type `PORT` into the search bar (or `PORTFOLIO`, `HOLDINGS`, `IBKR`)
and hit Enter. You should see your account ID, NAV, positions value,
unrealized P&L, cash balance, and a table of positions sorted by market
value.

You can also reference your portfolio inside any workflow by adding a
step that calls the `PORT` tool. The tool reads the credentials from
your run context automatically — you don't need to pass them as
parameters.

## Data freshness

Flex statements are **end-of-day**. The `asOf` timestamp in the
header shows when the snapshot was generated. The terminal caches
responses for 15 minutes to avoid hammering IBKR's Flex service on
every widget open; closing and reopening PORT within that window is
free.

If you need live intraday data, that requires IBKR's Client Portal
Web API, which needs a local gateway running with daily 2FA
re-authentication — not something that fits a hosted terminal. Flex
is the right tradeoff for a "how is my portfolio doing today" view.

## Troubleshooting

| Error | Fix |
|---|---|
| `Invalid Flex token` (code 1005) | Regenerate the token in Account Management — old tokens expire after rotation. |
| `Flex token has expired` (code 1012) | Same fix — generate a new token and paste it in Settings. |
| `Invalid Query ID` (code 1006) | Confirm the Query ID is the numeric ID from the Flex Queries list (not the query name). |
| `Flex Web Service is not enabled` (code 1010) | Enable Flex Web Service in Account Management (Step 1 above). |
| `Too many requests` (code 1018) | IBKR throttles; wait a minute. The terminal's 15-min cache should prevent this in normal use. |
| `IBKR took too long to generate the statement` | Narrow the query — set Period to `Last Business Day`, untick unused sections. Large accounts with many instruments can exceed the 60s poll window. |

## Revoking access

To unlink IBKR from the terminal:

- **In the terminal**: Settings → Brokerage → clear both fields → Save.
- **In IBKR**: Account Management → Flex Web Service → regenerate or
  disable the token. The old token stops working immediately.
