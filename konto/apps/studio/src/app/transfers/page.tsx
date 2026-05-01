import { sql } from "@/lib/db";
import { DirectTransferForm } from "@/components/forms/direct-transfer-form";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { formatDistanceToNow } from "date-fns";

export const dynamic = "force-dynamic";

export default async function TransfersPage() {
  // Fetch all accounts and their liquid balances
  // We use the same LATERAL JOIN pattern from the accounts page to get accurate balances
  const accountsRows = await sql`
    SELECT 
      a.id,
      a.name,
      a.currency,
      COALESCE(e.total_entries, 0) AS total_entries,
      COALESCE(h.total_holds, 0) AS total_holds
    FROM konto_accounts a
    LEFT JOIN LATERAL (
      SELECT SUM(amount) as total_entries
      FROM konto_entries
      WHERE account_id = a.id
    ) e ON true
    LEFT JOIN LATERAL (
      SELECT SUM(amount) as total_holds
      FROM konto_holds
      WHERE account_id = a.id
        AND status = 'PENDING'
        AND (expires_at IS NULL OR NOW() <= expires_at)
    ) h ON true
    ORDER BY a.created_at DESC
  `;

  const accounts = accountsRows.map((r: any) => {
    const balance = BigInt(r.total_entries) - BigInt(r.total_holds);
    return {
      id: r.id,
      name: r.name,
      currency: r.currency,
      availableBalance: balance.toString(),
    };
  });

  // Fetch recent journals (across all accounts)
  const recentJournals = await sql`
    SELECT 
      j.id, 
      j.created_at,
      j.description,
      (
        SELECT json_agg(json_build_object('account_id', account_id, 'amount', amount::text))
        FROM konto_entries 
        WHERE journal_id = j.id
      ) as legs
    FROM konto_journals j
    ORDER BY j.created_at DESC
    LIMIT 25
  `;

  return (
    <div className="container max-w-6xl mx-auto py-8">
      <div className="flex items-end justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-primary uppercase">Transfers</h1>
          <p className="text-muted-foreground mt-1">
            Execute direct double-entry movements.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        <div>
          <DirectTransferForm accounts={accounts} />
        </div>

        <div>
          <h3 className="font-semibold text-lg border-b pb-2 mb-4">Recent Ledger Activity</h3>
          <div className="space-y-4">
            {recentJournals.length === 0 ? (
              <p className="text-sm text-muted-foreground">No recent transfers found.</p>
            ) : (
              recentJournals.map((j: any) => (
                <Card key={j.id} className="rounded-none border-border bg-card/50">
                  <CardHeader className="py-3 px-4">
                    <div className="flex justify-between items-center">
                      <CardTitle className="text-sm font-mono truncate mr-2" title={j.id}>
                        JNL: {j.id.split("-")[0]}...
                      </CardTitle>
                      <span className="text-xs text-muted-foreground">
                        {formatDistanceToNow(new Date(j.created_at), { addSuffix: true })}
                      </span>
                    </div>
                    {j.description && (
                      <CardDescription className="text-xs">{j.description}</CardDescription>
                    )}
                  </CardHeader>
                  <Separator />
                  <CardContent className="py-3 px-4">
                    <div className="space-y-1">
                      {j.legs.map((leg: any, idx: number) => {
                        const isCredit = BigInt(leg.amount) > 0n;
                        return (
                          <div key={idx} className="flex justify-between text-xs font-mono">
                            <span className="truncate max-w-[200px]" title={leg.account_id}>
                              {leg.account_id}
                            </span>
                            <span className={isCredit ? "text-[#00FF41]" : "text-destructive"}>
                              {isCredit ? "+" : ""}{leg.amount}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </CardContent>
                </Card>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
