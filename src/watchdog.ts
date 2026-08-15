/**
 * Phase D — watchdog: keeps the bot's PRs healthy.
 *
 *  - checks check-runs of open PRs (label `board-agent`); failing CI →
 *    a fix agent (worktree on the PR head branch) commits + pushes, with a
 *    cooldown between attempts and a max number of rounds; beyond that it
 *    asks the human (comment + `needs-human` label + plan cards to
 *    Needs Design) and stops auto-fixing that PR
 *  - responds to @botLogin mentions on its PRs (clarifications) with a
 *    single cheap-model pass
 *
 * All state is file-backed (watchdog-state.json) and per-PR, so restarts and
 * cooldowns survive.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { runWorkflow } from "@quintinshaw/pi-dynamic-workflows";
import type { Config } from "./config.js";
import {
  listPrsWithLabel,
  getCheckRuns,
  listPrComments,
  listCards,
  createComment,
  ensureLabels,
  setStatus,
  resolveIssueId,
  addPrLabel,
  type AgentPr,
} from "./gh.js";
import type { ProjectMetadata } from "./gh.js";
import { generateContext } from "./context.js";

// ── state ───────────────────────────────────────────────────────────────────

export interface WatchdogState {
  [prNumber: number]: {
    fixAttempts: number;
    lastFixAtMs?: number;
    lastSeenCommentId?: string;
    needsHuman: boolean;
  };
}

export class WatchdogStateStore {
  private file: string;
  constructor(cwd: string) {
    this.file = resolve(cwd, ".pi", "board-agent", "watchdog-state.json");
    mkdirSync(resolve(cwd, ".pi", "board-agent"), { recursive: true });
  }
  load(): WatchdogState {
    if (!existsSync(this.file)) return {};
    try {
      return JSON.parse(readFileSync(this.file, "utf8")) as WatchdogState;
    } catch {
      return {};
    }
  }
  save(state: WatchdogState): void {
    writeFileSync(this.file, JSON.stringify(state, null, 2), "utf8");
  }
  get(pr: number): WatchdogState[number] {
    const s = this.load();
    return s[pr] ?? { fixAttempts: 0, needsHuman: false };
  }
  update(pr: number, patch: Partial<WatchdogState[number]>): void {
    const s = this.load();
    s[pr] = { ...(s[pr] ?? { fixAttempts: 0, needsHuman: false }), ...patch };
    this.save(s);
  }
}

// ── workflow renderers ──────────────────────────────────────────────────────

export interface FixWorkflowInput {
  prNumber: number;
  repoOwner: string;
  repoName: string;
  headBranch: string;
  failingChecks: string[];
  contextDigest: string;
  model: string;
  timeoutMs: number;
}

/** Single-agent fix workflow: worktree on the PR head branch, fix, push. */
export function renderFixWorkflowSource(input: FixWorkflowInput): string {
  const payload = JSON.stringify({
    prNumber: input.prNumber,
    repoOwner: input.repoOwner,
    repoName: input.repoName,
    headBranch: input.headBranch,
    failingChecks: input.failingChecks,
    contextDigest: input.contextDigest,
  });
  return `
export const meta = {
  name: 'board-agent-fix',
  description: 'Fix failing CI on PR #${input.prNumber}',
  phases: [{ title: 'Fix' }],
};
const PAYLOAD = ${payload};
phase('Fix');
const result = await agent(
  [
    'You are a fixing agent. PR #' + PAYLOAD.prNumber + ' has failing CI and you must make the minimal fix.',
    'You run inside an isolated git worktree; the repo is checked out there.',
    '',
    'STEPS:',
    '1. git fetch origin ' + PAYLOAD.headBranch + ' && git checkout ' + PAYLOAD.headBranch + ' (create from origin/' + PAYLOAD.headBranch + ' if missing).',
    '2. Inspect the failing checks:',
    '   gh pr checks ' + PAYLOAD.prNumber + ' --repo ' + PAYLOAD.repoOwner + '/' + PAYLOAD.repoName,
    '   gh api repos/' + PAYLOAD.repoOwner + '/' + PAYLOAD.repoName + '/commits/HEAD/check-runs',
    '   Read the failing check logs / annotations from the API response.',
    '3. Fix ONLY what the failing checks complain about. Minimal diff. Respect existing patterns.',
    '4. Commit with a conventional message and push:',
    '   git add -A && git commit -m "fix(scope): <what and why>" && git push origin ' + PAYLOAD.headBranch,
    '5. Return the outcome JSON.',
    '',
    'FAILING CHECKS: ' + PAYLOAD.failingChecks.join(', '),
    '',
    'REPO CONTEXT (existing code — ground the fix here):',
    '----8<----',
    PAYLOAD.contextDigest,
    '----8<----',
  ].join('\\n'),
  {
    model: ${JSON.stringify(input.model)},
    timeoutMs: ${input.timeoutMs},
    label: 'fix pr-' + PAYLOAD.prNumber,
    isolation: 'worktree',
    schema: {
      type: 'object',
      required: ['status'],
      properties: {
        status: { type: 'string', enum: ['success', 'failure'] },
        commitSha: { type: 'string' },
        summary: { type: 'string' },
        error: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
);
return result;
`.trimStart();
}

