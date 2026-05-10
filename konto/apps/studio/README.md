# Konto Studio

**The brutalist command center for your double-entry ledger.**

A Next.js 16 App Router dashboard that connects directly to your PostgreSQL instance via Server Components. No ORM. No REST API layer. Just raw `postgres.js` queries rendered server-side with real-time client components where liveness matters.

---

## What It Does

Studio is a first-party administration interface for the Konto ledger. It gives you five core views:

| Route | Purpose |
|---|---|
| `/` | **Accounts** — Full table of every account with real-time liquid balance derived via `LATERAL JOIN`s. Genesis system accounts are visually muted with a `GENESIS` badge. |
| `/accounts/[id]` | **Account Detail** — Per-account dashboard showing a large balance header (Snapshot + New Entries − Active Holds) and the 50 most recent journals with debit/credit leg breakdowns. |
| `/transfers` | **Transfers** — Dual-pane layout. Left: Zod-validated cross-currency transfer form with client-side idempotency. Right: live feed of the 25 most recent journal entries across all accounts. |
| `/holds` | **Escrow Holds** — Table of all holds (PENDING, COMMITTED, ROLLED_BACK) with a **real-time countdown** for pending holds. The countdown turns red when under 5 minutes remain. |
| `/intents` | **Agent Intents** — The human side of the Agent Authorization Profile. View pending staged intents from MCP agents, inspect payloads, and approve or reject them with a single click. |

---

## The Command Center

Studio is not a read-only viewer. It ships with native mutation forms that execute Server Actions directly against Postgres, bypassing the Agent Authorization Profile entirely. This is deliberate — a human sitting at the dashboard is already authenticated by physical presence.

### Create Account (with Genesis Funding)

The "New Account" dialog accepts:
- **Account Name** — Must be unique (enforced by migration `0004_account_name_unique.sql`).
- **Currency** — ISO 4217 (e.g. `USD`, `EUR`, `INR`).
- **Account Type** — `ASSET`, `LIABILITY`, `EQUITY`, `REVENUE`, or `EXPENSE`.
- **Initial Balance (optional)** — Amount in **minor units** (e.g. `500` = $5.00).

When you provide an initial balance, Studio automatically:
1. Creates (or finds) a deterministic system account named `__konto_genesis_USD__` with `account_type: 'LIABILITY'`.
2. Executes a zero-sum transfer: debit the genesis account, credit the new account.

This preserves the strict double-entry constraint while giving you 1-click account seeding. The genesis account uses `INSERT ... ON CONFLICT (name) DO NOTHING`, which depends on the `UNIQUE` constraint from migration `0004`.

> **Important:** Migration `0004_account_name_unique.sql` must be applied for genesis funding to work correctly. Without the `UNIQUE` constraint on `name`, the `ON CONFLICT` clause has no target and duplicates could be silently created.

### Direct Transfer

The transfer form is fully validated:
- Accounts are presented as named dropdowns (no UUID typing).
- Cross-currency transfers are blocked at the Zod schema level.
- Same-account transfers are rejected.
- **Client-side idempotency key** — A `crypto.randomUUID()` is generated on component mount and only refreshed after a successful commit. Double-clicks produce `KontoDuplicateTransactionError`, not double transfers.

### Hold Countdown

The `/holds` page uses a client-side `useEffect` + `setInterval` countdown — not server-rendered relative timestamps. This is critical because server-rendered "5 minutes ago" goes stale the instant the page loads. The countdown:
- Ticks every second.
- Formats as `Xh Ym`, `Xm Ys`, or `Xs` depending on remaining time.
- Turns **red** (`text-red-400`) when under 5 minutes remain.
- Shows `Expired` when the hold TTL has elapsed.
- Shows `No expiry` for holds without an `expires_at`.

---

## Visual Conventions

### Genesis Accounts

System accounts (names starting with `__konto_genesis_`) are treated specially throughout the UI:
- **Accounts table** — Greyed out (reduced opacity), non-clickable, labelled "System Funding Source" with a `GENESIS` badge.
- **Transfer dropdowns** — Displayed as `SYSTEM_GENESIS` with muted styling, but remain selectable in case you need to manually drain funds back into them.

### Status Badges

| Status | Color |
|---|---|
| `PENDING` | Yellow background, black text |
| `EXECUTED` / `COMMITTED` | Dark green background, green text |
| `ROLLED_BACK` / `REJECTED` | Dark red background, red text |
| `EXPIRED` | Dark yellow background, yellow text |

---

## Tech Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16.2.4 (Turbopack) |
| Styling | Tailwind CSS v4 + shadcn/ui |
| Database | Direct `postgres.js` via Server Components |
| Forms | `react-hook-form` + `zod` + `@hookform/resolvers` |
| Toasts | `sonner` (dark theme, bottom-right) |
| Font | Geist Mono (monospace-only, brutalist) |

---

## Setup

### Prerequisites

- PostgreSQL 16+ with the Konto schema applied (all migrations through `0007`).
- A `.env` file (or environment variables) with `DATABASE_URL`.

### Run

```bash
# From the monorepo root
cd apps/studio
echo 'DATABASE_URL="postgres://konto:konto@127.0.0.1:5432/konto"' > .env
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

### Build

```bash
pnpm build   # Production bundle
pnpm start   # Serve the production build
```

---

## Routes

```
apps/studio/src/app/
├── page.tsx                    # / — Accounts list + "New Account" dialog
├── accounts/[id]/page.tsx      # /accounts/:id — Account detail + journals
├── transfers/page.tsx          # /transfers — Transfer form + activity feed
├── holds/page.tsx              # /holds — Escrow holds + live countdown
├── intents/page.tsx            # /intents — Staged intent approval queue
├── actions.ts                  # Server Actions (create account, transfer, approve/reject)
├── layout.tsx                  # Root layout (nav, toaster, dark mode)
└── globals.css                 # Tailwind config
```
