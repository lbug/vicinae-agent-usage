import { homedir } from "node:os";
import { join } from "node:path";
import type { Meter, Stat, UsageCard } from "./types";

const API = "https://openrouter.ai/api/v1";

/** Spend of one key, in USD. OpenRouter counts days, weeks and months in UTC. */
interface KeySpend {
  /** Masked key ("sk-or-v1-abc…"); the same value in /key and /keys, so it identifies the key in use. */
  label?: string;
  usage_daily?: number;
  usage_weekly?: number;
  usage_monthly?: number;
}

interface KeyInfo extends KeySpend {
  limit?: number | null;
  limit_remaining?: number | null;
  limit_reset?: string | null;
}

interface ListedKey extends KeySpend {
  name?: string;
}

type KeySource = "preference" | "OpenCode" | "OPENROUTER_API_KEY";

/** The key OpenCode stores in its database (OpenCode >= 1.x keeps no auth.json). */
function readOpenCodeKey(): string | undefined {
  try {
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const dbPath = join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "opencode/opencode.db");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db
        .prepare("SELECT value FROM credential WHERE integration_id = 'openrouter' ORDER BY active DESC, time_updated DESC")
        .get() as { value?: string } | undefined;
      const key = row?.value ? JSON.parse(row.value).key : undefined;
      return typeof key === "string" && key ? key : undefined;
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

export function resolveOpenRouterKey(preference: string): { key: string; source: KeySource } | null {
  if (preference.trim()) return { key: preference.trim(), source: "preference" };
  const opencode = readOpenCodeKey();
  if (opencode) return { key: opencode, source: "OpenCode" };
  const env = process.env.OPENROUTER_API_KEY?.trim();
  return env ? { key: env, source: "OPENROUTER_API_KEY" } : null;
}

export function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

/** Start of the next UTC day, week (Monday) or month — when a key's spending limit resets. */
export function nextUtcReset(period: string | null | undefined, now = new Date()): string | undefined {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  if (period === "daily") return new Date(Date.UTC(y, m, d + 1)).toISOString();
  if (period === "weekly") return new Date(Date.UTC(y, m, d + (((8 - now.getUTCDay()) % 7) || 7))).toISOString();
  if (period === "monthly") return new Date(Date.UTC(y, m + 1, 1)).toISOString();
  return undefined;
}

function sumSpend(keys: KeySpend[]): Required<Omit<KeySpend, "label">> {
  const total = { usage_daily: 0, usage_weekly: 0, usage_monthly: 0 };
  for (const key of keys) {
    total.usage_daily += key.usage_daily ?? 0;
    total.usage_weekly += key.usage_weekly ?? 0;
    total.usage_monthly += key.usage_monthly ?? 0;
  }
  return total;
}

export function buildOpenRouterUsage(
  key: KeyInfo,
  credits: { total_credits?: number; total_usage?: number } | null,
  allKeys: ListedKey[] | null,
  now = new Date(),
): { meters: Meter[]; stats: Stat[] } {
  const meters: Meter[] = [];
  if (typeof key.limit === "number" && key.limit > 0 && typeof key.limit_remaining === "number") {
    meters.push({
      label: `Key limit (${usd(key.limit)}${key.limit_reset ? ` ${key.limit_reset}` : ""})`,
      usedPercent: ((key.limit - key.limit_remaining) / key.limit) * 100,
      resetsAt: nextUtcReset(key.limit_reset, now),
    });
  }

  // With a management key, the headline numbers cover every key on the account.
  const spend = allKeys ? sumSpend(allKeys) : sumSpend([key]);
  const scope = allKeys ? `all ${allKeys.length} keys` : "this key";
  const stats: Stat[] = [
    { section: "spend", label: `Today (UTC, ${scope})`, value: usd(spend.usage_daily), short: `${usd(spend.usage_daily)} today` },
    { section: "spend", label: `This week (${scope})`, value: usd(spend.usage_weekly) },
    { section: "spend", label: `This month (${scope})`, value: usd(spend.usage_monthly) },
  ];
  if (typeof credits?.total_credits === "number" && typeof credits.total_usage === "number") {
    const balance = credits.total_credits - credits.total_usage;
    stats.push({ section: "balance", label: "Credit balance", value: usd(balance) });
  }
  // Keys without spend this month are left out; the biggest spenders of today come first.
  const spending = (allKeys ?? [])
    .filter((k) => (k.usage_monthly ?? 0) > 0)
    .sort((a, b) => (b.usage_daily ?? 0) - (a.usage_daily ?? 0) || (b.usage_monthly ?? 0) - (a.usage_monthly ?? 0));
  for (const k of spending) {
    const isThisKey = Boolean(key.label) && k.label === key.label;
    stats.push({
      section: "keys",
      label: `${k.name || k.label || "Unnamed key"}${isThisKey ? " (this key)" : ""}`,
      value: `${usd(k.usage_daily ?? 0)} today · ${usd(k.usage_monthly ?? 0)} month`,
    });
  }
  return { meters, stats };
}

async function get<T>(path: string, key: string): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`OpenRouter ${path}: HTTP ${response.status}`);
  return ((await response.json()) as { data: T }).data;
}

/** All keys of the account, disabled ones included since they may have spent today. */
async function listAllKeys(managementKey: string): Promise<ListedKey[]> {
  const keys: ListedKey[] = [];
  // The endpoint pages by offset; the cap only guards against a server that never returns an empty page.
  for (let page = 0; page < 20; page++) {
    const batch = await get<ListedKey[]>(`/keys?include_disabled=true&offset=${keys.length}`, managementKey);
    if (batch.length === 0) break;
    keys.push(...batch);
  }
  return keys;
}

export async function fetchOpenRouterCard(apiKeyPreference: string, managementKey: string): Promise<UsageCard> {
  const card: UsageCard = { id: "openrouter", provider: "openrouter", meters: [], stats: [] };
  const resolved = resolveOpenRouterKey(apiKeyPreference);
  if (!resolved) {
    return { ...card, error: "No API key — log in to OpenRouter in OpenCode or set one in the preferences." };
  }
  card.account = `${resolved.source} key`;

  const [key, credits, allKeys] = await Promise.all([
    get<KeyInfo>("/key", resolved.key),
    // Balance and account-wide spend are extras: without them the key's own spend still shows.
    get<{ total_credits?: number; total_usage?: number }>("/credits", resolved.key).catch(() => null),
    managementKey.trim() ? listAllKeys(managementKey.trim()) : Promise.resolve(null),
  ]);
  return { ...card, ...buildOpenRouterUsage(key, credits, allKeys) };
}
