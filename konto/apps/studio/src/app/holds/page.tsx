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

export const dynamic = "force-dynamic";

export default async function HoldsPage() {
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
    WHERE h.status = 'PENDING'
       OR h.status = 'EXECUTED'
       OR h.status = 'ROLLED_BACK'
    ORDER BY h.created_at DESC
    LIMIT 100
  `;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Escrow Holds</h1>
          <p className="text-sm text-muted-foreground">Pending and recent escrow locks.</p>
        </div>
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
              <TableHead className="text-right">Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {holds.map((hold) => {
              let statusColor = "bg-muted text-muted-foreground";
              if (hold.status === "PENDING") statusColor = "bg-yellow-500 text-black border-yellow-600";
              if (hold.status === "EXECUTED") statusColor = "bg-green-900 text-green-100 border-green-700";
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
                    {hold.created_at.toISOString().split("T")[0]}
                  </TableCell>
                </TableRow>
              );
            })}
            {holds.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                  No escrow holds found.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
