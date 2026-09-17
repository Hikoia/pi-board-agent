/** Read-only Project discovery and guarded Task Issue status/claim/comment I/O. */
import type { Config } from "./config.js";
import {
  GIT_GH_TIMEOUT_MS,
  ProcessTimeoutError,
  runProcess,
} from "./process-runner.js";

export interface Card {
  /** Project item id (PVTI_…) */
  itemId: string;
  /** GraphQL content kind. Automation mutates only exact `Issue` cards. */
  contentType: "Issue" | "PullRequest" | "DraftIssue" | string;
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
  /** Current Type option name; only Task executes. */
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
  statusFieldType?: string;
  statusOptions: Record<string, string>; // name -> optionId
  typeFieldId?: string;
  typeFieldType?: string;
  typeOptions?: Record<string, string>; // name -> optionId
}

class GhError extends Error {
  constructor(
    message: string,
    public exitCode: number,
    public stderr: string,
  ) {
    super(message);
    this.name = "GhError";
  }
}

async function runGh(
  args: string[],
  opts: { input?: string; cwd?: string; timeoutMs?: number } = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? GIT_GH_TIMEOUT_MS;
  const result = await runProcess("gh", args, { ...opts, timeoutMs });
  if (result.ok) return result.stdout;
  if (result.timedOut)
    throw new ProcessTimeoutError(`gh ${args.join(" ")}`, timeoutMs);
  throw new GhError(
    `gh ${args.join(" ")} failed: ${result.stderr.trim().split("\n")[0]}`,
    result.status ?? -1,
    result.stderr,
  );
}

function parseGhJson<T>(output: string, command: string): T {
  try {
    return JSON.parse(output) as T;
  } catch {
    throw new Error(`gh ${command} returned invalid JSON.`);
  }
}

async function graphql<T = unknown>(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [k, v] of Object.entries(variables)) {
    if (typeof v === "number") args.push("-F", `${k}=${v}`);
    else if (typeof v === "string") args.push("-f", `${k}=${v}`);
    else args.push("-F", `${k}=${JSON.stringify(v)}`); // objects/arrays → typed JSON
  }
  const out = await runGh(args);
  const parsed = parseGhJson<{ data: T; errors?: unknown }>(out, "api graphql");
  if (!parsed || parsed.errors || !parsed.data) {
    throw new Error(
      `Invalid GraphQL response: ${JSON.stringify(parsed?.errors ?? "missing data")}`,
    );
  }
  return parsed.data;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`GitHub returned missing or invalid ${label}.`);
  return value;
}

/** Missing data is not an empty connection: callers may create/mutate on absence. */
function connectionPage(
  connection: any,
  label: string,
  seen: Set<string>,
): { nodes: any[]; next: string | null } {
  if (
    !Array.isArray(connection?.nodes) ||
    connection.nodes.some(
      (node: unknown) => !node || typeof node !== "object",
    ) ||
    typeof connection.pageInfo?.hasNextPage !== "boolean"
  )
    throw new Error(`GitHub ${label} returned an invalid connection.`);
  if (!connection.pageInfo.hasNextPage)
    return { nodes: connection.nodes, next: null };
  const next = connection.pageInfo.endCursor;
  if (typeof next !== "string" || !next || seen.has(next))
    throw new Error(`GitHub ${label} returned a missing or repeated cursor.`);
  seen.add(next);
  return { nodes: connection.nodes, next };
}

function uniqueIds(nodes: Array<{ id: string }>, label: string): void {
  const ids = nodes.map((node) => requiredString(node.id, `${label} id`));
  if (new Set(ids).size !== ids.length)
    throw new Error(`GitHub returned duplicate ${label} ids.`);
}

/** Read the GitHub login of the currently authenticated `gh` user. */
export async function whoami(): Promise<string> {
  const out = await runGh(["api", "user", "--jq", ".login"]);
  return requiredString(out.trim(), "authenticated login");
}

