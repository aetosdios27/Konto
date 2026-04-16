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
