# @konto-ledger/core

Strictly-typed double-entry ledger primitives for PostgreSQL. 

This is the core engine for Konto, providing mathematically correct, zero-sum financial mutations. It handles row-level locking, balance derivation, and staged intent execution natively in the database.

## Installation

```bash
npm install @konto-ledger/core
```

## Quick Start

You typically do not use `@konto-ledger/core` by itself. It is designed to be used alongside the generated `.konto` client and a database adapter.

For the full documentation, architecture details, and setup guide, please visit the main repository:

**[GitHub: aetosdios27/Konto](https://github.com/aetosdios27/Konto)**
