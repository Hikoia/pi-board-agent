/**
 * Thin wrapper around the `gh` CLI for the operations we need:
 *  - resolve the project + its Status / Plan field option IDs (GraphQL)
 *  - list cards in a column, optionally filtered by Plan
 *  - move a card to a column
 *  - claim / release a card via assignee (atomic mutex)
 *  - open / update / merge a PR
 *
 * Everything goes through `gh api graphql` for ProjectsV2 (the REST API does
 * not cover v2) and `gh pr` for pull requests. We never call git remotes
 * directly — `gh` handles auth.
 */
import { spawn } from "node:child_process";

export interface Card {
  /** Project item id (PVTI_…) */
  itemId: string;
  /** Issue or PR number when the item is content-linked; undefined for drafts. */
  number?: number;
  /** Card title (issue title or draft title). */
  title: string;
  /** Card body (issue body or draft body). */
  body: string;
  /** Current Status option name (e.g. "Ready"). */
  status?: string;
  /** Current Plan option name (e.g. "001-auth"). */
  plan?: string;
  /** Current assignees (logins). Empty array if none. */
  assignees: string[];
  /** True when the underlying issue/PR is closed. */
  closed: boolean;
  /** Linked issue/PR url (when content-linked). */
  url?: string;
  /** Repository owner/name (for content-linked cards). */
  repoOwner?: string;
  repoName?: string;
}

export interface ProjectMetadata {
  projectId: string;
  statusFieldId: string;
  statusOptions: Record<string, string>; // name -> optionId
  planFieldId?: string;
  planOptions?: Record<string, string>;  // name -> optionId
}

class GhError extends Error {
  constructor(message: string, public exitCode: number, public stderr: string) {
    super(message);
    this.name = "GhError";
  }
}

function runGh(args: string[], opts: { input?: string; cwd?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new GhError(`gh ${args.join(" ")} failed`, code ?? -1, stderr));
    });
    if (opts.input !== undefined) {
      child.stdin.write(opts.input);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
  });
}

async function graphql<T = unknown>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [k, v] of Object.entries(variables)) {
    if (typeof v === "number") args.push("-F", `${k}=${v}`);
    else args.push("-f", `${k}=${String(v)}`);
  }
  const out = await runGh(args);
  const parsed = JSON.parse(out);
  if (parsed.errors) {
    throw new Error(`GraphQL error: ${JSON.stringify(parsed.errors)}`);
  }
  return parsed.data as T;
}

/** Read the GitHub login of the currently authenticated `gh` user. */
export async function whoami(): Promise<string> {
  const out = await runGh(["api", "user", "--jq", ".login"]);
  return out.trim();
}

/** Resolve project id + status field id + status option ids from owner+number. */
export async function getProjectMetadata(
  owner: string,
  number: number,
  statusFieldName: string,
  planFieldName?: string,
): Promise<ProjectMetadata> {
  // Try as user first; fall back to organization.
  const tryUser = await tryProject(owner, number, "user");
  const meta = tryUser ?? (await tryProject(owner, number, "org"));
  if (!meta) {
    throw new Error(`Project #${number} not found for owner '${owner}' (tried user + org).`);
  }
  return resolveFields(meta.projectId, meta.fields, statusFieldName, planFieldName);
}

interface RawProject {
  projectId: string;
  fields: Array<{
    id: string;
    name: string;
    options?: Array<{ id: string; name: string }>;
  }>;
}

async function tryProject(owner: string, number: number, scope: "user" | "org"): Promise<RawProject | null> {
  const root = scope === "user" ? "user" : "organization";
  const query = `
    query($login: String!, $number: Int!) {
      ${root}(login: $login) {
        projectV2(number: $number) {
          id
          fields(first: 100) {
            nodes {
              ... on ProjectV2SingleSelectField {
                id name
                options { id name }
              }
              ... on ProjectV2Field { id name }
            }
          }
        }
      }
    }`;
  try {
    const data = await graphql<any>(query, { login: owner, number });
    const project = data?.[root]?.projectV2;
    if (!project) return null;
    return {
      projectId: project.id,
      fields: project.fields.nodes.filter(Boolean),
    };
  } catch {
    return null;
  }
}

