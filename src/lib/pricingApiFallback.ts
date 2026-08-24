/**
 * pricingApiFallback.ts — API-first pricing, fallback to models.dev
 * Called on autosync and retest so pricing stays fresh without extra UI.
 * Tries GET <provider>/models with stored API key, extracts pricing if present.
 */

import { getDbInstance } from "./db/core";

function toNum(v: unknown): number | undefined {
  if (v == null) return undefined;
  const n = typeof v === "string" ? parseFloat(v) : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function normalizeApiPricing(raw: unknown): { input?: number; output?: number } | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const p = (r.pricing ?? r.cost ?? r.price ?? r) as Record<string, unknown>;
  const prompt =
    p?.prompt ??
    p?.input ??
    (p as Record<string, unknown>)?.input_cost ??
    (p as Record<string, unknown>)?.prompt_cost;
  const completion =
    p?.completion ??
    p?.output ??
    (p as Record<string, unknown>)?.output_cost ??
    (p as Record<string, unknown>)?.completion_cost;
  if (prompt == null && completion == null) return null;
  const input = toNum(prompt);
  const output = toNum(completion);
  if (input == null && output == null) return null;
  return { input: input ?? 0, output: output ?? 0 };
}

// Base URL map for providers known to expose pricing via /models (fallback checked for all providers otherwise)
const API_BASES: Record<string, string> = {
  openrouter: "https://openrouter.ai/api/v1",
};

export async function fetchApiPricingForProvider(
  providerId: string,
  apiKey: string
): Promise<Record<string, { input: number; output: number }> | null> {
  // Check on all providers first: try known base, then registry, then stored custom baseUrl — if none, fallback to models.dev in caller
  let base = API_BASES[providerId.toLowerCase()];
  if (!base) {
    try {
      const { getRegistryEntry } = await import("@omniroute/open-sse/config/providerRegistry");
      const entry = getRegistryEntry(providerId) as
        { baseUrl?: string; baseUrls?: string[] } | null | undefined;
      if (entry?.baseUrl) base = String(entry.baseUrl).replace(/\/+$/, "");
      else if (Array.isArray(entry?.baseUrls) && entry.baseUrls[0])
        base = String(entry.baseUrls[0]).replace(/\/+$/, "");
    } catch {}
  }
  // For custom OpenAI-compat providers, try stored baseUrl from connection
  if (!base) {
    try {
      const db = getDbInstance();
      const row = db
        .prepare(
          "SELECT provider_specific_data FROM provider_connections WHERE provider=? AND api_key IS NOT NULL LIMIT 1"
        )
        .get(providerId) as { provider_specific_data: string | null } | undefined;
      if (row?.provider_specific_data) {
        const psd = JSON.parse(row.provider_specific_data) as Record<string, unknown>;
        const b = (psd.baseUrl as string) || (psd.base_url as string);
        if (typeof b === "string" && b.startsWith("http")) base = b.replace(/\/+$/, "");
      }
    } catch {}
  }
  if (!base || !apiKey) return null;
  try {
    const res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const list: unknown[] = Array.isArray((data as { data?: unknown })?.data)
      ? (data as { data: unknown[] }).data
      : Array.isArray(data)
        ? (data as unknown[])
        : [];
    const out: Record<string, { input: number; output: number }> = {};
    for (const m of list) {
      const r = m as Record<string, unknown>;
      const id = String(r.id ?? r.slug ?? r.name ?? "").trim();
      if (!id) continue;
      const pr = normalizeApiPricing(r);
      if (!pr || (pr.input == null && pr.output == null)) continue;
      out[id] = { input: pr.input ?? 0, output: pr.output ?? 0 };
    }
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return null;
  }
}

export async function syncPricingForProvider(providerId: string): Promise<number> {
  const db = getDbInstance();
  const row = db
    .prepare(
      "SELECT api_key FROM provider_connections WHERE provider=? AND api_key IS NOT NULL LIMIT 1"
    )
    .get(providerId) as { api_key: string } | undefined;
  if (!row?.api_key) return 0;
  // api_key is encrypted at rest (enc:v1:...) — decrypt before using as bearer
  let apiKey = String(row.api_key);
  if (apiKey.startsWith("enc:v1:")) {
    try {
      const { decryptConnectionFields } = await import("./db/encryption");
      const dec = decryptConnectionFields({ apiKey });
      apiKey = String(dec?.apiKey || "");
    } catch {
      return 0;
    }
  }
  if (!apiKey) return 0;
  const apiPricing = await fetchApiPricingForProvider(providerId, apiKey);
  if (!apiPricing) return 0;
  const insert = db.prepare(
    "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('pricing_api_discovered', ?, ?)"
  );
  const existing = db
    .prepare("SELECT value FROM key_value WHERE namespace='pricing_api_discovered' AND key=?")
    .get(providerId) as { value: string } | undefined;
  const prev = existing ? (JSON.parse(existing.value) as Record<string, unknown>) : {};
  const next = { ...prev, ...apiPricing };
  insert.run(providerId, JSON.stringify(next));
  return Object.keys(apiPricing).length;
}
