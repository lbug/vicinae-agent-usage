import assert from "node:assert/strict";
import test from "node:test";
import { parseClaudeUsage } from "../src/lib/claude.ts";
import { parseCodexUsage } from "../src/lib/codex.ts";
import { buildOpenRouterUsage, nextUtcReset } from "../src/lib/openrouter.ts";
import { keepLastGood } from "../src/lib/snapshot.ts";

// Shape of a real /api/oauth/usage response (2026-09-30), including the unknown codename keys; numbers made up.
const claudeResponse = {
  five_hour: { utilization: 31, resets_at: "2026-10-01T01:20:00.095142+00:00" },
  seven_day: { utilization: 5, resets_at: "2026-10-04T01:00:00.095163+00:00" },
  seven_day_oauth_apps: null,
  seven_day_opus: null,
  seven_day_sonnet: { utilization: 12, resets_at: "2026-10-04T01:00:00+00:00" },
  iguana_necktie: { utilization: 0, resets_at: "2026-11-05T07:59:00+00:00", limit_dollars: 100 },
  nimbus_quill: { utilization: 0, resets_at: null },
  extra_usage: {
    is_enabled: false,
    monthly_limit: 5000,
    used_credits: 1250,
    currency: "EUR",
    decimal_places: 2,
    disabled_reason: "out_of_credits",
    credits_ever_enabled: true,
  },
  limits: [
    { kind: "session", percent: 31, resets_at: "2026-10-01T01:20:00Z", scope: null, is_active: true },
    { kind: "weekly_all", percent: 5, resets_at: "2026-10-04T01:00:00Z", scope: null, is_active: false },
  ],
};

test("Claude: session and weekly windows lead, model windows follow, codenames are ignored", () => {
  const { meters } = parseClaudeUsage(claudeResponse);
  assert.deepEqual(
    meters.map((m) => [m.label, m.short, m.usedPercent]),
    [
      ["Session (5h)", "5h", 31],
      ["Weekly", "7d", 5],
      ["Weekly Sonnet", undefined, 12],
    ],
  );
  assert.equal(meters[0].resetsAt, "2026-10-01T01:20:00.095142+00:00");
});

test("Claude: extra usage is shown in its own currency, flagged when switched off", () => {
  const { stats } = parseClaudeUsage(claudeResponse);
  assert.deepEqual(stats, [{ label: "Extra usage", value: "12.50 / 50.00 EUR · off (out of credits)" }]);
});

test("Claude: extra usage never enabled is hidden", () => {
  const { stats } = parseClaudeUsage({ ...claudeResponse, extra_usage: { is_enabled: false, credits_ever_enabled: false } });
  assert.deepEqual(stats, []);
});

test("Claude: scoped weekly model limits from `limits` are picked up", () => {
  const { meters } = parseClaudeUsage({
    five_hour: { utilization: 1 },
    limits: [{ kind: "weekly_scoped", percent: 40, is_active: true, scope: { model: { display_name: "Fable" } } }],
  });
  assert.deepEqual(meters.map((m) => m.label), ["Session (5h)", "Weekly Fable"]);
});

test("Codex: windows are labelled by length and ordered by reset time", () => {
  const now = Date.parse("2026-09-30T20:00:00Z");
  const result = parseCodexUsage(
    {
      plan_type: "plus",
      rate_limit: {
        primary_window: { used_percent: 12, limit_window_seconds: 18000, reset_after_seconds: 3600 },
        secondary_window: { used_percent: 40, limit_window_seconds: 604800, reset_at: now / 1000 + 86400 },
      },
      credits: { has_credits: false, unlimited: false, balance: "0" },
    },
    now,
  );
  assert.equal(result.plan, "Plus");
  assert.deepEqual(
    result.meters.map((m) => [m.label, m.short, m.usedPercent, m.resetsAt]),
    [
      ["Session (5h)", "5h", 12, "2026-09-30T21:00:00.000Z"],
      ["Weekly", "7d", 40, "2026-10-01T20:00:00.000Z"],
    ],
  );
  assert.deepEqual(result.stats, []);
});

// Shape of real /api/v1/key and /api/v1/credits responses; numbers made up.
const key = { label: "sk-or-v1-abc...def", limit: 20, limit_remaining: 11.1, limit_reset: "monthly", usage_daily: 0, usage_weekly: 4.5, usage_monthly: 8.9 };
const credits = { total_credits: 25, total_usage: 13.75 };

