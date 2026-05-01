import { sql } from "@/lib/db";
import { IntentActions } from "@/components/intent-actions";
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

export default async function IntentsPage() {
  // First, auto-expire stale intents (same as core getPendingIntents does)
  await sql`
    UPDATE konto_staged_intents
    SET status = 'EXPIRED'
    WHERE status = 'PENDING'
      AND expires_at IS NOT NULL
      AND NOW() > expires_at
  `;

  // Fetch pending intents
  const pending = await sql<
    {
      id: string;
      intent_type: string;
      payload: any;
      created_at: Date;
      expires_at: Date | null;
    }[]
  >`
    SELECT id, intent_type, payload, created_at, expires_at
    FROM konto_staged_intents
    WHERE status = 'PENDING'
    ORDER BY created_at ASC
  `;

  // Fetch recently resolved intents (last 20)
  const resolved = await sql<
    {
      id: string;
      intent_type: string;
      status: string;
      payload: any;
      created_at: Date;
      executed_at: Date | null;
    }[]
  >`
    SELECT id, intent_type, status, payload, created_at, executed_at
    FROM konto_staged_intents
    WHERE status != 'PENDING'
    ORDER BY COALESCE(executed_at, created_at) DESC
    LIMIT 20
  `;

  return (
    <div className="flex flex-col gap-10">
      <div>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Pending Intents</h1>
            <p className="text-sm text-muted-foreground">Agent-staged mutations awaiting human approval.</p>
          </div>
          <Badge variant="outline" className="font-mono">{pending.length} Pending</Badge>
        </div>

        <div className="border rounded-md border-primary/20">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[120px]">ID</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Payload Summary</TableHead>
                <TableHead>Expiration</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pending.map((intent) => {
                let summary = "{}";
                try {
                  summary = JSON.stringify(intent.payload);
                  if (summary.length > 80) summary = summary.substring(0, 80) + "...";
                } catch (e) {}

                let hoursLeft = null;
                if (intent.expires_at) {
                  const ms = intent.expires_at.getTime() - Date.now();
                  hoursLeft = Math.max(0, Math.round(ms / (1000 * 60 * 60) * 10) / 10);
                }

                return (
                  <TableRow key={intent.id}>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {intent.id.split("-")[0]}...
                    </TableCell>
                    <TableCell>
                      <Badge variant="default" className="font-mono text-xs bg-primary text-primary-foreground">
                        {intent.intent_type}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground max-w-[300px] truncate">
                      {summary}
                    </TableCell>
                    <TableCell className="text-sm">
                      {hoursLeft !== null ? (
                        <span className={hoursLeft < 1 ? "text-destructive font-bold" : "text-yellow-500"}>
                          {hoursLeft}h left
                        </span>
                      ) : (
                        <span className="text-muted-foreground">Never</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <IntentActions intentId={intent.id} />
                    </TableCell>
                  </TableRow>
                );
              })}
              {pending.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="h-32 text-center text-muted-foreground">
                    No pending intents. Agents are idle.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      <div>
        <div className="mb-4">
          <h2 className="text-xl font-semibold tracking-tight">Resolved Intents</h2>
          <p className="text-sm text-muted-foreground">Recently executed, rejected, or expired intents.</p>
        </div>

        <div className="border rounded-md opacity-80">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[120px]">ID</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Payload Summary</TableHead>
                <TableHead className="text-right">Resolved At</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {resolved.map((intent) => {
                let summary = "{}";
                try {
                  summary = JSON.stringify(intent.payload);
                  if (summary.length > 80) summary = summary.substring(0, 80) + "...";
                } catch (e) {}

                let statusColor = "bg-muted text-muted-foreground";
                if (intent.status === "EXECUTED") statusColor = "bg-green-900 text-green-100 border-green-700";
                if (intent.status === "REJECTED") statusColor = "bg-red-900 text-red-100 border-red-700";
                if (intent.status === "EXPIRED") statusColor = "bg-yellow-900 text-yellow-100 border-yellow-700";

                return (
                  <TableRow key={intent.id}>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {intent.id.split("-")[0]}...
                    </TableCell>
                    <TableCell>
                      <span className="font-mono text-xs">{intent.intent_type}</span>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={`font-mono text-xs ${statusColor}`}>
                        {intent.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground max-w-[300px] truncate">
                      {summary}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground text-sm">
                      {(intent.executed_at || intent.created_at).toISOString().replace("T", " ").split(".")[0]}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}