/** Resolve project id + status field id + status option ids from owner+number. */
export async function getProjectMetadata(
  owner: string,
  number: number,
  statusFieldName: string,
  typeFieldName?: string,
): Promise<ProjectMetadata> {
  // Project ownership is independent of the target repository. Resolve user/org
  // in one lookup; permission/network/partial-data errors must not cause fallback.
  const data = await graphql<any>(
    `
    query($login: String!, $number: Int!) {
      repositoryOwner(login: $login) {
        ... on User { projectV2(number: $number) { id } }
        ... on Organization { projectV2(number: $number) { id } }
      }
    }`,
    { login: owner, number },
  );
  const projectId = requiredString(
    data.repositoryOwner?.projectV2?.id,
    `Project ${owner}/#${number} id`,
  );
  return resolveFields(
    projectId,
    await listProjectFields(projectId),
    statusFieldName,
    typeFieldName,
  );
}

interface RawProject {
  fields: Array<{
    id: string;
    name: string;
    dataType?: string;
    options?: Array<{ id: string; name: string }>;
  }>;
}

function resolveFields(
  projectId: string,
  fields: RawProject["fields"],
  statusFieldName: string,
  typeFieldName?: string,
): ProjectMetadata {
  const status = fields.find(
    (f) => f.name.toLowerCase() === statusFieldName.toLowerCase(),
  );
  if (status?.dataType !== "SINGLE_SELECT" || !status.options) {
    throw new Error(
      `Status field '${statusFieldName}' not found on project, or it is not single-select.`,
    );
  }
  const meta: ProjectMetadata = {
    projectId,
    statusFieldId: status.id,
    statusFieldType: status.dataType,
    statusOptions: Object.fromEntries(
      status.options.map((o) => [o.name, o.id]),
    ),
  };
  if (typeFieldName) {
    const type = fields.find(
      (f) => f.name.toLowerCase() === typeFieldName.toLowerCase(),
    );
    if (type) {
      meta.typeFieldId = type.id;
      meta.typeFieldType = type.dataType;
      if (type.options)
        meta.typeOptions = Object.fromEntries(
          type.options.map((o) => [o.name, o.id]),
        );
    }
  }
  return meta;
}

export function validateStatusOptions(
  meta: ProjectMetadata,
  names: string[],
): void {
  const missing = names.filter(
    (name) => !findCaseInsensitive(meta.statusOptions, name),
  );
  if (missing.length > 0) {
    throw new Error(
      `Status option(s) missing from project: ${missing.join(", ")}`,
    );
  }
}

/** Read-only preflight. Plan and manual holding columns are never required. */
export function validateProjectMetadata(
  meta: ProjectMetadata,
  cfg: Config,
): void {
  if (!meta.statusFieldId || meta.statusFieldType !== "SINGLE_SELECT")
    throw new Error(
      `Project Status field '${cfg.status_field}' is required and must be SINGLE_SELECT.`,
    );
  validateStatusOptions(meta, [
    cfg.columns.backlog,
    cfg.columns.ready,
    cfg.columns.building,
    cfg.columns.review,
    cfg.columns.done,
    cfg.columns.needs_human,
  ]);
  if (!meta.typeFieldId || meta.typeFieldType !== "SINGLE_SELECT")
    throw new Error(
      `Project Type field '${cfg.type_field}' is required and must be SINGLE_SELECT.`,
    );
  const missing = ["Task"].filter(
    (name) => !findCaseInsensitive(meta.typeOptions ?? {}, name),
  );
  if (missing.length)
    throw new Error(
      `Project Type field '${cfg.type_field}' is missing option(s): ${missing.join(", ")}.`,
    );
}

const CARD_FIELDS = `
  id
  fieldValues(first: 100) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on ProjectV2ItemFieldSingleSelectValue {
        name
        field { ... on ProjectV2SingleSelectField { name } }
      }
      ... on ProjectV2ItemFieldTextValue {
        text
        field { ... on ProjectV2Field { name } }
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
  }
`;

