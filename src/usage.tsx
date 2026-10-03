import { Fragment, useCallback, useEffect, useState } from "react";
import {
  Action,
  ActionPanel,
  Cache,
  Color,
  getPreferenceValues,
  Icon,
  Image,
  Keyboard,
  List,
} from "@vicinae/api";
import { fetchClaudeCards } from "./lib/claude";
import { fetchCodexCard } from "./lib/codex";
import { fetchOpenRouterCard } from "./lib/openrouter";
import { keepLastGood, type Snapshot } from "./lib/snapshot";
import { fetchXaiCard } from "./lib/xai";
import type { Meter, ProviderId, Stat, UsageCard } from "./lib/types";

const PROVIDERS: Record<ProviderId, { name: string; short: string; icon: string; dashboard: string }> = {
  claude: { name: "Claude Code", short: "Claude", icon: "logo-claude.svg", dashboard: "https://claude.ai/settings/usage" },
  codex: { name: "Codex", short: "Codex", icon: "logo-codex.svg", dashboard: "https://chatgpt.com/codex/settings/usage" },
  openrouter: { name: "OpenRouter", short: "OR", icon: "logo-openrouter.svg", dashboard: "https://openrouter.ai/activity" },
  xai: { name: "xAI (Grok)", short: "xAI", icon: "logo-xai.svg", dashboard: "https://console.x.ai" },
};

const cache = new Cache();
const CACHE_KEY = "cards";
/** Opening the view within this window reuses the cached numbers; the usage APIs rate-limit eagerly. */
const FRESH_MS = 60_000;

function readCache(): Snapshot | undefined {
  try {
    const raw = cache.get(CACHE_KEY);
    return raw ? (JSON.parse(raw) as Snapshot) : undefined;
  } catch {
    return undefined;
  }
}

// Hex twins of the named colors, for the SVG ring, which cannot use theme colors.
const TONES = [
  { from: 90, color: Color.Red, hex: "#f0524f" },
  { from: 70, color: Color.Orange, hex: "#f08c3a" },
  { from: 50, color: Color.Yellow, hex: "#e5b93c" },
  { from: 0, color: Color.Green, hex: "#3fb96b" },
];

function tone(percent: number) {
  return TONES.find((t) => percent >= t.from) ?? TONES[TONES.length - 1];
}

