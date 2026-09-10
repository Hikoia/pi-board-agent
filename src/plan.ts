/** Read-only summaries for the board status view. */
import type { Config } from "./config.js";
import { planSlug } from "./config.js";
import type { Card } from "./gh.js";

export interface PlanSummary {
  slug: string;
  rawName: string;
  totalCards: number;
  doneCards: number;
  readyCards: number;
  buildingCards: number;
  reviewCards: number;
  cards: Card[];
}

export function summarizePlans(
  cfg: Config,
  cards: Card[],
): Map<string, PlanSummary> {
  const summaries = new Map<string, PlanSummary>();
  for (const card of cards) {
    if (!card.plan) continue;
    const slug = planSlug(card.plan);
    let summary = summaries.get(slug);
    if (!summary) {
      summary = {
        slug,
        rawName: card.plan,
        totalCards: 0,
        doneCards: 0,
        readyCards: 0,
        buildingCards: 0,
        reviewCards: 0,
        cards: [],
      };
      summaries.set(slug, summary);
    }
    summary.totalCards++;
    summary.cards.push(card);
    const status = (card.status ?? "").toLowerCase();
    if (status === cfg.columns.done.toLowerCase()) summary.doneCards++;
    else if (status === cfg.columns.ready.toLowerCase()) summary.readyCards++;
    else if (status === cfg.columns.building.toLowerCase())
      summary.buildingCards++;
    else if (status === cfg.columns.review.toLowerCase()) summary.reviewCards++;
  }
  return summaries;
}

export function isPlanComplete(summary: PlanSummary): boolean {
  return summary.totalCards > 0 && summary.doneCards === summary.totalCards;
}
