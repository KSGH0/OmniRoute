"use client";

import { useEffect, useState } from "react";
import Card from "@/shared/components/Card";

type Settings = {
  showPricingBadges?: boolean;
  rankedAutobalanceEnabled?: boolean;
};

export default function RankedPricingAiSettingsTab() {
  const [settings, setSettings] = useState<Settings>({
    showPricingBadges: true,
    rankedAutobalanceEnabled: false,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data) => {
        setSettings({
          showPricingBadges: data.showPricingBadges !== false,
          rankedAutobalanceEnabled: data.rankedAutobalanceEnabled === true,
        });
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const update = async (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    setSaving(patch.showPricingBadges !== undefined ? "pricing" : "ranked");
    try {
      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
    } finally {
      setTimeout(() => setSaving(null), 800);
    }
  };

  return (
    <Card>
      <div className="flex items-center gap-3 mb-5">
        <div className="p-2 rounded-lg bg-amber-500/10 text-amber-500">
          <span className="material-symbols-outlined text-[20px]">price_change</span>
        </div>
        <div>
          <h3 className="text-lg font-semibold">Ranked Autobalance & Pricing</h3>
          <p className="text-sm text-text-muted">
            Speed-ranked provider balancing and model pricing badges — both live under Configuration
            / AI Settings.
          </p>
        </div>
      </div>

      <div className="space-y-4">
        <label className="flex items-center justify-between gap-4 p-3 rounded-lg border border-border/50 bg-surface/20">
          <div>
            <p className="text-sm font-medium">Show pricing badges</p>
            <p className="text-xs text-text-muted">
              In model picker, show Free • $0.00 vs $in/$out per provider/model. API still lists all
              pricing.
            </p>
          </div>
          <input
            type="checkbox"
            checked={settings.showPricingBadges !== false}
            onChange={(e) => update({ showPricingBadges: e.target.checked })}
            disabled={loading}
            className="h-5 w-9 rounded-full appearance-none bg-border checked:bg-primary relative before:absolute before:h-4 before:w-4 before:bg-white before:rounded-full before:top-0.5 before:left-0.5 checked:before:translate-x-4 transition-all"
            aria-label="Show pricing badges"
          />
        </label>
        {saving === "pricing" && <p className="text-xs text-emerald-500">Saved</p>}

        <label className="flex items-center justify-between gap-4 p-3 rounded-lg border border-border/50 bg-surface/20">
          <div>
            <p className="text-sm font-medium">Enable ranked autobalance (global)</p>
            <p className="text-xs text-text-muted">
              Global kill-switch for speed-ranked balancing (p95 + error*1000, 15m rerank).
              Per-combo toggle in Combos → Control Center still required.
            </p>
          </div>
          <input
            type="checkbox"
            checked={settings.rankedAutobalanceEnabled === true}
            onChange={(e) => update({ rankedAutobalanceEnabled: e.target.checked })}
            disabled={loading}
            className="h-5 w-9 rounded-full appearance-none bg-border checked:bg-primary relative before:absolute before:h-4 before:w-4 before:bg-white before:rounded-full before:top-0.5 before:left-0.5 checked:before:translate-x-4 transition-all"
            aria-label="Enable ranked autobalance"
          />
        </label>
        {saving === "ranked" && <p className="text-xs text-emerald-500">Saved</p>}
        <p className="text-xs text-text-muted">
          Per-combo toggle: Dashboard → Combos → Control Center → Auto-rank by speed. Global OFF
          disables scheduler even if per-combo is ON.
        </p>
      </div>
    </Card>
  );
}
