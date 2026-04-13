export class KontoInsufficientFundsError extends Error {
  constructor() {
    super("Insufficient funds");
    this.name = "KontoInsufficientFundsError";
  }
}

export class KontoUnbalancedTransactionError extends Error {
  constructor() {
    super("Transaction must balance to zero");
    this.name = "KontoUnbalancedTransactionError";
  }
}

export class KontoDuplicateTransactionError extends Error {
  constructor() {
    super("Duplicate transaction detected");
    this.name = "KontoDuplicateTransactionError";
  }
}