function hydrateCard(
  item: any,
  statusFieldName: string,
  planFieldName?: string,
  typeFieldName?: string,
): Card {
  const fieldByName = new Map<string, string>();
  for (const fv of item.fieldValues.nodes) {
    const name = fv?.field?.name;
    if (!name) continue;
    const key = requiredString(name, "field name").toLowerCase();
    if (fieldByName.has(key))
      throw new Error(`Ambiguous Project field '${name}' on ${item.id}.`);
    if (typeof fv.name === "string") fieldByName.set(key, fv.name);
    else if (typeof fv.text === "string") fieldByName.set(key, fv.text);
  }
  const content = item.content ?? {};
  if (content.__typename === "Issue") {
    if (
      !Number.isSafeInteger(content.number) ||
      content.number <= 0 ||
      typeof content.closed !== "boolean" ||
      typeof content.body !== "string"
    )
      throw new Error(`Invalid linked content on Project item ${item.id}.`);
    requiredString(
      content.repository?.owner?.login,
      "content repository owner",
    );
    requiredString(content.repository?.name, "content repository name");
    if (!Array.isArray(content.assignees?.nodes))
      throw new Error(`Invalid assignees on Project item ${item.id}.`);
  }
  return {
    itemId: item.id,
    contentType: content.__typename ?? "Unknown",
    number: content.number,
    title: content.title ?? "(untitled)",
    body: content.body ?? "",
    status: fieldByName.get(statusFieldName.toLowerCase()),
    plan: planFieldName
      ? fieldByName.get(planFieldName.toLowerCase())
      : undefined,
    type: typeFieldName
      ? fieldByName.get(typeFieldName.toLowerCase())
      : undefined,
    assignees: (content.assignees?.nodes ?? []).map((assignee: any) =>
      requiredString(assignee?.login, "assignee login"),
    ),
    closed: !!content.closed,
    url: content.url,
    repoOwner: content.repository?.owner?.login,
    repoName: content.repository?.name,
  };
}

export function isTargetIssue(
  card: Card,
  repoOwner: string,
  repoName: string,
  expectedType?: "Task",
): card is Card & {
  contentType: "Issue";
  number: number;
  repoOwner: string;
  repoName: string;
} {
  return (
    card.contentType === "Issue" &&
    Number.isSafeInteger(card.number) &&
    (card.number ?? 0) > 0 &&
    !!repoOwner &&
    !!repoName &&
    !!card.itemId &&
    card.repoOwner?.toLowerCase() === repoOwner.toLowerCase() &&
    card.repoName?.toLowerCase() === repoName.toLowerCase() &&
    (!expectedType || card.type?.toLowerCase() === expectedType.toLowerCase())
  );
}

/**
 * List all cards in the project, hydrated with status, plan, assignees,
 * issue body and closed-state.
 */
export async function listCards(
  projectId: string,
  statusFieldName: string,
  planFieldName?: string,
  typeFieldName?: string,
): Promise<Card[]> {
  const cards: Card[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const query = `
      query($projectId: ID!, $cursor: String) {
        node(id: $projectId) {
          ... on ProjectV2 {
            items(first: 50, after: $cursor) {
              pageInfo { hasNextPage endCursor }
              nodes { ${CARD_FIELDS} }
            }
          }
        }
      }`;
    const variables: Record<string, unknown> = { projectId };
    if (cursor) variables.cursor = cursor;
    const data = await graphql<any>(query, variables);
    const page = connectionPage(data?.node?.items, "Project items", seen);
    for (const item of page.nodes) {
      await completeCardFields(item);
      cards.push(
        hydrateCard(item, statusFieldName, planFieldName, typeFieldName),
      );
    }
    if (!page.next) break;
    cursor = page.next;
  }
  uniqueIds(
    cards.map((card) => ({ id: card.itemId })),
    "Project item",
  );
  return cards;
}

/** Re-read one full project card by its stable Project item ID. */
export async function getCard(
  itemId: string,
  statusFieldName: string,
  planFieldName?: string,
  typeFieldName?: string,
): Promise<Card | undefined> {
  const query = `
    query($itemId: ID!) {
      node(id: $itemId) { ... on ProjectV2Item { ${CARD_FIELDS} } }
    }`;
  const data = await graphql<any>(query, { itemId });
  if (data?.node === null) return undefined;
  if (data?.node?.id !== itemId)
    throw new Error(`GitHub returned a different Project item for ${itemId}.`);
  await completeCardFields(data.node);
  return hydrateCard(data.node, statusFieldName, planFieldName, typeFieldName);
}

