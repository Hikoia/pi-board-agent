/**
 * Plan-level operations: detect when a plan is "done" (all cards in `done`)
 * and open the cumulative PR plan/<slug> -> base.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Card } from "./gh.js";
import { ensureLabels, findPr, openPr } from "./gh.js";
import type { Config } from "./config.js";
import { planBranch as makePlanBranch, planSlug as makePlanSlug } from "./config.js";
import { commitsAhead } from "./git-helpers.js";

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

export function summarizePlans(cfg: Config, cards: Card[]): Map<string, PlanSummary> {
  const out = new Map<string, PlanSummary>();
  for (const c of cards) {
    if (!c.plan) continue;
    const slug = makePlanSlug(c.plan);
    let s = out.get(slug);
    if (!s) {
      s = { slug, rawName: c.plan, totalCards: 0, doneCards: 0, readyCards: 0, buildingCards: 0, reviewCards: 0, cards: [] };
      out.set(slug, s);
    }
    s.totalCards++;
    s.cards.push(c);
    const status = (c.status ?? "").toLowerCase();
    if (status === cfg.columns.done.toLowerCase()) s.doneCards++;
    else if (status === cfg.columns.ready.toLowerCase()) s.readyCards++;
    else if (status === cfg.columns.building.toLowerCase()) s.buildingCards++;
    else if (status === cfg.columns.review.toLowerCase()) s.reviewCards++;
  }
  return out;
}

export function isPlanComplete(s: PlanSummary): boolean {
  return s.totalCards > 0 && s.doneCards === s.totalCards;
}

export interface OpenPlanPrInput {
  cwd: string;
  cfg: Config;
  repoOwner: string;
  repoName: string;
  summary: PlanSummary;
}

export interface OpenPlanPrResult {
  status: "opened" | "exists" | "skipped-no-commits";
  number?: number;
  url?: string;
}

export async function openPlanPr(input: OpenPlanPrInput): Promise<OpenPlanPrResult> {
  const { cfg, cwd, repoOwner, repoName, summary } = input;
  const planBranch = makePlanBranch(cfg.branches.plan_prefix, summary.slug);

  // Already exists? Idempotent — return.
  const existing = await findPr(repoOwner, repoName, planBranch);
  if (existing) return { status: "exists", number: existing.number, url: existing.url };

  // No commits ahead of base -> nothing to open a PR for.
  if (commitsAhead(planBranch, cfg.branches.base, cwd) === 0) {
    return { status: "skipped-no-commits" };
  }

  if (cfg.pr.labels?.length) await ensureLabels(repoOwner, repoName, cfg.pr.labels);

  const title = renderPrTitle(summary);
  const body = renderPrBody(cwd, cfg, summary);

  const result = await openPr({
    baseBranch: cfg.branches.base,
    headBranch: planBranch,
    title,
    body,
    reviewers: cfg.pr.reviewers,
    labels: cfg.pr.labels,
    repoOwner,
    repoName,
  });
  return { status: "opened", number: result.number, url: result.url };
}

function renderPrTitle(s: PlanSummary): string {
  return `Plan ${s.rawName}: ${s.totalCards} task${s.totalCards === 1 ? "" : "s"} delivered`;
}

function renderPrBody(cwd: string, cfg: Config, s: PlanSummary): string {
  const templatePath = resolve(cwd, cfg.pr.body_template ?? "");
  const head =
    cfg.pr.body_template && existsSync(templatePath)
      ? readFileSync(templatePath, "utf-8").trim() + "\n\n---\n\n"
      : "";
  const sections = [
    `## Plan: \`${s.rawName}\``,
    "",
    `_Opened by [pi-board-agent](https://github.com/mancioshell/pi-board-agent)._`,
    "",
    `**${s.doneCards}/${s.totalCards}** cards reached \`${cfg.columns.done}\`.`,
    "",
    "### Tasks included",
    "",
  ];
  for (const c of s.cards) {
    const ref = c.number ? `#${c.number}` : "(draft)";
    sections.push(`- ${ref} ${c.title}`);
  }
  sections.push("");
  if (cfg.pr.reviewers?.length) {
    sections.push("### Reviewers requested");
    sections.push("");
    sections.push(cfg.pr.reviewers.map((r) => `- @${r}`).join("\n"));
    sections.push("");
  }
  return head + sections.join("\n");
}
