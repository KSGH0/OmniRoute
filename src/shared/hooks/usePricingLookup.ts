"use client";

/**
 * usePricingLookup — shared pricing-badge data for model pickers/rows.
 * Fetches once per page load (module-level cache): /api/pricing → /api/pricing/models → /v1/models.
 * Lookup mirrors server getPricingForModel: case-insensitive, alias-tolerant,
 * dot→hyphen, and vendor-prefix stripping ("meta/llama-3.1-8b" → "llama-3.1-8b").
 */

import { useCallback, useEffect, useState } from "react";

export type PricingEntry = { input?: number; output?: number; cached?: number };
export type PricingMap = Record<string, Record<string, PricingEntry>>;

const norm = (s: string) => s.toLowerCase().trim();

let cachedPromise: Promise<PricingMap> | null = null;

async function extractFromCatalog(json: unknown): Promise<PricingMap | null> {
  // /api/pricing/models shape: { provider: { models: [{ id, pricing }] } }
  if (json && typeof json === "object" && !Array.isArray(json)) {
    const fb: PricingMap = {};
    let any = false;
    for (const [prov, info] of Object.entries(json as Record<string, unknown>)) {
      const models = (info as { models?: unknown })?.models;
      if (!Array.isArray(models)) continue;
      for (const m of models as Array<{ id?: string; pricing?: PricingEntry }>) {
        if (!m.id || !m.pricing) continue;
        if (m.pricing.input == null && m.pricing.output == null) continue;
        if (!fb[prov]) fb[prov] = {};
        fb[prov][m.id] = {
          input: m.pricing.input,
          output: m.pricing.output,
          cached: (m.pricing as { cached?: number }).cached,
        };
        any = true;
      }
    }
    if (any) return fb;
  }
  return null;
}

async function extractFromV1Models(json: unknown): Promise<PricingMap | null> {
  const list = (
    json as { data?: Array<{ id?: string; pricing?: PricingEntry; owned_by?: string }> }
  )?.data;
  if (!Array.isArray(list)) return null;
  const fb: PricingMap = {};
  for (const m of list) {
    if (!m.id || !m.pricing) continue;
    if (m.pricing.input == null && m.pricing.output == null) continue;
    const [prov, ...rest] = m.id.split("/");
    const mid = rest.length ? rest.join("/") : m.id;
    const p = prov || m.owned_by || "unknown";
    if (!fb[p]) fb[p] = {};
    fb[p][mid] = {
      input: m.pricing.input,
      output: m.pricing.output,
      cached: (m.pricing as { cached?: number }).cached,
    };
  }
  return Object.keys(fb).length > 0 ? fb : null;
}

function loadPricingMap(): Promise<PricingMap> {
  if (!cachedPromise) {
    cachedPromise = (async () => {
      const urls = ["/api/pricing", "/api/pricing/models", "/v1/models"];
      for (const u of urls) {
        try {
          const res = await fetch(u);
          if (!res.ok) continue;
          const json = await res.json();
          const extracted =
            u === "/v1/models" ? await extractFromV1Models(json) : await extractFromCatalog(json);
          // /api/pricing returns the merged map directly ({provider:{model:{input,output}}})
          if (extracted) return extracted;
          if (
            u === "/api/pricing" &&
            json &&
            typeof json === "object" &&
            !Array.isArray(json) &&
            Object.keys(json as object).length > 0
          ) {
            return json as PricingMap;
          }
        } catch {
          /* try next */
        }
      }
      return {};
    })();
  }
  return cachedPromise;
}

export function findPricingInMap(
  map: PricingMap,
  providerId: string,
  modelId: string
): PricingEntry | null {
  if (!map || !providerId || !modelId) return null;
  const pLower = norm(providerId);
  let prov: Record<string, PricingEntry> | undefined;
  for (const [k, v] of Object.entries(map)) {
    if (norm(k) === pLower) {
      prov = v as Record<string, PricingEntry>;
      break;
    }
  }
  if (!prov) return null;

  const base = norm(modelId);
  const hyphen = base.replace(/\./g, "-");
  const lastSeg = base.includes("/") ? base.split("/").pop() || base : base;
  const lastHyphen = lastSeg.replace(/\./g, "-");
  const candidates = [base, hyphen, lastSeg, lastHyphen];
  for (const c of candidates) {
    for (const [k, v] of Object.entries(prov)) {
      if (norm(k) === c) return v as PricingEntry;
    }
  }
  return null;
}

export function usePricingLookup() {
  const [map, setMap] = useState<PricingMap>({});

  useEffect(() => {
    let mounted = true;
    loadPricingMap().then((d) => {
      if (mounted) setMap(d);
    });
    return () => {
      mounted = false;
    };
  }, []);

  const findPricing = useCallback(
    (providerId: string, modelId: string): PricingEntry | null =>
      findPricingInMap(map, providerId, modelId),
    [map]
  );

  return { findPricing };
}