function resolveFields(
  projectId: string,
  fields: RawProject["fields"],
  statusFieldName: string,
  planFieldName?: string,
): ProjectMetadata {
  const status = fields.find((f) => f.name.toLowerCase() === statusFieldName.toLowerCase());
  if (!status || !status.options) {
    throw new Error(`Status field '${statusFieldName}' not found on project, or it is not single-select.`);
  }
  const meta: ProjectMetadata = {
    projectId,
    statusFieldId: status.id,
    statusOptions: Object.fromEntries(status.options.map((o) => [o.name, o.id])),
  };
  if (planFieldName) {
    const plan = fields.find((f) => f.name.toLowerCase() === planFieldName.toLowerCase());
    if (plan?.options) {
      meta.planFieldId = plan.id;
      meta.planOptions = Object.fromEntries(plan.options.map((o) => [o.name, o.id]));
    }
  }
  return meta;
}

/**
 * List all cards in the project, hydrated with status, plan, assignees,
 * issue body and closed-state.
 */
export async function listCards(projectId: string, statusFieldName: string, planFieldName?: string): Promise<Card[]> {
  const cards: Card[] = [];
  let cursor: string | null = null;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const query = `
      query($projectId: ID!, $cursor: String) {
        node(id: $projectId) {
          ... on ProjectV2 {
            items(first: 50, after: $cursor) {
              pageInfo { hasNextPage endCursor }
              nodes {
                id
                fieldValues(first: 20) {
                  nodes {
                    ... on ProjectV2ItemFieldSingleSelectValue {
                      name
                      field { ... on ProjectV2SingleSelectField { name } }
                    }
                  }
                }
                content {
                  __typename
                  ... on Issue {
                    number title body url closed
                    assignees(first: 10) { nodes { login } }
                    repository { owner { login } name }
                  }
                  ... on PullRequest {
                    number title body url closed
                    assignees(first: 10) { nodes { login } }
                    repository { owner { login } name }
                  }
                  ... on DraftIssue {
                    title body
                    assignees(first: 10) { nodes { login } }
                  }
                }
              }
            }
          }
        }
      }`;
    const variables: Record<string, unknown> = { projectId };
    if (cursor) variables.cursor = cursor;
    const data = await graphql<any>(query, variables);
    const items = data?.node?.items;
    if (!items) break;
    for (const item of items.nodes) {
      const fieldByName = new Map<string, string>();
      for (const fv of item.fieldValues.nodes) {
        if (fv?.field?.name && fv.name) fieldByName.set(fv.field.name.toLowerCase(), fv.name);
      }
      const c = item.content ?? {};
      cards.push({
        itemId: item.id,
        number: c.number,
        title: c.title ?? "(untitled)",
        body: c.body ?? "",
        status: fieldByName.get(statusFieldName.toLowerCase()),
        plan: planFieldName ? fieldByName.get(planFieldName.toLowerCase()) : undefined,
        assignees: (c.assignees?.nodes ?? []).map((a: any) => a.login),
        closed: !!c.closed,
        url: c.url,
        repoOwner: c.repository?.owner?.login,
        repoName: c.repository?.name,
      });
    }
    if (!items.pageInfo.hasNextPage) break;
    cursor = items.pageInfo.endCursor;
  }
  return cards;
}

/** Move a card to a different Status option. No-op if the option is unknown. */
export async function setStatus(meta: ProjectMetadata, itemId: string, statusName: string): Promise<void> {
  const optionId = meta.statusOptions[statusName] ?? findCaseInsensitive(meta.statusOptions, statusName);
  if (!optionId) throw new Error(`Status option '${statusName}' not found on project.`);
  const mutation = `
    mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId
        itemId: $itemId
        fieldId: $fieldId
        value: { singleSelectOptionId: $optionId }
      }) { projectV2Item { id } }
    }`;
  await graphql(mutation, {
    projectId: meta.projectId,
    itemId,
    fieldId: meta.statusFieldId,
    optionId,
  });
}

