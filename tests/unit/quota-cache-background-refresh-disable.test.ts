import test from "node:test";
import assert from "node:assert/strict";

const mod = await import("../../src/domain/quotaCache.ts");

function getTimer(): unknown {
  const state = (globalThis as Record<string, unknown>).__omnirouteQuotaCacheState as
    | {
        refreshTimer?: unknown;
      }
    | undefined;
  return state?.refreshTimer ?? null;
}

function withEnv(value: string | undefined, fn: () => void): void {
  const key = "OMNIROUTE_DISABLE_QUOTA_BACKGROUND_REFRESH";
  const prev = process.env[key];
  try {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

test("quota background refresh kill-switch: disabled flag is honored", () => {
  withEnv("true", () => {
    assert.equal(mod.isQuotaBackgroundRefreshDisabled(), true);
    mod.stopBackgroundRefresh();
    mod.startBackgroundRefresh();
    assert.equal(getTimer(), null);
    mod.stopBackgroundRefresh();
  });
});

test("quota background refresh kill-switch: accepts 1/yes/on (case-insensitive)", () => {
  for (const value of ["1", "yes", "on", "TRUE", " On "]) {
    withEnv(value, () => {
      assert.equal(mod.isQuotaBackgroundRefreshDisabled(), true, value);
    });
  }
});

test("quota background refresh kill-switch: unset/false arms the timer (idempotent)", () => {
  withEnv(undefined, () => {
    assert.equal(mod.isQuotaBackgroundRefreshDisabled(), false);
    mod.stopBackgroundRefresh();
    mod.startBackgroundRefresh();
    assert.notEqual(getTimer(), null);
    mod.startBackgroundRefresh();
    assert.notEqual(getTimer(), null);
    mod.stopBackgroundRefresh();
    assert.equal(getTimer(), null);
  });
  withEnv("false", () => {
    assert.equal(mod.isQuotaBackgroundRefreshDisabled(), false);
  });
  withEnv("0", () => {
    assert.equal(mod.isQuotaBackgroundRefreshDisabled(), false);
  });
});
