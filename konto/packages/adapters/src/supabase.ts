export function createKontoClient(_client: unknown): never {
  console.warn(
    '[konto] @konto/adapters/supabase is not yet production-ready. ' +
    'Use @konto/adapters/vercel or @konto/adapters/neon instead.'
  );
  throw new Error(
    '@konto/adapters/supabase is experimental and not supported in this release. ' +
    'Neon and Vercel Postgres adapters are production-ready.'
  );
}
