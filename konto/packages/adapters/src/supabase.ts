export function createKontoClient(_client: unknown): never {
  console.warn(
    '[konto] @konto-ledger/adapters/supabase is not yet production-ready. ' +
    'Use @konto-ledger/adapters/vercel or @konto-ledger/adapters/neon instead.'
  );
  throw new Error(
    '@konto-ledger/adapters/supabase is experimental and not supported in this release. ' +
    'Neon and Vercel Postgres adapters are production-ready.'
  );
}
