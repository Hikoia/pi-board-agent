import type { IssueComment } from "./gh.js";

/** Only an explicit, complete product/requirement/cost/authorization question pauses a ticket. */
export interface Decision {
  question: string;
  context: string;
  options: string[];
  recommendation: string;
}

export function parseDecision(
  value: Partial<Record<keyof Decision, unknown>>,
): Decision | undefined {
  const text = (v: unknown): v is string => typeof v === "string" && !!v.trim();
  if (
    !text(value.question) ||
    !text(value.context) ||
    !text(value.recommendation) ||
    !Array.isArray(value.options) ||
    value.options.length < 2 ||
    !value.options.every(text) ||
    new Set(value.options.map((s) => s.trim().toLowerCase())).size !==
      value.options.length
  )
    return undefined;
  return {
    question: value.question,
    context: value.context,
    options: value.options,
    recommendation: value.recommendation,
  };
}

export function renderDecisionComment(decision: Decision): string {
  return [
    "## ⚠️ Needs human input",
    "",
    "### Question",
    decision.question,
    "",
    "### Missing decision context",
    decision.context,
    "",
    "### Options",
    ...decision.options.map((option) => `- ${option}`),
    "",
    "### Recommendation",
    decision.recommendation,
    "",
    "### Resume",
    "Add any needed context, then manually move this card to `Ready` to resume. Ready is the resume signal; no reply check is required. A comment alone never resumes work.",
  ].join("\n");
}

/** Visible provenance, independent of the GitHub account used to post it. */
export function formatAgentComment(body: string): string {
  let fence: string | undefined;
  const tagged = body.split(/\r?\n/).map((line) => {
    const boundary = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (boundary) {
      if (!fence) fence = boundary[1];
      else if (boundary[1][0] === fence[0] && boundary[1].length >= fence.length && !boundary[2].trim()) fence = undefined;
      return line;
    }
    if (fence) return line;
    return line.replace(/^( {0,3}#{1,6})([ \t]+)(.*)$/, (heading, prefix, gap, title) =>
      /^\[Agent\](?:\s|$)/.test(title) ? heading : `${prefix}${gap}[Agent] ${title}`);
  }).join("\n");
  return /^\[Agent\](?:\s|$)/.test(tagged.trimStart()) ? tagged : `[Agent]\n\n${tagged}`;
}

export function trustedMissionComments(comments: IssueComment[]): string {
  return comments
    .filter(
      (c) =>
        c.author &&
        ["OWNER", "MEMBER", "COLLABORATOR"].includes(
          c.authorAssociation ?? "",
        ) &&
        !/^(?:#{1,6}\s+)?\[Agent\](?:\s|$)/.test(c.body.trimStart()) &&
        !c.body.trimStart().startsWith("<!-- board-agent-"),
    )
    .map((c) => `${c.createdAt} ${c.author}: ${c.body}`)
    .join("\n\n");
}

/** Outcome shape returned by one persisted builder workflow. */
export interface WaveOutcome extends Partial<Decision> {
  taskKey: string;
  itemId: string;
  status: "success" | "failure" | "needs_decision";
  branch?: string;
  commits?: number;
  summary?: string;
  error?: string;
  attempted?: string;
  limitations?: string;
  workaround?: string;
  humanAction?: string;
}

/** Strictly normalize a persisted workflow result; malformed entries are not guessed. */
export function normalizeWaveResults(raw: unknown): WaveOutcome[] {
  const value =
    raw && typeof raw === "object" && !Array.isArray(raw) && "result" in raw
      ? (raw as { result?: unknown }).result
      : raw;
  if (!Array.isArray(value)) return [];

  const outcomes: WaveOutcome[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return [];
    const result = item as Record<string, unknown>;
    if (
      typeof result.taskKey !== "string" ||
      typeof result.itemId !== "string" ||
      (result.status !== "success" &&
        result.status !== "failure" &&
        result.status !== "needs_decision")
    )
      return [];
    const decision =
      result.status === "needs_decision" ? parseDecision(result) : undefined;
    if (result.status === "needs_decision" && !decision) return [];
    outcomes.push({
      ...decision,
      taskKey: result.taskKey,
      itemId: result.itemId,
      status: result.status,
      branch: typeof result.branch === "string" ? result.branch : undefined,
      commits: typeof result.commits === "number" ? result.commits : undefined,
      summary: typeof result.summary === "string" ? result.summary : undefined,
      error: typeof result.error === "string" ? result.error : undefined,
      attempted:
        typeof result.attempted === "string" ? result.attempted : undefined,
      limitations:
        typeof result.limitations === "string" ? result.limitations : undefined,
      workaround:
        typeof result.workaround === "string" ? result.workaround : undefined,
      humanAction:
        typeof result.humanAction === "string" ? result.humanAction : undefined,
    });
  }
  return outcomes;
}