function findCaseInsensitive(map: Record<string, string>, key: string): string | undefined {
  const lower = key.toLowerCase();
  for (const [k, v] of Object.entries(map)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

/**
 * Atomically claim an issue by adding `botLogin` as assignee. Returns true
 * iff *we* won the race (i.e. nobody else is assigned). This is the only
 * mutex super-board uses, and it survives restarts because GitHub itself
 * holds the state.
 */
export async function tryClaim(card: Card, botLogin: string): Promise<boolean> {
  if (!card.number || !card.repoOwner || !card.repoName) return false; // drafts cannot be claimed
  // If someone else is already assigned (or we are), bail.
  const others = card.assignees.filter((a) => a !== botLogin);
  if (others.length > 0) return false;
  if (card.assignees.includes(botLogin)) return true; // we already hold it
  try {
    await runGh([
      "issue", "edit", String(card.number),
      "--repo", `${card.repoOwner}/${card.repoName}`,
      "--add-assignee", botLogin,
    ]);
    return true;
  } catch (err) {
    if (err instanceof GhError && /already assigned/i.test(err.stderr)) return true;
    throw err;
  }
}

export async function release(card: Card, botLogin: string): Promise<void> {
  if (!card.number || !card.repoOwner || !card.repoName) return;
  if (!card.assignees.includes(botLogin)) return;
  await runGh([
    "issue", "edit", String(card.number),
    "--repo", `${card.repoOwner}/${card.repoName}`,
    "--remove-assignee", botLogin,
  ]).catch(() => undefined);
}

export interface OpenPrOptions {
  baseBranch: string;
  headBranch: string;
  title: string;
  body: string;
  reviewers?: string[]; // logins or "org/team-slug"
  labels?: string[];
  repoOwner: string;
  repoName: string;
}

export async function openPr(opts: OpenPrOptions): Promise<{ number: number; url: string }> {
  const args = [
    "pr", "create",
    "--repo", `${opts.repoOwner}/${opts.repoName}`,
    "--base", opts.baseBranch,
    "--head", opts.headBranch,
    "--title", opts.title,
    "--body-file", "-",
  ];
  if (opts.reviewers && opts.reviewers.length) {
    args.push("--reviewer", opts.reviewers.join(","));
  }
  if (opts.labels && opts.labels.length) {
    args.push("--label", opts.labels.join(","));
  }
  const out = await runGh(args, { input: opts.body });
  const url = out.trim().split("\n").pop() ?? "";
  const m = url.match(/\/pull\/(\d+)/);
  if (!m) throw new Error(`Could not parse PR url from gh output: ${out}`);
  return { number: Number(m[1]), url };
}

export async function ensureLabels(repoOwner: string, repoName: string, labels: string[]): Promise<void> {
  for (const label of labels) {
    try {
      await runGh([
        "label", "create", label,
        "--repo", `${repoOwner}/${repoName}`,
        "--color", "8a2be2",
        "--description", "Managed by pi-board-agent",
        "--force",
      ]);
    } catch {
      // ignore — label exists or insufficient perms; PR creation will surface the real error
    }
  }
}

/** Find an existing PR for the given head branch, or undefined. */
export async function findPr(repoOwner: string, repoName: string, headBranch: string): Promise<{ number: number; url: string } | undefined> {
  try {
    const out = await runGh([
      "pr", "list",
      "--repo", `${repoOwner}/${repoName}`,
      "--head", headBranch,
      "--state", "open",
      "--json", "number,url",
      "--limit", "1",
    ]);
    const arr = JSON.parse(out) as Array<{ number: number; url: string }>;
    return arr[0];
  } catch {
    return undefined;
  }
}

export { runGh as _runGh, graphql as _graphql };
