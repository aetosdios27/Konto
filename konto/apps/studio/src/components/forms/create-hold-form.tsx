"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { toast } from "sonner";
import { useRouter } from "next/navigation";

import { initializeHoldAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  FormDescription,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { AccountOption } from "@/components/forms/direct-transfer-form";

const formSchema = z
  .object({
    senderId: z.string().uuid("Sender is required"),
    receiverId: z.string().uuid("Recipient is required"),
    amount: z.string().regex(/^\d+$/, "Amount must be a positive integer (minor units)"),
    ttlMinutes: z.string().regex(/^\d*$/, "Must be a number").optional(),
  });

type FormValues = z.infer<typeof formSchema>;

export function CreateHoldForm({ accounts }: { accounts: AccountOption[] }) {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema as any),
    defaultValues: {
      senderId: "",
      receiverId: "",
      amount: "",
      ttlMinutes: "60",
    },
  });

  async function onSubmit(data: FormValues) {
    // Cross-currency check
    const sender = accounts.find((a) => a.id === data.senderId);
    const receiver = accounts.find((a) => a.id === data.receiverId);
    if (sender && receiver && sender.currency !== receiver.currency) {
      toast.error("Cross-currency holds are not supported.");
      return;
    }
    if (data.senderId === data.receiverId) {
      toast.error("Sender and recipient cannot be the same account.");
      return;
    }

    setIsSubmitting(true);
    try {
      const ttlMs = data.ttlMinutes && parseInt(data.ttlMinutes) > 0
        ? parseInt(data.ttlMinutes) * 60 * 1000
        : undefined;
      const expiresAt = ttlMs ? new Date(Date.now() + ttlMs) : undefined;

      const res = await initializeHoldAction(
        data.senderId,
        data.receiverId,
        data.amount,
        idempotencyKey,
        expiresAt,
      );

      if (res.success) {
        toast.success("Hold created successfully.");
        form.reset();
        setIdempotencyKey(crypto.randomUUID());
        router.refresh();
      } else {
        toast.error("Hold creation failed", { description: res.error });
      }
    } catch (err: any) {
      toast.error("An unexpected error occurred", { description: err.message });
    } finally {
      setIsSubmitting(false);
    }
  }

  const senderId = form.watch("senderId");
  const senderCurrency = accounts.find((a) => a.id === senderId)?.currency;

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 border p-4 bg-background">
        <h3 className="font-semibold text-lg border-b pb-2">Create Escrow Hold</h3>

        <FormField
          control={form.control}
          name="senderId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Sender (Funds Held From)</FormLabel>
              <Select onValueChange={field.onChange} value={field.value}>
                <FormControl>
                  <SelectTrigger className="font-mono">
                    <SelectValue placeholder="Select sender account" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {accounts.map((acc) => {
                    const isGenesis = acc.name.startsWith("__konto_genesis_");
                    return (
                      <SelectItem key={acc.id} value={acc.id} className={`font-mono ${isGenesis ? "opacity-60 text-muted-foreground" : ""}`}>
                        {isGenesis ? "SYSTEM_GENESIS" : acc.name} ({acc.currency}) • Bal: {acc.availableBalance}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="receiverId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Recipient (Funds Settle To)</FormLabel>
              <Select onValueChange={field.onChange} value={field.value}>
                <FormControl>
                  <SelectTrigger className="font-mono">
                    <SelectValue placeholder="Select recipient account" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {accounts
                    .filter((acc) => acc.id !== senderId && (!senderCurrency || acc.currency === senderCurrency))
                    .map((acc) => {
                      const isGenesis = acc.name.startsWith("__konto_genesis_");
                      return (
                        <SelectItem key={acc.id} value={acc.id} className={`font-mono ${isGenesis ? "opacity-60 text-muted-foreground" : ""}`}>
                          {isGenesis ? "SYSTEM_GENESIS" : acc.name} ({acc.currency}) • Bal: {acc.availableBalance}
                        </SelectItem>
                      );
                    })}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="amount"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Hold Amount (Raw Minor Units)</FormLabel>
              <FormControl>
                <Input placeholder="e.g. 5000 for $50.00" {...field} className="font-mono" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="ttlMinutes"
          render={({ field }) => (
            <FormItem>
              <FormLabel>TTL (Minutes)</FormLabel>
              <FormControl>
                <Input placeholder="60" {...field} className="font-mono" />
              </FormControl>
              <FormDescription>
                Leave empty for no expiration. Max: 43200 (30 days).
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <Button type="submit" className="w-full" disabled={isSubmitting}>
          {isSubmitting ? "Creating..." : "Create Hold"}
        </Button>
      </form>
    </Form>
  );
}
