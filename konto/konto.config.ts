import { defineLedger } from "./packages/cli/src/config";

export default defineLedger({
  transfer: { invoice_id: "string", notes: "string?" },
  account: { status: "enum:['ACTIVE', 'FROZEN']" }
});
