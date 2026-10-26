"use client";

import { useState, useEffect } from "react";

export function HoldCountdown({ expiresAt }: { expiresAt: string | null }) {
  const [remaining, setRemaining] = useState("");
  const [isUrgent, setIsUrgent] = useState(false);
  const [isExpired, setIsExpired] = useState(false);
  
  useEffect(() => {
    if (!expiresAt) {
      return;
    }
    
    const update = () => {
      const diff = new Date(expiresAt).getTime() - Date.now();
      if (diff <= 0) {
        setRemaining("Expired");
        setIsExpired(true);
        setIsUrgent(false);
        return;
      }
      
      setIsExpired(false);
      setIsUrgent(diff < 300000); // under 5 min

      const hours = Math.floor(diff / 3600000);
      const mins  = Math.floor((diff % 3600000) / 60000);
      const secs  = Math.floor((diff % 60000) / 1000);
      
      if (hours > 0) setRemaining(`${hours}h ${mins}m`);
      else if (mins > 0) setRemaining(`${mins}m ${secs}s`);
      else setRemaining(`${secs}s`);
    };

    const initial = setTimeout(update, 0);
    const id = setInterval(update, 1000);
    return () => {
      clearTimeout(initial);
      clearInterval(id);
    };
  }, [expiresAt]);

  if (!expiresAt) return <span className="text-zinc-400 font-mono">No expiry</span>;

  if (isExpired) {
    return <span className="text-muted-foreground font-mono">Expired</span>;
  }

  return (
    <span className={isUrgent ? "text-red-400 font-mono" : "text-zinc-400 font-mono"}>
      {remaining}
    </span>
  );
}
