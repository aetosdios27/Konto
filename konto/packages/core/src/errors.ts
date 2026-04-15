export class KontoInsufficientFundsError extends Error {
  constructor(message = "konto: insufficient funds for transfer") {
    super(message);
    this.name = "KontoInsufficientFundsError";
  }
}

export class KontoUnbalancedTransactionError extends Error {
  constructor(message = "konto: transfer entries do not sum to zero") {
    super(message);
    this.name = "KontoUnbalancedTransactionError";
  }
}

export class KontoDuplicateTransactionError extends Error {
  constructor(
    message = "konto: duplicate transaction detected via idempotency key",
  ) {
    super(message);
    this.name = "KontoDuplicateTransactionError";
  }
}

export class KontoInvalidEntryError extends Error {
  constructor(message = "konto: invalid entry in transfer payload") {
    super(message);
    this.name = "KontoInvalidEntryError";
  }
}

export class KontoHoldNotFoundError extends Error {
  constructor(message = "konto: hold not found") {
    super(message);
    this.name = "KontoHoldNotFoundError";
  }
}
