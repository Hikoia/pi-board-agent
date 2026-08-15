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
  /** Current Type option name ("Story" | "Task"), when a Type field exists. */
  type?: string;
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
  typeFieldId?: string;
  typeOptions?: Record<string, string>;  // name -> optionId
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
  typeFieldName?: string,
): Promise<ProjectMetadata> {
  // Try as user first; fall back to organization.
  const tryUser = await tryProject(owner, number, "user");
  const meta = tryUser ?? (await tryProject(owner, number, "org"));
  if (!meta) {
    throw new Error(`Project #${number} not found for owner '${owner}' (tried user + org).`);
  }
  return resolveFields(meta.projectId, meta.fields, statusFieldName, planFieldName, typeFieldName);
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
  typeFieldName?: string,
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
  if (typeFieldName) {
    const type = fields.find((f) => f.name.toLowerCase() === typeFieldName.toLowerCase());
    if (type?.options) {
      meta.typeFieldId = type.id;
      meta.typeOptions = Object.fromEntries(type.options.map((o) => [o.name, o.id]));
    }
  }
  return meta;
}

/**
 * List all cards in the project, hydrated with status, plan, assignees,
 * issue body and closed-state.
 */
export async function listCards(projectId: string, statusFieldName: string, planFieldName?: string, typeFieldName?: string): Promise<Card[]> {
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
        type: typeFieldName ? fieldByName.get(typeFieldName.toLowerCase()) : undefined,
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
  await setSingleSelect(meta, itemId, meta.statusFieldId, statusName, meta.statusOptions);
}

/** Set a single-select field value on an item (generic). */
export async function setSingleSelect(
  meta: ProjectMetadata,
  itemId: string,
  fieldId: string,
  optionName: string,
  options: Record<string, string>,
): Promise<void> {
  const optionId = options[optionName] ?? findCaseInsensitive(options, optionName);
  if (!optionId) throw new Error(`Option '${optionName}' not found on field.`);
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
    fieldId,
    optionId,
  });
}