export interface ReplyWorkflowInput {
  prNumber: number;
  mentionBody: string;
  contextDigest: string;
  model: string;
  timeoutMs: number;
}

/** Single-agent reply workflow for @mentions (clarifications). */
export function renderReplyWorkflowSource(input: ReplyWorkflowInput): string {
  const payload = JSON.stringify({
    prNumber: input.prNumber,
    mentionBody: input.mentionBody,
    contextDigest: input.contextDigest,
  });
  return `
export const meta = {
  name: 'board-agent-reply',
  description: 'Reply to a mention on PR #${input.prNumber}',
  phases: [{ title: 'Reply' }],
};
const PAYLOAD = ${payload};
phase('Reply');
const result = await agent(
  [
    'You answer for pi-board-agent on PR #' + PAYLOAD.prNumber + '. A human mentioned the bot.',
    'Be concise, technical, in the same language as the mention.',
    'If the human asks for a change, say you will apply it (the watchdog acts on CI).',
    'If the human asks a question about the PR, answer it from the context.',
    'Return ONLY the reply text as { reply: string }.',
    '',
    'MENTIONED COMMENT:',
    '----8<----',
    PAYLOAD.mentionBody,
    '----8<----',
    '',
    'REPO CONTEXT:',
    '----8<----',
    PAYLOAD.contextDigest,
    '----8<----',
  ].join('\\n'),
  {
    model: ${JSON.stringify(input.model)},
    timeoutMs: ${input.timeoutMs},
    label: 'reply pr-' + PAYLOAD.prNumber,
    schema: {
      type: 'object',
      required: ['reply'],
      properties: { reply: { type: 'string' } },
      additionalProperties: false,
    },
  },
);
return result;
`.trimStart();
}

// ── watchdog ────────────────────────────────────────────────────────────────

export interface WatchdogDeps {
  cwd: string;
  cfg: Config;
  repoOwner: string;
  repoName: string;
  botLogin: string;
  meta: ProjectMetadata;
  callback: (msg: string, level?: "info" | "warn" | "error") => void;
}

export class Watchdog {
  private state: WatchdogStateStore;
  private activeFixes = new Map<number, Promise<void>>();

  constructor(private deps: WatchdogDeps) {
    this.state = new WatchdogStateStore(deps.cwd);
  }

  /** One watchdog cycle: PR health + mentions. Non-blocking for CI waiting. */
  async tick(): Promise<void> {
    const { cfg, repoOwner, repoName, callback } = this.deps;
    if (!cfg.watchdog.enabled) return;
    let prs: AgentPr[];
    try {
      prs = await listPrsWithLabel(repoOwner, repoName, cfg.watchdog.pr_label);
    } catch (err: any) {
      callback(`Watchdog: can't list PRs: ${err.message}`, "warn");
      return;
    }
    if (prs.length === 0) return;

    const contextDigest = await this.getContextDigest();

    for (const pr of prs) {
      await this.handleMentions(pr).catch((err) =>
        callback(`Watchdog mentions (PR #${pr.number}): ${err.message}`, "warn"),
      );
      await this.handleCi(pr, contextDigest).catch((err) =>
        callback(`Watchdog CI (PR #${pr.number}): ${err.message}`, "warn"),
      );
    }
  }

  private async handleCi(pr: AgentPr, contextDigest: string): Promise<void> {
    const { cfg, repoOwner, repoName, callback } = this.deps;
    const st = this.state.get(pr.number);
    if (st.needsHuman) return;

    const checks = await getCheckRuns(repoOwner, repoName, pr.headRefOid);
    const failing = checks.filter(
      (c) =>
        c.conclusion === "failure" ||
        c.conclusion === "timed_out" ||
        c.conclusion === "action_required",
    );
    const pending = checks.some((c) => c.status === "in_progress" || c.status === "queued");

    if (failing.length === 0) {
      // Green (or still running): reset the counter so a NEW regression gets
      // fresh attempts.
      if (!pending && st.fixAttempts > 0) {
        this.state.update(pr.number, { fixAttempts: 0 });
      }
      return;
    }

    const cooldownMs = cfg.watchdog.fix_cooldown_minutes * 60_000;
    const since = st.lastFixAtMs ? Date.now() - st.lastFixAtMs : Number.POSITIVE_INFINITY;
    if (since < cooldownMs) return;

    if (st.fixAttempts >= cfg.watchdog.fix_rounds_max || this.activeFixes.has(pr.number)) {
      if (st.fixAttempts >= cfg.watchdog.fix_rounds_max && !st.needsHuman) {
        await this.askHuman(pr, failing.map((f) => f.name), st.fixAttempts);
      }
      return;
    }

    callback(
      `Watchdog: PR #${pr.number} failing (${failing.map((f) => f.name).join(", ")}). Fix round ${st.fixAttempts + 1}/${cfg.watchdog.fix_rounds_max}.`,
    );

    const script = renderFixWorkflowSource({
      prNumber: pr.number,
      repoOwner,
      repoName,
      headBranch: pr.headRefName,
      failingChecks: failing.map((f) => f.name),
      contextDigest,
      model: cfg.models.watch,
      timeoutMs: cfg.builder_timeout_ms ?? 1_800_000,
    });
    const promise = (async () => {
      try {
        const res = await runWorkflow(script, { cwd: this.deps.cwd, persistLogs: true });
        const r = (res.result ?? {}) as { status?: string; summary?: string; error?: string };
        if (r.status === "success") {
          callback(`Watchdog: fix pushed on PR #${pr.number} — ${r.summary ?? ""} (CI will re-run).`);
        } else {
          callback(`Watchdog: fix attempt failed on PR #${pr.number}: ${r.error ?? "unknown"}`, "warn");
        }
      } catch (err: any) {
        callback(`Watchdog: fix workflow error on PR #${pr.number}: ${err.message}`, "error");
      } finally {
        this.activeFixes.delete(pr.number);
      }
    })();
    this.activeFixes.set(pr.number, promise);
    this.state.update(pr.number, { fixAttempts: st.fixAttempts + 1, lastFixAtMs: Date.now() });
  }

