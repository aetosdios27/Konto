"use client";

import { useTransition } from "react";
import { approveIntent, rejectStagedIntent } from "@/app/actions";
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
import { toast } from "sonner"; // Assuming sonner is installed as per package.json

interface IntentActionsProps {
  intentId: string;
}

export function IntentActions({ intentId }: IntentActionsProps) {
  const [isPending, startTransition] = useTransition();

  const handleApprove = () => {
    startTransition(async () => {
      const result = await approveIntent(intentId);
      if (result.success) {
        toast.success("Intent executed successfully");
      } else {
        toast.error(result.error ?? "Failed to execute intent");
      }
    });
  };

  const handleReject = () => {
    startTransition(async () => {
      const result = await rejectStagedIntent(intentId);
      if (result.success) {
        toast.info("Intent rejected");
      } else {
        toast.error(result.error ?? "Failed to reject intent");
      }
    });
  };

  return (
    <div className="flex items-center gap-2">
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="default" size="sm" disabled={isPending}>
            Approve
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Execute Intent?</AlertDialogTitle>
            <AlertDialogDescription>
              This will execute the staged mutation and apply the financial changes to the ledger immediately. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleApprove} className="bg-primary text-primary-foreground hover:bg-primary/90">
              Confirm Execution
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Button
        variant="destructive"
        size="sm"
        disabled={isPending}
        onClick={handleReject}
      >
        Reject
      </Button>
    </div>
  );
}
