#!/usr/bin/env node
/**
 * check-pricing-fallback.mjs — API-first pricing, fallback to models.dev
 *
 * 1. For each provider connection with an API key, try GET <provider>/models
 *    (OpenRouter-style: data[].pricing {prompt, completion})
 * 2. If pricing present → use it (input=prompt, output=completion)
 * 3. Else → fallback to merged pricing via getPricing() (defaults < litellm < models.dev < user)
 *
 * Usage:
 *   node --import tsx/esm scripts/ad-hoc/check-pricing-fallback.mjs [provider/model]
 *   e.g. node --import tsx/esm scripts/ad-hoc/check-pricing-fallback.mjs openrouter/anthropic/claude-3.5-sonnet
 *   or just: node --import tsx/esm scripts/ad-hoc/check-pricing-fallback.mjs   (checks all discovered models)
 */

import { getDbInstance } from "../../src/lib/db/core.ts";
import { getPricingForModel } from "../../src/lib/db/settings/pricing.ts";

function normalizeApiPricing(raw) {
  if (!raw || typeof raw !== "object") return null;
  // OpenRouter shape: { pricing: { prompt, completion, request, image } } or { cost: { input, output } }
  const p = raw.pricing ?? raw.cost ?? raw.price ?? raw;
  const prompt = p?.prompt ?? p?.input ?? p?.input_cost ?? p?.prompt_cost;
  const completion = p?.completion ?? p?.output ?? p?.output_cost ?? p?.completion_cost;
  if (prompt == null && completion == null) return null;
  const toNum = (v) => {
    if (v == null) return undefined;
    const n = typeof v === "string" ? parseFloat(v) : Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const input = toNum(prompt);
  const output = toNum(completion);
  if (input == null && output == null) return null;
  return { input: input ?? 0, output: output ?? 0, source: "api" };
}

async function tryApiPricing(providerId, apiKey, modelId) {
  // Check on all providers first: try known base, then registry, then stored custom baseUrl — fallback to models.dev if none
  let base = null;
  const bases = {
    openrouter: "https://openrouter.ai/api/v1",
  };
  base = bases[providerId.toLowerCase()] || null;
  if (!base) {
    try {
      const { getRegistryEntry } = await import("../../open-sse/config/providerRegistry.ts");
      const entry = getRegistryEntry(providerId);
      if (entry?.baseUrl) base = String(entry.baseUrl).replace(/\/+$/, "");
      else if (Array.isArray(entry?.baseUrls) && entry.baseUrls[0])
        base = String(entry.baseUrls[0]).replace(/\/+$/, "");
    } catch {}
  }
  if (!base) {
    try {
      const { getDbInstance } = await import("../../src/lib/db/core.ts");
      const db = getDbInstance();
      const row = db
        .prepare("SELECT provider_specific_data FROM provider_connections WHERE provider=? LIMIT 1")
        .get(providerId);
      if (row?.provider_specific_data) {
        const psd = JSON.parse(row.provider_specific_data);
        const b = psd.baseUrl || psd.base_url;
        if (typeof b === "string" && b.startsWith("http")) base = b.replace(/\/+$/, "");
      }
    } catch {}
  }
  if (!base) return null;
  try {
    const res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const list = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
    const hit = list.find((m) => {
      const id = (m.id ?? m.slug ?? m.name ?? "").toLowerCase();
      return id === modelId.toLowerCase();
    });
    if (!hit) return null;
    return normalizeApiPricing(hit);
  } catch {
    return null;
  }
}

async function main() {
  const arg = process.argv[2]; // optional "provider/model"
  let targets = [];
  if (arg && arg.includes("/")) {
    const [prov, ...rest] = arg.split("/");
    targets.push({ provider: prov, model: rest.join("/") });
  } else {
    // Sample: check pricing for every provider/model that has any pricing entry (from merged pricing)
    // to demonstrate fallback cleanly without enumerating all discovered models.
    const db = getDbInstance();
    // Pull a few known models from pricing table for demo; replace with your own list as needed.
    const rows = db
      .prepare(
        "SELECT key FROM key_value WHERE namespace IN ('pricing','pricing_synced','models_dev_pricing') LIMIT 20"
      )
      .all();
    targets = [
      { provider: "openai", model: "gpt-4o" },
      { provider: "openai", model: "gpt-4o-mini" },
    ];
    if (rows.length === 0) console.log("No pricing rows found — demo targets used.");
  }

  for (const { provider, model } of targets) {
    let result = null;
    let source = "none";

    // 1) Try API
    try {
      const db = getDbInstance();
      const row = db
        .prepare("SELECT api_key FROM provider_connections WHERE provider=? LIMIT 1")
        .get(provider);
      const apiKey = row?.api_key ? String(row.api_key) : null;
      if (apiKey) {
        const api = await tryApiPricing(provider, apiKey, model);
        if (api) {
          result = api;
          source = "api";
        }
      }
    } catch {}

    // 2) Fallback to models.dev / merged pricing
    if (!result) {
      const merged = await getPricingForModel(provider, model);
      if (merged) {
        result = { input: merged.input, output: merged.output, source: "models.dev/merged" };
        source = "models.dev";
      }
    }

    if (result) {
      console.log(
        `${provider}/${model} → ${source}: input $${result.input}/1M, output $${result.output}/1M`
      );
    } else {
      console.log(`${provider}/${model} → no pricing found (neither API nor models.dev)`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