async function completeCardFields(item: any): Promise<void> {
  requiredString(item?.id, "Project item id");
  const seen = new Set<string>();
  let page = connectionPage(item.fieldValues, "Project field values", seen);
  const nodes = [...page.nodes];
  while (page.next) {
    const data = await graphql<any>(
      `
      query($itemId: ID!, $after: String) {
        node(id: $itemId) { ... on ProjectV2Item {
          fieldValues(first: 100, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes {
              ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2SingleSelectField { name } } }
              ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2Field { name } } }
            }
          }
        } }
      }`,
      { itemId: item.id, after: page.next },
    );
    page = connectionPage(
      data?.node?.fieldValues,
      "Project field values",
      seen,
    );
    nodes.push(...page.nodes);
  }
  item.fieldValues = { nodes };
}

/** Move a card to a different Status option; reject unknown options. */
export async function setStatus(
  meta: ProjectMetadata,
  itemId: string,
  statusName: string,
): Promise<void> {
  await setSingleSelect(
    meta,
    itemId,
    meta.statusFieldId,
    statusName,
    meta.statusOptions,
  );
}

/** Set a single-select field value on an item (generic). */
async function setSingleSelect(
  meta: ProjectMetadata,
  itemId: string,
  fieldId: string,
  optionName: string,
  options: Record<string, string>,
): Promise<void> {
  const optionId = findCaseInsensitive(options, optionName);
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
  const data = await graphql<any>(mutation, {
    projectId: meta.projectId,
    itemId,
    fieldId,
    optionId,
  });
  if (data?.updateProjectV2ItemFieldValue?.projectV2Item?.id !== itemId)
    throw new Error("Unable to confirm Project field mutation.");
}

function findCaseInsensitive(
  map: Record<string, string>,
  key: string,
): string | undefined {
  const lower = key.toLowerCase();
  const matches = Object.entries(map).filter(
    ([name]) => name.toLowerCase() === lower,
  );
  if (matches.length > 1)
    throw new Error(`Ambiguous case-insensitive option '${key}'.`);
  return matches[0]?.[1];
}

/** Add the bot assignee and verify the resulting issue state. The ticket
 * executor performs a second full Project-item refetch before launch. */
async function readClaimState(
  card: Card,
): Promise<{ open: boolean; assignees: string[] }> {
  const out = await runGh([
    "issue",
    "view",
    String(card.number),
    "--repo",
    `${card.repoOwner}/${card.repoName}`,
    "--json",
    "state,assignees",
  ]);
  const value = parseGhJson<{
    state?: string;
    assignees?: Array<{ login?: string }>;
  }>(out, "issue view");
  if (
    !value ||
    !["OPEN", "CLOSED"].includes(value.state ?? "") ||
    !Array.isArray(value.assignees)
  )
    throw new Error("GitHub returned invalid issue claim state.");
  return {
    open: value.state === "OPEN",
    assignees: value.assignees.map((assignee) =>
      requiredString(assignee?.login, "claim assignee"),
    ),
  };
}

export async function tryClaim(
  card: Card,
  botLogin: string,
  allowClosed = false,
): Promise<boolean> {
  if (
    !isTargetIssue(
      card,
      card.repoOwner ?? "",
      card.repoName ?? "",
      allowClosed ? undefined : "Task",
    )
  )
    return false;
  requiredString(botLogin, "claim login");
  const bot = botLogin.toLowerCase();
  const before = await readClaimState(card);
  if (
    (!before.open && !allowClosed) ||
    before.assignees.some((assignee) => assignee.toLowerCase() !== bot)
  )
    return false;

  let mutationError: unknown;
  if (!before.assignees.some((assignee) => assignee.toLowerCase() === bot)) {
    try {
      await runGh([
        "issue",
        "edit",
        String(card.number),
        "--repo",
        `${card.repoOwner}/${card.repoName}`,
        "--add-assignee",
        botLogin,
      ]);
    } catch (error) {
      mutationError = error;
    }
  }

  const after = await readClaimState(card);
  const won =
    after.open === before.open &&
    (after.open || allowClosed) &&
    after.assignees.some((assignee) => assignee.toLowerCase() === bot) &&
    after.assignees.every((assignee) => assignee.toLowerCase() === bot);
  if (!won) await release(card, botLogin);
  if (mutationError && !won) throw mutationError;
  return won;
}