/** Set a text field value on an item (generic). */
export async function setTextField(
  meta: ProjectMetadata,
  itemId: string,
  fieldId: string,
  text: string,
): Promise<void> {
  const mutation = `
    mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $text: String!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId
        itemId: $itemId
        fieldId: $fieldId
        value: { text: $text }
      }) { projectV2Item { id } }
    }`;
  await graphql(mutation, { projectId: meta.projectId, itemId, fieldId, text });
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

// ─────────────────────────────────────────────────────────────────────────────
// Phase C — project standard, issues/sub-issues, comments, field values
// ─────────────────────────────────────────────────────────────────────────────

export interface StandardFieldSpec {
  name: string;
  kind: "single" | "text";
  options?: string[];
  colors?: string[];
}

/** Create (if missing) the standard fields + options + a Board view. */
export async function ensureStandardFields(
  meta: ProjectMetadata,
  specs: StandardFieldSpec[],
  viewName: string,
): Promise<{ created: string[]; existing: string[] }> {
  const created: string[] = [];
  const existing: string[] = [];
  // Re-fetch all project fields (the metadata only carries status/plan/type).
  const fields = await listProjectFields(meta.projectId);

  for (const spec of specs) {
    const found = fields.find((f) => f.name.toLowerCase() === spec.name.toLowerCase());
    if (found) {
      existing.push(spec.name);
      // Ensure single-select options exist (add missing ones).
      if (spec.kind === "single" && spec.options && found.options) {
        for (const opt of spec.options) {
          if (!found.options.some((o) => o.name.toLowerCase() === opt.toLowerCase())) {
            await addFieldOption(found.id, opt);
          }
        }
      }
      continue;
    }
    const fieldId = await createField(meta.projectId, spec);
    created.push(spec.name);
    if (spec.kind === "single" && spec.options) {
      for (const opt of spec.options) await addFieldOption(fieldId, opt);
    }
  }

  // Board view grouped by Status (if a status field exists).
  try {
    await createBoardView(meta.projectId, viewName, meta.statusFieldId);
  } catch {
    // view creation is best-effort
  }
  return { created, existing };
}

async function listProjectFields(projectId: string): Promise<Array<{ id: string; name: string; options?: Array<{ id: string; name: string }> }>> {
  const query = `
    query($projectId: ID!) {
      node(id: $projectId) {
        ... on ProjectV2 { fields(first: 100) { nodes { ... on ProjectV2SingleSelectField { id name options { id name } } ... on ProjectV2Field { id name } } } }
      }
    }`;
  const data = await graphql<any>(query, { projectId });
  return data?.node?.fields?.nodes ?? [];
}

async function createField(projectId: string, spec: StandardFieldSpec): Promise<string> {
  const dataType = spec.kind === "single" ? "SINGLE_SELECT" : "TEXT";
  const mutation = `
    mutation($projectId: ID!, $name: String!, $dataType: ProjectV2CustomFieldType!) {
      createProjectV2Field(input: { projectId: $projectId, name: $name, dataType: $dataType }) {
        projectV2Field { ... on ProjectV2SingleSelectField { id } ... on ProjectV2Field { id } }
      }
    }`;
  const data = await graphql<any>(mutation, { projectId, name: spec.name, dataType });
  return data?.createProjectV2Field?.projectV2Field?.id;
}

async function addFieldOption(fieldId: string, name: string, color = "GRAY"): Promise<void> {
  const mutation = `
    mutation($fieldId: ID!, $name: String!, $color: ProjectV2FieldColor!) {
      createProjectV2FieldOption(input: { fieldId: $fieldId, name: $name, color: $color }) {
        field { ... on ProjectV2SingleSelectField { id } }
      }
    }`;
  await graphql(mutation, { fieldId, name, color });
}

async function createBoardView(projectId: string, name: string, groupByFieldId: string): Promise<void> {
  const mutation = `
    mutation($projectId: ID!, $name: String!, $layout: ProjectV2ViewLayout!, $groupBy: [ID!]!) {
      createProjectV2View(input: { projectId: $projectId, name: $name, layout: $layout, groupBy: $groupBy }) {
        projectV2View { id name }
      }
    }`;
  await graphql(mutation, { projectId, name, layout: "BOARD_LAYOUT", groupBy: [groupByFieldId] });
}

/** Resolve repository node id from owner/name. */
export async function resolveRepositoryId(repoOwner: string, repoName: string): Promise<string> {
  const query = `
    query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) { id }
    }`;
  const data = await graphql<any>(query, { owner: repoOwner, name: repoName });
  return data?.repository?.id;
}

/** Resolve issue node id from owner/name/number. */
export async function resolveIssueId(repoOwner: string, repoName: string, number: number): Promise<string> {
  const query = `
    query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) { issue(number: $number) { id } }
    }`;
  const data = await graphql<any>(query, { owner: repoOwner, name: repoName, number });
  return data?.repository?.issue?.id;
}

/** Create an issue; when parentId is given, it becomes a sub-issue of it. */
export async function createIssue(opts: {
  repoOwner: string;
  repoName: string;
  title: string;
  body: string;
  parentIssueId?: string;
}): Promise<{ number: number; id: string; url: string }> {
  const repoId = await resolveRepositoryId(opts.repoOwner, opts.repoName);
  const mutation = `
    mutation($repoId: ID!, $title: String!, $body: String!, $parentId: ID) {
      createIssue(input: { repositoryId: $repoId, title: $title, body: $body, issueId: $parentId }) {
        issue { number id url }
      }
    }`;
  const data = await graphql<any>(mutation, {
    repoId,
    title: opts.title,
    body: opts.body,
    ...(opts.parentIssueId ? { parentId: opts.parentIssueId } : {}),
  });
  const issue = data?.createIssue?.issue;
  if (!issue) throw new Error("createIssue failed (empty response).");
  return { number: issue.number, id: issue.id, url: issue.url };
}

/** Add an existing issue/PR to the project as an item. */
export async function addIssueToProject(projectId: string, contentId: string): Promise<string> {
  const mutation = `
    mutation($projectId: ID!, $contentId: ID!) {
      addProjectV2ItemByContentId(input: { projectId: $projectId, contentId: $contentId }) {
        item { id }
      }
    }`;
  const data = await graphql<any>(mutation, { projectId, contentId });
  return data?.addProjectV2ItemByContentId?.item?.id;
}

/** Post a comment on an issue. Returns the comment node id. */
export async function createComment(issueId: string, body: string): Promise<string | undefined> {
  const mutation = `
    mutation($issueId: ID!, $body: String!) {
      addComment(input: { subjectId: $issueId, body: $body }) { commentEdge { node { id } } }
    }`;
  const data = await graphql<any>(mutation, { issueId, body });
  return data?.addComment?.commentEdge?.node?.id;
}

export interface IssueComment {
  id: string;
  body: string;
  createdAt: string;
  author?: string;
}

/** List comments of an issue (ascending). */
export async function listIssueComments(
  repoOwner: string,
  repoName: string,
  number: number,
): Promise<IssueComment[]> {
  const query = `
    query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        issue(number: $number) {
          comments(first: 50, orderBy: { field: CREATED_AT, direction: ASC }) {
            nodes { id body createdAt author { login } }
          }
        }
      }
    }`;
  const data = await graphql<any>(query, { owner: repoOwner, name: repoName, number });
  return (data?.repository?.issue?.comments?.nodes ?? []).map((n: any) => ({
    id: n.id,
    body: n.body,
    createdAt: n.createdAt,
    author: n.author?.login,
  }));
}

/** True when an open PR for headBranch exists AND is merged. */
export async function isPrMerged(
  repoOwner: string,
  repoName: string,
  headBranch: string,
): Promise<boolean> {
  try {
    const out = await runGh([
      "pr", "view",
      "--repo", `${repoOwner}/${repoName}`,
      "--head", headBranch,
      "--json", "state,mergedAt",
      "--jq", ".state + \"|\" + (.mergedAt // \"\")",
    ]);
    const [state] = out.trim().split("|");
    return state === "MERGED";
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase D — watchdog helpers (PR checks, PR listing)
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentPr {
  number: number;
  title: string;
  headRefName: string;
  headRefOid: string;
  url: string;
}

/** List open PRs with a given label (created by the bot). */
export async function listPrsWithLabel(
  repoOwner: string,
  repoName: string,
  label: string,
): Promise<AgentPr[]> {
  const out = await runGh([
    "pr", "list",
    "--repo", `${repoOwner}/${repoName}`,
    "--state", "open",
    "--label", label,
    "--json", "number,title,headRefName,headRefOid,url",
    "--limit", "50",
  ]);
  const arr = JSON.parse(out) as Array<{
    number: number;
    title: string;
    headRefName: string;
    headRefOid: string;
    url: string;
  }>;
  return arr;
}

export interface CheckRunInfo {
  name: string;
  conclusion: string | null;
  status: string;
}

/** Check-runs of a commit (REST). */
export async function getCheckRuns(
  repoOwner: string,
  repoName: string,
  headSha: string,
): Promise<CheckRunInfo[]> {
  try {
    const out = await runGh([
      "api",
      `repos/${repoOwner}/${repoName}/commits/${headSha}/check-runs`,
      "--jq",
      ".check_runs[] | { name, conclusion, status }",
    ]);
    const lines = out.trim();
    if (!lines) return [];
    return lines.split("\n").map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

/** Issue comments via REST (PRs are issues). */
export async function listPrComments(
  repoOwner: string,
  repoName: string,
  number: number,
): Promise<IssueComment[]> {
  try {
    const out = await runGh([
      "api",
      `repos/${repoOwner}/${repoName}/issues/${number}/comments`,
      "--jq",
      ".[] | { id: .id|tostring, body, created_at, author: .user.login }",
    ]);
    const lines = out.trim();
    if (!lines) return [];
    return lines.split("\n").map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

/** Add a label to a PR (best-effort). */
export async function addPrLabel(
  repoOwner: string,
  repoName: string,
  prNumber: number,
  label: string,
): Promise<void> {
  await runGh([
    "pr", "edit", String(prNumber),
    "--repo", `${repoOwner}/${repoName}`,
    "--add-label", label,
  ]).catch(() => undefined);
}
