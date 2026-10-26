# Releasing Konto 0.2.0

This guide details the release procedure, package publishing sequence, git tagging, Yen integration, and critical deployment instructions for the **0.2.0** release.

---

## 1. Important Note on Release Workflow Location

> [!WARNING]
> GitHub Actions only discovers workflows placed in `.github/workflows/` at the **git repository root**.
> The workflow is currently located in the monorepo subdirectory at `konto/.github/workflows/release.yml`. Because the git root is the parent directory (`/home/aetos/dev/personal/Konto`), GitHub does not detect or trigger this workflow (confirmed via `gh workflow list --repo aetosdios27/Konto`).

You have two options:
1. **Option A (Recommended for automated CI/CD)**: Move `konto/.github/workflows/release.yml` to `.github/workflows/release.yml` at the git root, and configure `defaults.run.working-directory: konto` across jobs.
2. **Option B (Manual publishing)**: Publish directly from the developer machine using the verified sequence below.

---

## 2. Publish Instructions (Human Operator)

Publishing is strictly the human maintainer's decision. Ensure you are on the release branch or merged `main`.

### Publish Order

Due to internal dependency chains, packages must be published in strict topological order:

1. `@konto-ledger/types` (0.2.0)
2. `@konto-ledger/core` (0.2.0) — depends on types
3. `@konto-ledger/adapters` (0.2.0) — depends on types
4. `@konto-ledger/cli` (0.2.0) — depends on types and ships migrations 0001–0009

### Step-by-Step Manual Publish Commands

From `konto/` (the pnpm monorepo root):

```bash
# 1. Ensure build artifacts are fresh and gates pass
pnpm install --frozen-lockfile
pnpm build
pnpm check-types
KONTO_TEST_DATABASE_URL=postgres://postgres:pw@localhost:55432/postgres pnpm test

# 2. Publish @konto-ledger/types
cd packages/types
pnpm publish --access public
cd ../..

# 3. Publish @konto-ledger/core
cd packages/core
pnpm publish --access public
cd ../..

# 4. Publish @konto-ledger/adapters
cd packages/adapters
pnpm publish --access public
cd ../..

# 5. Publish @konto-ledger/cli
cd packages/cli
pnpm publish --access public
cd ../..
```

Alternatively, publish all packages across the workspace:
```bash
pnpm -r publish --access public
```

### 2FA / OTP Authentication Notes

- If your npm account has Two-Factor Authentication (2FA) enabled for authorization and publishing, you may be prompted in the terminal for an Authenticator code (OTP).
- If prompted non-interactively or scripting, provide `--otp <code>`:
  ```bash
  pnpm publish --access public --otp 123456
  ```

---

## 3. Git Tags and GitHub Release

Create changesets-style git tags for each package, plus an optional overall release tag:

```bash
# Create package-specific tags
git tag @konto-ledger/types@0.2.0
git tag @konto-ledger/core@0.2.0
git tag @konto-ledger/adapters@0.2.0
git tag @konto-ledger/cli@0.2.0
git tag v0.2.0

# Push tags to GitHub
git push origin @konto-ledger/types@0.2.0 \
                @konto-ledger/core@0.2.0 \
                @konto-ledger/adapters@0.2.0 \
                @konto-ledger/cli@0.2.0 \
                v0.2.0

# Create GitHub Release
gh release create v0.2.0 \
  --repo aetosdios27/Konto \
  --title "Konto 0.2.0 — Hardened Ledger Engine & In-Tx Primitives" \
  --notes "### Konto 0.2.0 Release Notes

Highlights:
- **Snapshot sequence cutoffs**: Sequence cutoffs for every balance calculation and the snapshot daemon.
- **In-Tx primitives**: Exported \`transferInTx\`, \`commitHoldInTx\`, and \`rollbackHoldInTx\` for atomic multi-table mutations within caller-managed transactions.
- **Ledger immutability**: Database-level prevention of \`UPDATE\`, \`DELETE\`, and \`TRUNCATE\` on journals and entries via CLI migrations 0008 and 0009.
- **Flat parameterized adapter queries**: Safe bindings across PostgreSQL adapters.
- **CLI improvements**: Interactive \`init\`, standalone \`migrate\`, and bulk queue approval."
```

---

## 4. Consuming Konto 0.2.0 in the Yen App

Once published to npm, update dependencies in the Yen application:

```bash
# In the Yen repository root / package workspace:
pnpm add @konto-ledger/core@^0.2.0 @konto-ledger/types@^0.2.0

# If Yen utilizes adapters or the CLI:
pnpm add @konto-ledger/adapters@^0.2.0
pnpm add -D @konto-ledger/cli@^0.2.0
```

---

## 5. Deployment & Production Operational Notes

> [!IMPORTANT]
> Carefully review these requirements before upgrading your production environments to Konto 0.2.0.

1. **Apply Migrations Before Upgrading Core**:
   Apply CLI migrations `0008_snapshot_sequences.sql` and `0009_ledger_immutability.sql` before running the updated core service in production.
   - Run `npx @konto-ledger/cli migrate` against your target database.
   - Migration `0008` intentionally discards old derived balance snapshots (all posted entry records remain intact) and introduces sequence-based snapshot caching.
   - Migration `0009` installs append-only rules and triggers.

2. **Database Role Privileges**:
   Application database roles connecting to Konto **must not possess DDL rights** (`ALTER TABLE`, `DROP TABLE`, `DISABLE TRIGGER`). Grant only standard DML privileges (`CONNECT`, `SELECT`, `INSERT` on tables, and `EXECUTE` on schema functions). This ensures database-level immutability cannot be circumvented by application connections.

3. **Neon Serverless Requirements**:
   When using the Neon adapter (`@konto-ledger/adapters/neon`), you **must** use the WebSocket connection Pool (`import { Pool } from '@neondatabase/serverless'`) rather than HTTP stateless fetch queries. Interactive transactions (`transferInTx`, `commitHoldInTx`, etc.) require a persistent stateful session.

4. **Supabase Status**:
   The Supabase adapter remains **experimental and unsupported** in 0.2.0 (it will throw at runtime). If connecting to Supabase Postgres, connect directly using `postgres.js` or standard TCP pooling via `@konto-ledger/core`.