/** Failures propagate; callers choosing best-effort cleanup must catch and warn. */
export async function release(card: Card, botLogin: string): Promise<void> {
  if (
    !isTargetIssue(
      card,
      card.repoOwner ?? "",
      card.repoName ?? "",
      card.closed ? undefined : "Task",
    )
  )
    return;
  requiredString(botLogin, "release login");
  await runGh([
    "issue",
    "edit",
    String(card.number),
    "--repo",
    `${card.repoOwner}/${card.repoName}`,
    "--remove-assignee",
    botLogin,
  ]);
}

export { runGh as _runGh, graphql as _graphql };

// ─────────────────────────────────────────────────────────────────────────────
// Explicit Project initialization and Issue comments
// ─────────────────────────────────────────────────────────────────────────────

export interface StandardFieldSpec {
  name: string;
  kind: "single";
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
  // Never rewrite an existing option list.
  const fields = await listProjectFields(meta.projectId);

  for (const spec of specs) {
    const found = fields.find(
      (field) => field.name.toLowerCase() === spec.name.toLowerCase(),
    );
    if (found) {
      // Never rewrite an existing option list: GitHub's mutation replaces it.
      existing.push(spec.name);
      continue;
    }
    await createField(meta.projectId, spec);
    created.push(spec.name);
  }

  // Board view grouped by Status (if a status field exists).
  try {
    await createBoardView(meta.projectId, viewName, meta.statusFieldId);
  } catch {
    // view creation is best-effort
  }
  return { created, existing };
}

async function listProjectFields(
  projectId: string,
): Promise<RawProject["fields"]> {
  const fields: RawProject["fields"] = [];
  const seen = new Set<string>();
  let after: string | null = null;
  while (true) {
    const data = await graphql<any>(
      `
      query($projectId: ID!, $after: String) {
        node(id: $projectId) { ... on ProjectV2 {
          fields(first: 100, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes {
              ... on ProjectV2SingleSelectField { id name dataType options { id name } }
              ... on ProjectV2Field { id name dataType }
              ... on ProjectV2IterationField { id name dataType }
            }
          }
        } }
      }`,
      { projectId, after },
    );
    const page = connectionPage(data?.node?.fields, "Project fields", seen);
    fields.push(...page.nodes);
    if (!page.next) break;
    after = page.next;
  }
  uniqueIds(fields, "Project field");
  const names = fields.map((field) =>
    requiredString(field.name, "Project field name").toLowerCase(),
  );
  if (new Set(names).size !== names.length)
    throw new Error("Ambiguous case-insensitive Project field names.");
  for (const field of fields) {
    if (field.options === undefined) continue;
    if (!Array.isArray(field.options))
      throw new Error("Invalid Project field options.");
    uniqueIds(field.options, "Project option");
    const names = field.options.map((option) =>
      requiredString(option.name, "option name").toLowerCase(),
    );
    if (new Set(names).size !== names.length)
      throw new Error(`Ambiguous options on Project field '${field.name}'.`);
  }
  return fields;
}

/** Create a field, including all options for a new single-select field. */
async function createField(
  projectId: string,
  spec: StandardFieldSpec,
): Promise<string> {
  if (!spec.options || spec.options.length === 0) {
    throw new Error(
      `Single-select field '${spec.name}' needs at least one option.`,
    );
  }
  const literals = spec.options
    .map(
      (name, i) =>
        `{ name: ${JSON.stringify(name)}, color: ${fieldColor(spec, i)}, description: "" }`,
    )
    .join(", ");
  const mutation = `
    mutation($projectId: ID!, $name: String!) {
      createProjectV2Field(input: {
        projectId: $projectId
        name: $name
        dataType: SINGLE_SELECT
        singleSelectOptions: [${literals}]
      }) {
        projectV2Field { ... on ProjectV2SingleSelectField { id } }
      }
    }`;
  const data = await graphql<any>(mutation, { projectId, name: spec.name });
  return requiredString(
    data?.createProjectV2Field?.projectV2Field?.id,
    "created Project field id",
  );
}