test("OpenRouter: spend of the OpenCode key plus account balance", () => {
  const { meters, stats } = buildOpenRouterUsage(key, credits, null, new Date("2026-09-30T21:00:00Z"));
  assert.deepEqual(stats, [
    { section: "spend", label: "Today (UTC, this key)", value: "$0.00", short: "$0.00 today" },
    { section: "spend", label: "This week (this key)", value: "$4.50" },
    { section: "spend", label: "This month (this key)", value: "$8.90" },
    { section: "balance", label: "Credit balance", value: "$11.25" },
  ]);
  assert.equal(meters.length, 1);
  assert.equal(meters[0].label, "Key limit ($20.00 monthly)");
  assert.equal(Math.round(meters[0].usedPercent), 45);
  assert.equal(meters[0].resetsAt, "2026-10-01T00:00:00.000Z");
});

test("OpenRouter: a management key sums spend across all keys and breaks it down per key", () => {
  const all = [
    { name: "opencode", label: "sk-or-v1-abc...def", usage_daily: 0.25, usage_weekly: 1, usage_monthly: 2 },
    { name: "speech-to-text", label: "sk-or-v1-123...456", usage_daily: 1.5, usage_weekly: 3, usage_monthly: 10 },
    { name: "old", label: "sk-or-v1-000...000", usage_daily: 0, usage_weekly: 0, usage_monthly: 0 },
  ];
  const { stats } = buildOpenRouterUsage(key, null, all);
  assert.deepEqual(stats, [
    { section: "spend", label: "Today (UTC, all 3 keys)", value: "$1.75", short: "$1.75 today" },
    { section: "spend", label: "This week (all 3 keys)", value: "$4.00" },
    { section: "spend", label: "This month (all 3 keys)", value: "$12.00" },
    { section: "keys", label: "speech-to-text", value: "$1.50 today · $10.00 month" },
    { section: "keys", label: "opencode (this key)", value: "$0.25 today · $2.00 month" },
  ]);
});

test("OpenRouter: uncapped key has no limit meter", () => {
  const { meters } = buildOpenRouterUsage({ limit: null, limit_remaining: null, usage_daily: 1 }, null, null);
  assert.deepEqual(meters, []);
});

test("OpenRouter: weekly limits reset on the next UTC Monday", () => {
  assert.equal(nextUtcReset("weekly", new Date("2026-09-30T12:00:00Z")), "2026-10-05T00:00:00.000Z"); // Wednesday
  assert.equal(nextUtcReset("weekly", new Date("2026-10-05T12:00:00Z")), "2026-10-12T00:00:00.000Z"); // Monday
  assert.equal(nextUtcReset("daily", new Date("2026-12-31T23:00:00Z")), "2027-01-01T00:00:00.000Z");
  assert.equal(nextUtcReset(null), undefined);
});

const good = {
  id: "claude:/home/u/.claude",
  provider: "claude" as const,
  account: "me@example.com",
  meters: [{ label: "Session (5h)", short: "5h", usedPercent: 37 }],
  stats: [],
};
const rateLimited = { id: good.id, provider: "claude" as const, meters: [], stats: [], error: "Rate limited by Anthropic — try again in a minute." };

test("Snapshot: a failed fetch keeps the last good values and says since when", () => {
  const card = keepLastGood(rateLimited, { cards: [good], fetchedAt: "2026-09-30T21:50:00.000Z" });
  assert.deepEqual(card, { ...good, error: rateLimited.error, staleSince: "2026-09-30T21:50:00.000Z" });
});

test("Snapshot: repeated failures keep the time of the last good fetch", () => {
  const stale = { ...good, error: "x", staleSince: "2026-09-30T21:50:00.000Z" };
  const card = keepLastGood(rateLimited, { cards: [stale], fetchedAt: "2026-09-30T22:10:00.000Z" });
  assert.equal(card.staleSince, "2026-09-30T21:50:00.000Z");
});

test("Snapshot: successful fetches and cards without earlier data pass through", () => {
  assert.equal(keepLastGood(good, { cards: [], fetchedAt: "" }), good);
  assert.equal(keepLastGood(rateLimited, { cards: [], fetchedAt: "" }), rateLimited);
  assert.equal(keepLastGood(rateLimited, undefined), rateLimited);
});
