/**
 * KontoQueryExecutor is a generic IoC abstraction for database drivers.
 * It strictly supports ES6 Tagged Template Literals to ensure the core
 * engine's syntactic sugar is preserved across multiple database targets
 * (Postgres.js, Vercel Edge Serverless, standard pg).
 */
export interface KontoQueryExecutor {
  /** Tagged template literal executor: await db<{id: string}[]>\`SELECT ...\` */
  <T extends any[]>(strings: TemplateStringsArray, ...values: any[]): Promise<T>;

  /** Scoped transaction wrapper guaranteeing commit/rollback automations */
  begin<T>(cb: (tx: KontoQueryExecutor) => Promise<T>): Promise<T>;

  /** Bare, unsafe SQL execution (for migrations and unparameterized logic) */
  unsafe<T extends any[]>(query: string, parameters?: any[]): Promise<T>;

  /** JSON parameter serialization helper */
  json(value: any): any;
}

/**
 * KontoLogger is a dependency-injected observability interface.
 * Inject via setKontoLogger() in @konto/core. If not injected,
 * all log calls are silently no-oped — @konto/core stays dependency-free.
 *
 * Compatible with pino, winston, console, or any structured logger.
 */
export interface KontoLogger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}
