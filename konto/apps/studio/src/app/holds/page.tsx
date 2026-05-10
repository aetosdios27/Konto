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
import { HoldCountdown } from "@/components/ui/hold-countdown";
import { HoldActions } from "@/components/hold-actions";
import { CreateHoldForm } from "@/components/forms/create-hold-form";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

export default async function HoldsPage() {
  // Fetch all holds with account names
  const holds = await sql<
    {
      id: string;
      account_id: string;
      account_name: string;
      recipient_id: string;
      recipient_name: string;
      amount: string;
      status: string;
      created_at: Date;
      expires_at: Date | null;
    }[]
  >`
    SELECT 
      h.id, 
      h.account_id, 
      a.name as account_name,
      h.recipient_id,
      r.name as recipient_name,
      h.amount::text as amount, 
      h.status, 
      h.created_at, 
      h.expires_at
    FROM konto_holds h
    JOIN konto_accounts a ON h.account_id = a.id
    JOIN konto_accounts r ON h.recipient_id = r.id
    ORDER BY 
      CASE h.status WHEN 'PENDING' THEN 0 ELSE 1 END,
      h.created_at DESC
    LIMIT 100
  `;

  // Fetch accounts for the "Create Hold" form
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

  const pendingCount = holds.filter((h) => h.status === "PENDING").length;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Escrow Holds</h1>
          <p className="text-sm text-muted-foreground">
            {pendingCount > 0
              ? `${pendingCount} active hold${pendingCount !== 1 ? "s" : ""} earmarking funds.`
              : "No active holds. All funds are liquid."}
          </p>
        </div>

        <Dialog>
          <DialogTrigger asChild>
            <Button>New Hold</Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[480px]">
            <DialogHeader>
              <DialogTitle>Create Escrow Hold</DialogTitle>
              <DialogDescription>
                Earmark funds from a sender account. Funds are reserved but not moved until the hold is committed.
              </DialogDescription>
            </DialogHeader>
            <CreateHoldForm accounts={accounts} />
          </DialogContent>
        </Dialog>
      </div>

      <div className="border rounded-md">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[120px]">Hold ID</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Sender</TableHead>
              <TableHead>Recipient</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead className="text-right">Expires In</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {holds.map((hold) => {
              let statusColor = "bg-muted text-muted-foreground";
              if (hold.status === "PENDING") statusColor = "bg-yellow-500 text-black border-yellow-600";
              if (hold.status === "COMMITTED") statusColor = "bg-green-900 text-green-100 border-green-700";
              if (hold.status === "ROLLED_BACK") statusColor = "bg-red-900 text-red-100 border-red-700";

              return (
                <TableRow key={hold.id}>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {hold.id.split("-")[0]}...
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className={`font-mono text-xs ${statusColor}`}>
                      {hold.status}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col">
                      <span className="font-medium">{hold.account_name}</span>
                      <span className="text-xs font-mono text-muted-foreground">{hold.account_id.split("-")[0]}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col">
                      <span className="font-medium">{hold.recipient_name}</span>
                      <span className="text-xs font-mono text-muted-foreground">{hold.recipient_id.split("-")[0]}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-right font-mono text-destructive">
                    {hold.amount}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground text-sm">
                    {hold.status === "PENDING" ? (
                      <HoldCountdown expiresAt={hold.expires_at ? hold.expires_at.toISOString() : null} />
                    ) : (
                      <span className="text-muted-foreground">-</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {hold.status === "PENDING" ? (
                      <HoldActions
                        holdId={hold.id}
                        senderName={hold.account_name}
                        recipientName={hold.recipient_name}
                        amount={hold.amount}
                      />
                    ) : (
                      <span className="text-xs text-muted-foreground">-</span>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
            {holds.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                  No escrow holds found. Use &quot;New Hold&quot; to earmark funds.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
