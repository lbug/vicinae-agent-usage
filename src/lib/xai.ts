import type { Stat, UsageCard } from "./types";

const API = "https://management-api.x.ai";

const usd = (value: number) => `$${value.toFixed(2)}`;

interface KeyValidation {
  scope?: string;
  scopeId?: string;
  /** Deprecated by xAI, but still the only field for keys that are not team-scoped. */
  teamId?: string;
}

interface PrepaidBalance {
  /** Prepaid credits left, in USD cents (a string in the API). */
  total?: { val?: string | number };
}

/** The team a management key belongs to. */
export function teamIdOf(key: KeyValidation): string | undefined {
  return (key.scope === "SCOPE_TEAM" ? key.scopeId : undefined) || key.teamId || undefined;
}

export function buildXaiUsage(balance: PrepaidBalance): { stats: Stat[] } {
  const cents = Number(balance.total?.val);
  if (balance.total?.val == null || !Number.isFinite(cents)) return { stats: [] };
  const value = usd(cents / 100);
  return { stats: [{ section: "balance", label: "Prepaid balance", value, short: `${value} left` }] };
}

async function get<T>(path: string, key: string): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error("xAI rejected the management key — create a new one in the xAI Console.");
  }
  if (!response.ok) throw new Error(`xAI ${path}: HTTP ${response.status}`);
  return (await response.json()) as T;
}

export async function fetchXaiCard(managementKey: string, teamIdPreference: string): Promise<UsageCard> {
  const card: UsageCard = { id: "xai", provider: "xai", meters: [], stats: [] };
  const key = managementKey.trim();
  if (!key) {
    return { ...card, error: "No management key — create one in the xAI Console (Settings → Management Keys) and add it in the preferences." };
  }

  const teamId = teamIdPreference.trim() || teamIdOf(await get<KeyValidation>("/auth/management-keys/validation", key));
  if (!teamId) return { ...card, error: "Could not tell which team the management key belongs to — set the team ID in the preferences." };

  const balance = await get<PrepaidBalance>(`/v1/billing/teams/${encodeURIComponent(teamId)}/prepaid/balance`, key);
  return { ...card, ...buildXaiUsage(balance) };
}
