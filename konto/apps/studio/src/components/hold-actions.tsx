"use client";

import { useTransition } from "react";
import { commitHoldAction, rollbackHoldAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";

interface HoldActionsProps {
  holdId: string;
  senderName: string;
  recipientName: string;
  amount: string;
}

export function HoldActions({ holdId, senderName, recipientName, amount }: HoldActionsProps) {
  const [isPending, startTransition] = useTransition();

  const handleCommit = () => {
    startTransition(async () => {
      const result = await commitHoldAction(holdId);
      if (result.success) {
        toast.success("Hold committed — funds settled permanently.");
      } else {
        toast.error(result.error ?? "Failed to commit hold");
      }
    });
  };

  const handleRollback = () => {
    startTransition(async () => {
      const result = await rollbackHoldAction(holdId);
      if (result.success) {
        toast.info("Hold rolled back — funds released.");
      } else {
        toast.error(result.error ?? "Failed to rollback hold");
      }
    });
  };

  return (
    <div className="flex items-center gap-2">
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="default" size="sm" disabled={isPending}>
            Commit
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Settle Hold?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently move <span className="font-mono font-bold">{amount}</span> from{" "}
              <span className="font-mono">{senderName}</span> to{" "}
              <span className="font-mono">{recipientName}</span>.
              <br /><br />
              A journal entry will be created. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleCommit} className="bg-primary text-primary-foreground hover:bg-primary/90">
              Confirm Settlement
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="destructive" size="sm" disabled={isPending}>
            Rollback
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Release Hold?</AlertDialogTitle>
            <AlertDialogDescription>
              This will release the earmarked <span className="font-mono font-bold">{amount}</span> back to{" "}
              <span className="font-mono">{senderName}</span>.
              <br /><br />
              No journal entry will be created. The hold row remains as a terminal audit record.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleRollback} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Confirm Rollback
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
