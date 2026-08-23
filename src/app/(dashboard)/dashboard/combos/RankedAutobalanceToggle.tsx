"use client";

import { useState } from "react";

/**
 * Ranked autobalance toggle — speed-only (p95 + error*1000).
 * F1: single toggle per combo. When ON, scheduler reorders combo_targets by speed.
 * Additive only — never hides providers/models from /v1/models.
 */
export default function RankedAutobalanceToggle({
  comboId,
  comboName,
  config,
  onUpdate,
}: {
  comboId: string;
  comboName: string;
  config: Record<string, unknown> | null | undefined;
  onUpdate: (nextConfig: Record<string, unknown>) => void;
}) {
  const ra = (
    config as {
      rankedAutobalance?: { autoRank?: boolean; sourceModelId?: string; intervalMs?: number };
    } | null
  )?.rankedAutobalance;
  const enabled = ra?.autoRank === true;
  const [busy, setBusy] = useState(false);

  const toggle = () => {
    const next: Record<string, unknown> = { ...(config ?? {}) };
    const cur = (next.rankedAutobalance as Record<string, unknown> | undefined) ?? {};
    next.rankedAutobalance = {
      ...cur,
      autoRank: !enabled,
      sourceModelId: (cur.sourceModelId as string) ?? comboName,
      intervalMs: (cur.intervalMs as number) ?? 15 * 60 * 1000,
    };
    onUpdate(next);
  };

  const rerankNow = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/combos/${comboId}/rank`, { method: "POST" });
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      // ignore — UI will refresh on next fetch
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-black/[0.02] dark:bg-white/[0.02] p-3 space-y-2">
      <label className="flex items-center justify-between gap-3 cursor-pointer">
        <span className="text-sm font-medium">Auto-rank by speed</span>
        <input
          type="checkbox"
          checked={enabled}
          onChange={toggle}
          className="h-4 w-8 rounded-full appearance-none bg-border checked:bg-primary relative before:absolute before:h-3 before:w-3 before:bg-white before:rounded-full before:top-0.5 before:left-0.5 checked:before:translate-x-4 transition-all"
          aria-label="Auto-rank by speed"
        />
      </label>
      <p className="text-xs text-text-muted leading-snug">
        Rank providers for this model by speed (p95 + error penalty) and rerank automatically every
        15m + on failure. Free vs Paid pools stay separate — create two ranked combos if you use
        both.
      </p>
      {enabled && (
        <button
          type="button"
          onClick={rerankNow}
          disabled={busy}
          className="text-xs px-2 py-1 rounded border border-border bg-surface hover:bg-primary/5 disabled:opacity-50"
        >
          {busy ? "Ranking…" : "Re-rank now"}
        </button>
      )}
    </div>
  );
}
