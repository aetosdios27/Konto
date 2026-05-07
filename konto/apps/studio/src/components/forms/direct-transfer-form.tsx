"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { toast } from "sonner";
import { useRouter } from "next/navigation";

import { executeDirectTransferAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface AccountOption {
  id: string;
  name: string;
  currency: string;
  availableBalance: string;
}

export function DirectTransferForm({ accounts }: { accounts: AccountOption[] }) {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

  // Dynamic schema that validates cross-currency
  const formSchema = z
    .object({
      senderId: z.string().uuid("Sender is required"),
      receiverId: z.string().uuid("Receiver is required"),
      amount: z.string().regex(/^\d+$/, "Amount must be a positive integer (minor units)"),
    })
    .refine(
      (data) => {
        const sender = accounts.find((a) => a.id === data.senderId);
        const receiver = accounts.find((a) => a.id === data.receiverId);
        if (!sender || !receiver) return true; // skip if not selected yet
        return sender.currency === receiver.currency;
      },
      {
        message: "Sender and Receiver must have the same currency",
        path: ["receiverId"],
      }
    )
    .refine((data) => data.senderId !== data.receiverId, {
      message: "Sender and Receiver cannot be the same account",
      path: ["receiverId"],
    });

  type FormValues = z.infer<typeof formSchema>;

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema as any),
    defaultValues: {
      senderId: "",
      receiverId: "",
      amount: "",
    },
  });

  async function onSubmit(data: FormValues) {
    setIsSubmitting(true);
    try {
      const entries = [
        { accountId: data.senderId, amount: "-" + data.amount }, // Debit sender
        { accountId: data.receiverId, amount: data.amount },     // Credit receiver
      ];

      const res = await executeDirectTransferAction(entries, idempotencyKey);

      if (res.success) {
        toast.success("Transfer executed successfully.");
        form.reset();
        setIdempotencyKey(crypto.randomUUID()); // Reset key for next transfer ONLY on success
        router.refresh();
      } else {
        toast.error("Transfer failed", { description: res.error });
      }
    } catch (err: any) {
      toast.error("An unexpected error occurred", { description: err.message });
    } finally {
      setIsSubmitting(false);
    }
  }

  // Filter out the sender from the receiver options to improve UX
  const senderId = form.watch("senderId");
  const senderCurrency = accounts.find((a) => a.id === senderId)?.currency;

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 border p-4 bg-background">
        <h3 className="font-semibold text-lg border-b pb-2">Execute Transfer</h3>
        
        <FormField
          control={form.control}
          name="senderId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Sender Account (Debit)</FormLabel>
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
              <FormLabel>Receiver Account (Credit)</FormLabel>
              <Select onValueChange={field.onChange} value={field.value}>
                <FormControl>
                  <SelectTrigger className="font-mono">
                    <SelectValue placeholder="Select receiver account" />
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
              <FormLabel>Amount (Raw Minor Units)</FormLabel>
              <FormControl>
                <Input placeholder="e.g. 5000 for $50.00" {...field} className="font-mono" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <Button type="submit" className="w-full" disabled={isSubmitting}>
          {isSubmitting ? "Executing..." : "Execute Transfer"}
        </Button>
      </form>
    </Form>
  );
}
