import Link from "next/link";
import { sql } from "@/lib/db";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { CreateAccountForm } from "@/components/forms/create-account-form";

export const dynamic = "force-dynamic";

export default async function AccountsPage() {
  // Direct SQL query using LATERAL joins for liquid balance calculation
  const accounts = await sql<
    {
      id: string;
      name: string;
      account_type: string;
      currency: string;
      created_at: Date;
      snapshot_balance: string;
      entries_sum: string;
      holds_sum: string;
    }[]
  >`
    SELECT 
      a.id,
      a.name,
      a.account_type,
      a.currency,
      a.created_at,
      COALESCE(s.balance, 0)::text AS snapshot_balance,
      COALESCE(e.total, 0)::text AS entries_sum,
      COALESCE(h.total, 0)::text AS holds_sum
    FROM konto_accounts a
    LEFT JOIN LATERAL (
      SELECT balance, snapshot_at 
      FROM konto_balance_snapshots 
      WHERE account_id = a.id 
      ORDER BY snapshot_at DESC 
      LIMIT 1
    ) s ON true
    LEFT JOIN LATERAL (
      SELECT SUM(amount) as total
      FROM konto_entries
      WHERE account_id = a.id 
        AND (s.snapshot_at IS NULL OR created_at > s.snapshot_at)
    ) e ON true
    LEFT JOIN LATERAL (
      SELECT SUM(amount) as total
      FROM konto_holds
      WHERE account_id = a.id
        AND status = 'PENDING'
        AND (expires_at IS NULL OR NOW() <= expires_at)
    ) h ON true
    ORDER BY a.created_at DESC
  `;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-end justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-primary uppercase">Accounts</h1>
          <p className="text-muted-foreground mt-1">
            Real-time liquid balance visualization derived natively from Postgres via LATERAL JOINs.
          </p>
        </div>
        
        <Dialog>
          <DialogTrigger asChild>
            <Button>New Account</Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[425px]">
            <DialogHeader>
              <DialogTitle>Create Account</DialogTitle>
              <DialogDescription>
                Add a new account to the ledger. Natively supports multi-currency and account types.
              </DialogDescription>
            </DialogHeader>
            <CreateAccountForm />
          </DialogContent>
        </Dialog>
      </div>

      <div className="border rounded-md">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Currency</TableHead>
              <TableHead className="text-right">Balance</TableHead>
              <TableHead className="text-right">Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {accounts.map((acc) => {
              const snapshotBalance = BigInt(acc.snapshot_balance);
              const entriesSum = BigInt(acc.entries_sum);
              const holdsSum = BigInt(acc.holds_sum);
              const balance = snapshotBalance + entriesSum - holdsSum;
              const isNegative = balance < 0n;

              return (
                <TableRow key={acc.id}>
                  <TableCell className="font-medium">
                    <Link href={`/accounts/${acc.id}`} className="hover:underline">
                      {acc.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary" className="font-mono text-xs">
                      {acc.account_type}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{acc.currency}</TableCell>
                  <TableCell className={`text-right font-mono ${isNegative ? "text-destructive" : ""}`}>
                    {balance.toString()}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground text-sm">
                    {acc.created_at.toISOString().split("T")[0]}
                  </TableCell>
                </TableRow>
              );
            })}
            {accounts.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                  No accounts found. Create one using the MCP Server.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
