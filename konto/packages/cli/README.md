# @konto-ledger/cli

The command-line interface and typed client generator for Konto ledgers.

This CLI tool provisions your PostgreSQL database with the necessary schema and dynamically generates a strictly-typed `.konto` client based on your `konto.config.ts` business rules.

## Installation

```bash
npm install @konto-ledger/cli
```

## Usage

Initialize a new ledger configuration:
```bash
npx @konto-ledger/cli init
```

Apply migrations to your database:
```bash
npx @konto-ledger/cli migrate
```

Generate the strongly-typed client:
```bash
npx @konto-ledger/cli generate
```

For the full documentation and setup guide, please visit the main repository:

**[GitHub: aetosdios27/Konto](https://github.com/aetosdios27/Konto)**
