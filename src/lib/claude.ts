import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { Meter, Stat, UsageCard } from "./types";

const USAGE_API = "https://api.anthropic.com/api/oauth/usage";

interface OAuthWindow {
  utilization?: number | null;
  resets_at?: string | null;
}

interface UsageResponse {
  five_hour?: OAuthWindow | null;
  seven_day?: OAuthWindow | null;
  extra_usage?: {
    is_enabled?: boolean;
    credits_ever_enabled?: boolean;
    monthly_limit?: number | null;
    used_credits?: number | null;
    currency?: string;
    decimal_places?: number;
    disabled_reason?: string | null;
  } | null;
  limits?: Array<{
    kind?: string;
    percent?: number;
    resets_at?: string | null;
    is_active?: boolean;
    scope?: { model?: { id?: string | null; display_name?: string | null } | null } | null;
  }>;
  [key: string]: unknown;
}

function expandHome(path: string): string {
  return resolve(path === "~" ? homedir() : path.replace(/^~\//, `${homedir()}/`));
}

/** ~/.claude plus the extra dirs from the preference; symlinked duplicates collapse. */
export function claudeConfigDirs(extra: string): string[] {
  const candidates = [join(homedir(), ".claude"), ...extra.split(",")]
    .map((dir) => dir?.trim())
    .filter((dir): dir is string => Boolean(dir))
    .map(expandHome);
  const seen = new Set<string>();
  return candidates.filter((dir) => {
    let real = dir;
    try {
      real = realpathSync(dir);
    } catch {
      // A missing dir keeps its literal path and fails later with a clear message.
    }
    if (seen.has(real)) return false;
    seen.add(real);
    return true;
  });
}

function readJson(path: string): Record<string, any> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** The signed-in email. The stock ~/.claude keeps it in ~/.claude.json, other config dirs inside themselves. */
function accountName(configDir: string): string {
  const configFile =
    configDir === join(homedir(), ".claude") ? join(homedir(), ".claude.json") : join(configDir, ".claude.json");
  const email = readJson(configFile)?.oauthAccount?.emailAddress;
  if (typeof email === "string" && email) return email;
  return basename(configDir).replace(/^\./, "");
}

function planName(subscriptionType?: string, rateLimitTier?: string): string | undefined {
  if (!subscriptionType) return undefined;
  const plan = subscriptionType.charAt(0).toUpperCase() + subscriptionType.slice(1);
  const multiplier = rateLimitTier?.match(/(\d+x)/)?.[1];
  return multiplier ? `${plan} ${multiplier}` : plan;
}

function windowMeter(label: string, window: OAuthWindow | null | undefined, short?: string): Meter | null {
  if (!window || typeof window.utilization !== "number") return null;
  return { label, short, usedPercent: window.utilization, resetsAt: window.resets_at ?? undefined };
}

export function parseClaudeUsage(data: UsageResponse): { meters: Meter[]; stats: Stat[] } {
  const meters: Meter[] = [];
  const session = windowMeter("Session (5h)", data.five_hour, "5h");
  const weekly = windowMeter("Weekly", data.seven_day, "7d");
  if (session) meters.push(session);
  if (weekly) meters.push(weekly);

  // Model-specific weekly windows come as seven_day_<model> keys and as scoped entries in `limits`.
  const byModel = new Map<string, Meter>();
  for (const [key, value] of Object.entries(data)) {
    const model = key.match(/^seven_day_(opus|sonnet|fable|haiku)$/)?.[1];
    const meter = model && windowMeter(`Weekly ${model.charAt(0).toUpperCase()}${model.slice(1)}`, value as OAuthWindow);
    if (model && meter) byModel.set(model, meter);
  }
  for (const limit of data.limits ?? []) {
    const model = limit.scope?.model?.display_name ?? limit.scope?.model?.id;
    if (limit.kind !== "weekly_scoped" || limit.is_active === false || !model || typeof limit.percent !== "number") {
      continue;
    }
    byModel.set(model.toLowerCase(), {
      label: `Weekly ${model}`,
      usedPercent: limit.percent,
      resetsAt: limit.resets_at ?? undefined,
    });
  }
  meters.push(...byModel.values());

  const stats: Stat[] = [];
  const extra = data.extra_usage;
  if (
    extra &&
    (extra.is_enabled || extra.credits_ever_enabled) &&
    typeof extra.used_credits === "number" &&
    typeof extra.monthly_limit === "number"
  ) {
    const digits = extra.decimal_places ?? 2;
    const scale = 10 ** digits;
    const currency = (extra.currency ?? "USD").toUpperCase();
    const state = extra.is_enabled ? "" : ` · off${extra.disabled_reason ? ` (${extra.disabled_reason.replace(/_/g, " ")})` : ""}`;
    stats.push({
      label: "Extra usage",
      value: `${(extra.used_credits / scale).toFixed(digits)} / ${(extra.monthly_limit / scale).toFixed(digits)} ${currency}${state}`,
    });
  }
  return { meters, stats };
}

async function fetchAccount(configDir: string): Promise<UsageCard> {
  const card: UsageCard = { id: `claude:${configDir}`, provider: "claude", meters: [], stats: [] };
  const oauth = readJson(join(configDir, ".credentials.json"))?.claudeAiOauth;
  if (!oauth?.accessToken) {
    return { ...card, account: configDir, error: `Not logged in — run \`claude\` with CLAUDE_CONFIG_DIR=${configDir}.` };
  }
  card.account = accountName(configDir);
  card.plan = planName(oauth.subscriptionType, oauth.rateLimitTier);

  // Refreshing here would rotate the refresh token under a running Claude Code, so an expired
  // token is reported instead; Claude Code renews it on its next start.
  const response = await fetch(USAGE_API, {
    headers: { Authorization: `Bearer ${oauth.accessToken}`, "anthropic-beta": "oauth-2025-04-20" },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 401) return { ...card, error: "Login expired — start `claude` once to renew it." };
  if (response.status === 429) return { ...card, error: "Rate limited by Anthropic — try again in a minute." };
  if (!response.ok) return { ...card, error: `Anthropic API: HTTP ${response.status}` };
  return { ...card, ...parseClaudeUsage((await response.json()) as UsageResponse) };
}

export async function fetchClaudeCards(extraDirs: string): Promise<UsageCard[]> {
  return Promise.all(
    claudeConfigDirs(extraDirs).map((dir) =>
      fetchAccount(dir).catch((error: Error) => ({
        id: `claude:${dir}`,
        provider: "claude" as const,
        account: accountName(dir),
        meters: [],
        stats: [],
        error: error.name === "TimeoutError" ? "Anthropic API timed out." : error.message,
      })),
    ),
  );
}
