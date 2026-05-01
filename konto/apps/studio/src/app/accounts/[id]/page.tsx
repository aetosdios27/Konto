import { notFound } from "next/navigation";
import { sql } from "@/lib/db";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";

export const dynamic = "force-dynamic";

export default async function AccountDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const resolvedParams = await params;
  const accountId = resolvedParams.id;

  // 1. Fetch Account Details & Balance
  const accountRows = await sql<
    {
      id: string;
      name: string;
      account_type: string;
      currency: string;
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
    WHERE a.id = ${accountId}
  `;

  const account = accountRows[0];
  if (!account) {
    notFound();
  }

  const snapshotBalance = BigInt(account.snapshot_balance);
  const entriesSum = BigInt(account.entries_sum);
  const holdsSum = BigInt(account.holds_sum);
  const balance = snapshotBalance + entriesSum - holdsSum;
  const isNegative = balance < 0n;

  // 2. Fetch Latest 50 Journals
  const journals = await sql<
    {
      id: string;
      description: string | null;
      created_at: Date;
      entries: { accountId: string; amount: string }[];
    }[]
  >`
    SELECT 
      j.id,
      j.description,
      j.created_at,
      e.agg_entries as entries
    FROM konto_journals j
    JOIN LATERAL (
      SELECT 
        json_agg(
          json_build_object(
            'accountId', account_id,
            'amount', amount::text
          )
        ) as agg_entries
      FROM konto_entries
      WHERE journal_id = j.id
    ) e ON true
    WHERE j.id IN (
      SELECT journal_id FROM konto_entries WHERE account_id = ${accountId}
    )
    ORDER BY j.created_at DESC, j.id DESC
    LIMIT 50
  `;

  return (
    <div className="flex flex-col gap-8">
      {/* Account Overview */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-2xl font-bold">{account.name}</CardTitle>
          <Badge variant="secondary" className="font-mono">
            {account.account_type}
          </Badge>
        </CardHeader>
        <CardContent>
          <div className="flex items-baseline gap-2">
            <span className={`text-4xl font-mono tracking-tight ${isNegative ? "text-destructive" : "text-primary"}`}>
              {balance.toString()}
            </span>
            <span className="text-muted-foreground font-medium">{account.currency}</span>
          </div>
          <div className="mt-4 flex gap-4 text-xs font-mono text-muted-foreground">
            <div><span className="text-foreground">Snapshot:</span> {account.snapshot_balance}</div>
            <div><span className="text-foreground">New Entries:</span> {account.entries_sum}</div>
            <div><span className="text-foreground">Active Holds:</span> {account.holds_sum}</div>
          </div>
        </CardContent>
      </Card>

      {/* Journals Table */}
      <div>
        <div className="mb-4">
          <h2 className="text-xl font-semibold tracking-tight">Recent Journals</h2>
          <p className="text-sm text-muted-foreground">Latest 50 transactions.</p>
        </div>
        
        <div className="border rounded-md">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[120px]">Journal ID</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Legs</TableHead>
                <TableHead className="text-right">Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {journals.map((journal) => (
                <TableRow key={journal.id}>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {journal.id.split("-")[0]}...
                  </TableCell>
                  <TableCell>{journal.description || "-"}</TableCell>
                  <TableCell>
                    <div className="flex flex-col gap-1 text-xs font-mono">
                      {journal.entries.map((leg, i) => {
                        const amt = BigInt(leg.amount);
                        const isDebit = amt < 0n;
                        const isThisAccount = leg.accountId === accountId;
                        return (
                          <div 
                            key={i} 
                            className={`flex justify-between w-full max-w-[250px] ${isThisAccount ? 'font-bold text-foreground' : 'text-muted-foreground'}`}
                          >
                            <span className="truncate mr-4" title={leg.accountId}>
                              {leg.accountId === accountId ? "(this)" : leg.accountId.split("-")[0]}
                            </span>
                            <span className={isDebit ? "text-destructive" : "text-green-500"}>
                              {amt > 0n ? "+" : ""}{leg.amount}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground text-sm">
                    {journal.created_at.toISOString().replace("T", " ").split(".")[0]}
                  </TableCell>
                </TableRow>
              ))}
              {journals.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">
                    No transactions found.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}
