import { expectTypeOf } from "vitest";
import type postgres from "postgres";
import type { KontoQueryExecutor, KontoTransactionExecutor } from "@konto-ledger/types";
import { transferInTx, commitHoldInTx, rollbackHoldInTx } from "../src/index";

expectTypeOf<postgres.Sql>().toMatchTypeOf<KontoQueryExecutor>();
expectTypeOf<postgres.TransactionSql>().toMatchTypeOf<KontoTransactionExecutor>();
expectTypeOf<postgres.TransactionSql>().not.toMatchTypeOf<KontoQueryExecutor>();
expectTypeOf<Parameters<typeof transferInTx>[0]>().toEqualTypeOf<KontoTransactionExecutor>();
expectTypeOf<Parameters<typeof commitHoldInTx>[0]>().toEqualTypeOf<KontoTransactionExecutor>();
expectTypeOf<Parameters<typeof rollbackHoldInTx>[0]>().toEqualTypeOf<KontoTransactionExecutor>();
