import type { UsageCard } from "./types";

export type Snapshot = { cards: UsageCard[]; fetchedAt: string };

/** A failed fetch keeps the last good numbers of that card, marked with when they were fetched. */
export function keepLastGood(card: UsageCard, previous: Snapshot | undefined): UsageCard {
  if (!card.error || !previous) return card;
  const old = previous.cards.find((c) => c.id === card.id);
  if (!old || (old.meters.length === 0 && old.stats.length === 0)) return card;
  return { ...old, error: card.error, staleSince: old.staleSince ?? previous.fetchedAt };
}
