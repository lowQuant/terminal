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

### Step 1 — Generate a Flex Web Service token

In IBKR **Client Portal** → **Performance & Reports** → **Flex Queries**
(or **Account Management** → **Reports** → **Flex Queries** on the
classic portal):

1. Scroll to the **Flex Web Service** panel at the bottom of the page.
2. If it's disabled, click **Configure** → **Enable** the service.
3. Click **Generate token** (or **New token**). Copy the long hex
   string — this is your **Flex Token**. Treat it like a password.

Tokens don't expire on their own, but if you regenerate one the old
one stops working instantly. Revoke = regenerate.

### Step 2 — Create an Activity Flex Query

On the same Flex Queries page, click **Create (Activity Flex Query)**.

**Query-level settings**

| Setting | Value |
|---|---|
| Query name | `terminal-portfolio` (any name works) |
| Period | `Last Business Day` — fastest. Use `Month-to-Date` if you want a NAV curve. |
| Format | **XML** |
| Version | **3** |
| Delivery | Default (on-demand via Web Service) |

**Sections and fields**

Add each of the four sections below and tick the listed fields.
The terminal is tolerant — enabling more fields than listed won't
break anything (unknown attributes are ignored), but ticking the
fields below is the minimum for a full PORT view.

#### Account Information

Powers the account ID shown in the PORT header.

| Field | Used for |
|---|---|
| `accountId` | Account identifier in the header |

#### Open Positions

Powers the positions table.

| Field | Used for |
|---|---|
| `symbol` | Ticker |
| `description` | Company name |
| `assetCategory` | STK / OPT / BOND / FUND |
| `currency` | Position currency |
| `listingExchange` | Exchange |
| `position` | Quantity |
| `markPrice` | Current mark |
| `positionValue` | Market value (local currency) |
| `positionValueInBase` | Market value in base currency |
| `fxRateToBase` | FX rate used to convert cost basis & P&L to base |
| `costBasisPrice` | Cost per share |
| `costBasisMoney` | Total cost basis (local currency) |
| `fifoPnlUnrealized` | Unrealized P&L (local currency) |
| `percentOfNAV` | Position weight in the portfolio |

> **Multi-currency accounts:** the `positionValueInBase` and
> `fxRateToBase` fields are what let the terminal show Value / Cost
> basis / P&L in your base currency and make the weights add up to
> 100%. Without them, EUR + USD positions are summed as raw numbers
> and the totals are meaningless.

Set the **Options** flag for this section to: Level of Detail →
`Summary` (one row per instrument). Lot-level rows aren't used.

#### Cash Report

Powers the cash-balances table.

| Field | Used for |
|---|---|
| `currency` | USD, EUR, …, plus synthetic `BASE_SUMMARY` |
| `endingCash` | Balance at report date |
| `endingSettledCash` | Settled portion |

#### Net Asset Value in Base Currency (NAV Summary)

Powers the NAV tile and the base currency used throughout the view.

| Field | Used for |
|---|---|
| `reportDate` | Time-series x-axis (if Period > 1 day) |
| `currency` | Base currency (e.g. USD) |
| `cash` / `stock` / `options` / `bond` / `fund` | NAV breakdown |
| `total` | Total NAV |

Save the query. The **Query ID** (a numeric value) appears in the
Flex Queries list — you'll need it in Step 3.

### Step 3 — Paste credentials into the terminal

1. Open the terminal.
2. Click your avatar → **Settings** → scroll to **Brokerage**.
3. Paste the **Flex Token** from Step 1 and the **Query ID** from
   Step 2.
4. Click **Save**.

### Step 4 — View your portfolio

Type `PORT` in the search bar (or `PORTFOLIO`, `HOLDINGS`, `IBKR`)
and hit Enter. You should see your account ID, NAV, positions
value, unrealized P&L, cash balance, and a table of positions
sorted by market value.

You can also reference your portfolio inside any workflow by adding
a step that calls the `PORT` tool. The tool reads the credentials
from your run context automatically — you don't need to pass them
as parameters.

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
| `Invalid Flex token` (1005) | Regenerate the token in Account Management — old tokens stop working when you rotate. |
| `Flex token has expired` (1012) | Same fix — generate a new token and paste it in Settings. |
| `Invalid Query ID` (1006) | Confirm the Query ID is the **numeric** ID from the Flex Queries list (not the query name). |
| `Invalid Flex Query` (1007) | Open the query in IBKR, save it again — the format version may be stale. |
| `Flex Web Service is not enabled` (1010) | Enable Flex Web Service in Step 1 above. |
| `Too many requests` (1018) | IBKR throttles. Wait a minute. The terminal's 15-min cache prevents this in normal use. |
| `IBKR took too long to generate the statement` | Narrow the query — set Period to `Last Business Day`, drop unused sections. Very large accounts can exceed the 60s poll window. |
| No positions shown, but cash + NAV render | Your query's Open Positions section is disabled or has Level of Detail set to `Lot`. Re-enable it at the Summary level. |

## Revoking access

To unlink IBKR from the terminal:

- **In the terminal**: Settings → Brokerage → clear both fields → Save.
- **In IBKR**: Account Management → Flex Web Service → regenerate or
  disable the token. The old token stops working immediately.
