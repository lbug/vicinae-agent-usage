export type ProviderId = "claude" | "codex" | "openrouter" | "xai";

/** A rate-limit window: how much of it is used and when it starts over. */
export interface Meter {
  label: string;
  /** Short label for the list row ("5h", "7d"); meters without one only appear in the detail panel. */
  short?: string;
  usedPercent: number;
  /** ISO timestamp; kept as a string so cards survive the JSON round trip through the cache. */
  resetsAt?: string;
}

export interface Stat {
  label: string;
  value: string;
  /** Text for the list row; stats without one only appear in the detail panel. */
  short?: string;
  /** Consecutive stats with the same section are grouped between separators in the detail panel. */
  section?: string;
}

/** One account of one provider — one row in the list. */
export interface UsageCard {
  id: string;
  provider: ProviderId;
  account?: string;
  plan?: string;
  meters: Meter[];
  stats: Stat[];
  error?: string;
  /** Set when a failed fetch keeps showing older numbers: when those numbers were fetched (ISO). */
  staleSince?: string;
}