/** A ring filled to `percent`, as an SVG data URL (the same technique as Raycast's getProgressIcon). */
function progressRing(percent: number): Image.ImageLike {
  const r = 38;
  const fraction = Math.min(1, Math.max(0, percent / 100));
  const end = fraction * 2 * Math.PI;
  const x = 50 + r * Math.sin(end);
  const y = 50 - r * Math.cos(end);
  const { hex } = tone(percent);
  const arc =
    fraction >= 1
      ? `<circle cx="50" cy="50" r="${r}" stroke="${hex}" stroke-width="12" fill="none"/>`
      : fraction > 0
        ? `<path d="M50 ${50 - r} A${r} ${r} 0 ${fraction > 0.5 ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)}" stroke="${hex}" stroke-width="12" stroke-linecap="round" fill="none"/>`
        : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><circle cx="50" cy="50" r="${r}" stroke="#8a8a8a" stroke-opacity="0.3" stroke-width="12" fill="none"/>${arc}</svg>`;
  return { source: `data:image/svg+xml,${encodeURIComponent(svg)}` };
}

function bar(percent: number, width = 14): string {
  const filled = Math.round((Math.min(100, Math.max(0, percent)) / 100) * width);
  return "▰".repeat(filled) + "▱".repeat(width - filled);
}

function formatDuration(ms: number): string {
  if (ms <= 0) return "now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function formatReset(iso: string): string {
  const at = new Date(iso);
  const when = at.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
  return `${formatDuration(at.getTime() - Date.now())} · ${when}`;
}

/** The meter that runs out first — the one that decides whether you can keep working. */
function headlineMeter(card: UsageCard): Meter | undefined {
  return card.meters.filter((m) => m.short).sort((a, b) => b.usedPercent - a.usedPercent)[0];
}

/** One-line summary for copying, e.g. "Claude 31% · Codex 12% · OR $0.42 today". */
function summary(cards: UsageCard[]): string {
  return cards
    .map((card) => {
      const name = PROVIDERS[card.provider].short;
      if (card.error && !card.staleSince) return `${name} –`;
      const meter = headlineMeter(card);
      if (meter) return `${name} ${Math.round(meter.usedPercent)}%`;
      const stat = card.stats.find((s) => s.short);
      return stat ? `${name} ${stat.short}` : name;
    })
    .join(" · ");
}

function rowAccessories(card: UsageCard): List.Item.Accessory[] {
  if (card.error && !card.staleSince) {
    const notConfigured = /^(Not logged in|No API key)/.test(card.error);
    return [
      {
        icon: notConfigured ? undefined : { source: Icon.Warning, tintColor: Color.Orange },
        text: notConfigured ? "Not configured" : "Error",
        tooltip: card.error,
      },
    ];
  }
  const accessories: List.Item.Accessory[] = [];
  if (card.staleSince) {
    accessories.push({
      icon: { source: Icon.Clock, tintColor: Color.Orange },
      tooltip: `${card.error} Showing values from ${formatTime(card.staleSince)}.`,
    });
  }
  const meter = headlineMeter(card);
  if (meter) {
    accessories.push({
      icon: progressRing(meter.usedPercent),
      text: `${Math.round(meter.usedPercent)}%`,
      tooltip: card.meters
        .filter((m) => m.short)
        .map((m) => `${m.label}: ${Math.round(m.usedPercent)}% used`)
        .join(" · "),
    });
  } else {
    const stat = card.stats.find((s) => s.short);
    if (stat) accessories.push({ text: stat.short, tooltip: stat.label });
  }
  return accessories;
}

/** Consecutive stats of one section, in order. */
function sections(stats: Stat[]): Stat[][] {
  const groups: Stat[][] = [];
  for (const stat of stats) {
    const last = groups[groups.length - 1];
    if (last && last[0].section === stat.section) last.push(stat);
    else groups.push([stat]);
  }
  return groups;
}

function CardDetail({ card, fetchedAt }: { card: UsageCard; fetchedAt?: string }) {
  const Meta = List.Item.Detail.Metadata;
  return (
    <List.Item.Detail
      metadata={
        <Meta>
          {card.account && <Meta.Label title="Account" text={card.account} />}
          {card.plan && <Meta.Label title="Plan" text={card.plan} />}
          {card.error && (
            <Meta.Label
              title={card.staleSince ? `Values from ${formatTime(card.staleSince)}` : "Status"}
              icon={{ source: Icon.Warning, tintColor: Color.Orange }}
              text={{ value: card.error, color: Color.Orange }}
            />
          )}
          {card.meters.map((meter) => (
            <Fragment key={meter.label}>
              <Meta.Separator />
              <Meta.Label
                title={meter.label}
                text={{ value: `${bar(meter.usedPercent)}  ${Math.round(meter.usedPercent)}% used`, color: tone(meter.usedPercent).color }}
              />
              {meter.resetsAt && <Meta.Label title="Resets in" text={formatReset(meter.resetsAt)} />}
            </Fragment>
          ))}
          {sections(card.stats).map((group, i) => (
            <Fragment key={group[0].section ?? i}>
              <Meta.Separator />
              {group.map((stat) => (
                <Meta.Label key={stat.label} title={stat.label} text={stat.value} />
              ))}
            </Fragment>
          ))}
          {fetchedAt && (
            <>
              <Meta.Separator />
              <Meta.Label title="Updated" text={formatTime(card.staleSince ?? fetchedAt)} />
            </>
          )}
        </Meta>
      }
    />
  );
}

async function fetchAll(prefs: Preferences.Usage): Promise<UsageCard[]> {
  const failed = (provider: ProviderId) => (error: Error) => [
    {
      id: provider,
      provider,
      meters: [],
      stats: [],
      error: error.name === "TimeoutError" ? "Request timed out." : error.message,
    },
  ];
  const groups = await Promise.all([
    fetchClaudeCards(prefs.claudeConfigDirs ?? "").catch(failed("claude")),
    fetchCodexCard()
      .then((card) => [card])
      .catch(failed("codex")),
    fetchOpenRouterCard(prefs.openrouterApiKey ?? "", prefs.openrouterManagementKey ?? "")
      .then((card) => [card])
      .catch(failed("openrouter")),
    // Left out until a management key is set: most people have no xAI API account.
    prefs.xaiManagementKey?.trim()
      ? fetchXaiCard(prefs.xaiManagementKey, prefs.xaiTeamId ?? "")
          .then((card) => [card])
          .catch(failed("xai"))
      : Promise.resolve([]),
  ]);
  return groups.flat();
}

export default function Command() {
  const prefs = getPreferenceValues<Preferences.Usage>();
  const [snapshot, setSnapshot] = useState<Snapshot | undefined>(readCache);
  const [isLoading, setIsLoading] = useState(true);
  const [showDetail, setShowDetail] = useState(true);

  const load = useCallback(async () => {
    setIsLoading(true);
    const previous = readCache();
    const cards = (await fetchAll(prefs)).map((card) => keepLastGood(card, previous));
    const next = { cards, fetchedAt: new Date().toISOString() };
    setSnapshot(next);
    setIsLoading(false);
    cache.set(CACHE_KEY, JSON.stringify(next));
  }, [prefs.claudeConfigDirs, prefs.openrouterApiKey, prefs.openrouterManagementKey, prefs.xaiManagementKey, prefs.xaiTeamId]);

  useEffect(() => {
    const cached = readCache();
    if (cached && Date.now() - new Date(cached.fetchedAt).getTime() < FRESH_MS) setIsLoading(false);
    else void load();
  }, [load]);

  const cards = snapshot?.cards ?? [];
  const perProvider = (provider: ProviderId) => cards.filter((c) => c.provider === provider).length;

  return (
    <List
      isLoading={isLoading}
      isShowingDetail={showDetail && cards.length > 0}
      searchBarPlaceholder="Filter agents..."
      navigationTitle={snapshot ? `Agent Usage · updated ${formatTime(snapshot.fetchedAt)}` : "Agent Usage"}
    >
      {cards.map((card) => {
        const provider = PROVIDERS[card.provider];
        return (
          <List.Item
            key={card.id}
            id={card.id}
            title={provider.name}
            // Only needed to tell several accounts of one provider apart; the detail panel has the rest.
            subtitle={perProvider(card.provider) > 1 ? card.account?.split("@")[0] : undefined}
            icon={{ source: provider.icon, tintColor: Color.PrimaryText }}
            keywords={[card.provider, card.account, card.plan].filter((k): k is string => Boolean(k))}
            accessories={rowAccessories(card)}
            detail={<CardDetail card={card} fetchedAt={snapshot?.fetchedAt} />}
            actions={
              <ActionPanel>
                <Action.OpenInBrowser title="Open Usage Dashboard" url={provider.dashboard} />
                <Action
                  title="Refresh"
                  icon={Icon.RotateAntiClockwise}
                  shortcut={Keyboard.Shortcut.Common.Refresh}
                  onAction={() => void load()}
                />
                <Action
                  title={showDetail ? "Hide Details" : "Show Details"}
                  icon={Icon.AppWindowSidebarLeft}
                  shortcut={{ modifiers: ["cmd"], key: "d" }}
                  onAction={() => setShowDetail((v) => !v)}
                />
                <Action.CopyToClipboard title="Copy Summary" content={summary(cards)} />
              </ActionPanel>
            }
          />
        );
      })}
    </List>
  );
}
