/**
 * @konto-ledger/core — Logger Singleton
 *
 * Dependency-injected observability. If no logger is set,
 * all calls are silently no-oped. @konto-ledger/core remains dependency-free.
 *
 * Usage:
 *   import { setKontoLogger } from '@konto-ledger/core';
 *   import pino from 'pino';
 *   setKontoLogger(pino());
 */

import type { KontoLogger } from "@konto-ledger/types";

const noop = () => {};

const noopLogger: KontoLogger = {
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
};

let currentLogger: KontoLogger = noopLogger;

export function setKontoLogger(logger: KontoLogger): void {
  currentLogger = logger;
}

export function getKontoLogger(): KontoLogger {
  return currentLogger;
}
