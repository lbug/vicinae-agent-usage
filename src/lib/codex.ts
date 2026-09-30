import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Meter, Stat, UsageCard } from "./types";

const USAGE_API = "https://chatgpt.com/backend-api/wham/usage";

interface RateWindow {
  used_percent?: number;
  limit_window_seconds?: number;
  reset_after_seconds?: number;
  reset_at?: number;
}

interface UsageResponse {
  plan_type?: string;
  rate_limit?: { primary_window?: RateWindow | null; secondary_window?: RateWindow | null } | null;
  credits?: { has_credits?: boolean; unlimited?: boolean; balance?: string | number | null } | null;
}

function windowMeter(window: RateWindow | null | undefined, now: number): Meter | null {
  if (!window || typeof window.used_percent !== "number") return null;
  const hours = (window.limit_window_seconds ?? 0) / 3600;
  const resetsAt =
    typeof window.reset_at === "number"
      ? new Date(window.reset_at * 1000)
      : typeof window.reset_after_seconds === "number"
        ? new Date(now + window.reset_after_seconds * 1000)
        : undefined;
  const [label, short] =
    hours >= 24 * 6 ? ["Weekly", "7d"] : hours > 0 && hours <= 6 ? ["Session (5h)", "5h"] : [`${Math.round(hours)}h window`, `${Math.round(hours)}h`];
  return { label, short, usedPercent: window.used_percent, resetsAt: resetsAt?.toISOString() };
}

export function parseCodexUsage(data: UsageResponse, now = Date.now()): { plan?: string; meters: Meter[]; stats: Stat[] } {
  const meters = [data.rate_limit?.primary_window, data.rate_limit?.secondary_window]
    .map((window) => windowMeter(window, now))
    .filter((meter): meter is Meter => meter !== null)
    .sort((a, b) => (a.resetsAt ?? "").localeCompare(b.resetsAt ?? ""));
  const stats: Stat[] = [];
  const credits = data.credits;
  if (credits?.has_credits && !credits.unlimited && credits.balance != null) {
    stats.push({ label: "Credits", value: String(credits.balance) });
  }
  const plan = data.plan_type ? data.plan_type.charAt(0).toUpperCase() + data.plan_type.slice(1) : undefined;
  return { plan, meters, stats };
}

/** The account email from the id_token's claims; the token is only decoded, never verified. */
function emailFromIdToken(idToken: unknown): string | undefined {
  if (typeof idToken !== "string") return undefined;
  try {
    const claims = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8"));
    return typeof claims.email === "string" ? claims.email : undefined;
  } catch {
    return undefined;
  }
}

export async function fetchCodexCard(): Promise<UsageCard> {
  const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
  const card: UsageCard = { id: "codex", provider: "codex", meters: [], stats: [] };

  let auth: Record<string, any> | null = null;
  try {
    auth = JSON.parse(readFileSync(join(codexHome, "auth.json"), "utf8"));
  } catch {
    // Missing file: not logged in (or credentials live in the OS keyring, which is not read).
  }
  const tokens = auth?.tokens;
  if (!tokens?.access_token) {
    const error = auth?.OPENAI_API_KEY
      ? "Codex uses an API key — plan limits only exist for ChatGPT logins."
      : "Not logged in — run `codex login`.";
    return { ...card, error };
  }
  card.account = emailFromIdToken(tokens.id_token);

  // Like Claude, token refresh is left to Codex itself so its refresh token is never rotated from here.
  const response = await fetch(USAGE_API, {
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      Accept: "application/json",
      ...(tokens.account_id ? { "ChatGPT-Account-Id": tokens.account_id } : {}),
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 401 || response.status === 403) {
    return { ...card, error: "Login expired — start `codex` once to renew it." };
  }
  if (!response.ok) return { ...card, error: `ChatGPT API: HTTP ${response.status}` };
  return { ...card, ...parseCodexUsage((await response.json()) as UsageResponse) };
}