  private async handleMentions(pr: AgentPr): Promise<void> {
    const { cfg, repoOwner, repoName, botLogin, callback } = this.deps;
    if (!cfg.watchdog.respond_to_mentions) return;
    const st = this.state.get(pr.number);
    const comments = await listPrComments(repoOwner, repoName, pr.number);
    const fresh = st.lastSeenCommentId
      ? comments.filter((c) => c.id !== st.lastSeenCommentId)
      : comments;
    const mentions = fresh.filter(
      (c) => c.author && c.author !== botLogin && c.body.includes(`@${botLogin}`),
    );
    if (mentions.length === 0) return;

    callback(`Watchdog: @${botLogin} mentioned ${mentions.length} time(s) on PR #${pr.number}.`);
    const contextDigest = await this.getContextDigest();
    const script = renderReplyWorkflowSource({
      prNumber: pr.number,
      mentionBody: mentions.map((m) => m.body).join("\n\n---\n\n"),
      contextDigest,
      model: cfg.models.watch,
      timeoutMs: cfg.refine.timeout_ms,
    });
    try {
      const res = await runWorkflow(script, { cwd: this.deps.cwd, persistLogs: true });
      const r = (res.result ?? {}) as { reply?: string };
      if (r.reply) {
        const issueId = await resolveIssueId(repoOwner, repoName, pr.number);
        await createComment(issueId, r.reply);
        callback(`Watchdog: replied on PR #${pr.number}.`);
      }
    } catch (err: any) {
      callback(`Watchdog: reply failed on PR #${pr.number}: ${err.message}`, "warn");
    }
    const last = comments[comments.length - 1];
    this.state.update(pr.number, { lastSeenCommentId: last?.id });
  }

  /** Ask the human for help: comment + label + plan cards → Needs Design. */
  private async askHuman(pr: AgentPr, failing: string[], attempts: number): Promise<void> {
    const { cfg, repoOwner, repoName, meta, callback } = this.deps;
    try {
      const issueId = await resolveIssueId(repoOwner, repoName, pr.number);
      const body = [
        `## ⚠️ Serve intervento umano — PR #${pr.number}`,
        "",
        `Dopo ${attempts} tentativi di fix automatico la CI è ancora rossa.`,
        "",
        "**Check falliti:**",
        "",
        ...failing.map((f) => `- \`${f}\``),
        "",
        "Il watchdog si è fermato su questa PR in attesa del tuo intervento (fix manuale o istruzioni via commento @bot).",
        "",
      ].join("\n");
      await createComment(issueId, body);
      await ensureLabels(repoOwner, repoName, [cfg.watchdog.needs_human_label]);
      await addPrLabel(repoOwner, repoName, pr.number, cfg.watchdog.needs_human_label);
    } catch {
      // best-effort
    }
    // Move plan cards to Needs Design (visible on the board).
    try {
      const cards = await listCards(meta.projectId, cfg.status_field, cfg.plan_field, cfg.type_field);
      const slug = planSlugFromBranch(pr.headRefName);
      const planCards = cards.filter((card) => card.plan === slug);
      for (const card of planCards) {
        await setStatus(meta, card.itemId, cfg.columns.needs_design).catch(() => undefined);
      }
      if (planCards.length) {
        callback(`Watchdog: ${planCards.length} carta/e del plan passate a ${cfg.columns.needs_design}.`);
      }
    } catch {
      // best-effort
    }
    this.state.update(pr.number, { needsHuman: true });
    callback(`Watchdog: PR #${pr.number} → needs-human (dopo ${attempts} fix falliti).`, "warn");
  }

  private async getContextDigest(): Promise<string> {
    const { cfg, cwd } = this.deps;
    if (!cfg.context.enabled) return "";
    try {
      return generateContext({ cwd, maxChars: cfg.context.max_chars, exclude: cfg.context.exclude });
    } catch {
      return "";
    }
  }
}

function planSlugFromBranch(headRefName: string): string {
  const m = headRefName.match(/\bplan\/(.+)$/);
  return m ? m[1] : headRefName;
}