function fieldColor(spec: StandardFieldSpec, i: number): string {
  const palette = [
    "GRAY",
    "BLUE",
    "YELLOW",
    "ORANGE",
    "PURPLE",
    "GREEN",
    "PINK",
    "RED",
  ];
  return spec.colors?.[i] ?? palette[i % palette.length];
}

async function createBoardView(
  projectId: string,
  name: string,
  groupByFieldId: string,
): Promise<void> {
  const mutation = `
    mutation($projectId: ID!, $name: String!, $layout: ProjectV2ViewLayout!, $groupBy: [ID!]!) {
      createProjectV2View(input: { projectId: $projectId, name: $name, layout: $layout, groupBy: $groupBy }) {
        projectV2View { id name }
      }
    }`;
  await graphql(mutation, {
    projectId,
    name,
    layout: "BOARD_LAYOUT",
    groupBy: [groupByFieldId],
  });
}

/** Resolve issue node id from owner/name/number. */
export async function resolveIssueId(
  repoOwner: string,
  repoName: string,
  number: number,
): Promise<string> {
  const query = `
    query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) { issue(number: $number) { id } }
    }`;
  const data = await graphql<any>(query, {
    owner: repoOwner,
    name: repoName,
    number,
  });
  return requiredString(data?.repository?.issue?.id, "Issue id");
}

/** Post a comment on an issue. Returns the comment node id. */
export async function createComment(
  issueId: string,
  body: string,
): Promise<string> {
  requiredString(issueId, "comment subject id");
  requiredString(body, "comment body");
  const mutation = `
    mutation($issueId: ID!, $body: String!) {
      addComment(input: { subjectId: $issueId, body: $body }) { commentEdge { node { id } } }
    }`;
  const data = await graphql<any>(mutation, { issueId, body });
  return requiredString(
    data?.addComment?.commentEdge?.node?.id,
    "created comment id",
  );
}

/** Reopening is a handoff write, never approval or a builder launch. */
export async function reopenIssue(issueId: string): Promise<void> {
  requiredString(issueId, "issue id");
  const data = await graphql<any>(
    `mutation($id: ID!) {
    reopenIssue(input: { issueId: $id }) { issue { id closed } }
  }`,
    { id: issueId },
  );
  if (
    data?.reopenIssue?.issue?.id !== issueId ||
    data.reopenIssue.issue.closed !== false
  )
    throw new Error("GitHub returned unconfirmed issue reopen.");
}

export interface IssueComment {
  id: string;
  body: string;
  createdAt: string;
  author?: string;
  authorAssociation?: string;
}

/** List every comment of an issue (ascending). */
export async function listIssueComments(
  repoOwner: string,
  repoName: string,
  number: number,
): Promise<IssueComment[]> {
  const comments: IssueComment[] = [];
  const seen = new Set<string>();
  let after: string | null = null;
  while (true) {
    const data = await graphql<any>(
      `
      query($owner: String!, $name: String!, $number: Int!, $after: String) {
        repository(owner: $owner, name: $name) {
          issue(number: $number) {
            comments(first: 100, after: $after) {
              pageInfo { hasNextPage endCursor }
              nodes { id body createdAt authorAssociation author { login } }
            }
          }
        }
      }`,
      { owner: repoOwner, name: repoName, number, after },
    );
    const page = connectionPage(
      data?.repository?.issue?.comments,
      `comment pagination for ${repoOwner}/${repoName}#${number}`,
      seen,
    );
    for (const node of page.nodes)
      comments.push({ ...node, author: node.author?.login });
    if (!page.next) break;
    after = page.next;
  }
  return validateComments(comments);
}

function validateComments(comments: IssueComment[]): IssueComment[] {
  uniqueIds(comments, "comment");
  for (const comment of comments) {
    if (
      typeof comment.body !== "string" ||
      typeof comment.createdAt !== "string" ||
      !Number.isFinite(Date.parse(comment.createdAt)) ||
      (comment.author != null && typeof comment.author !== "string") ||
      (comment.authorAssociation != null &&
        typeof comment.authorAssociation !== "string")
    )
      throw new Error("GitHub returned an invalid comment.");
  }
  return comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
