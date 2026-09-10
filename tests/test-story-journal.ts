import assert from "node:assert/strict";
import {
  mkdtempSync,
  existsSync,
  symlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _DEFAULTS, type Config } from "../src/config.js";
import type { Card, ProjectMetadata } from "../src/gh.js";
import {
  createStoryCreationPlan,
  reconcileStoryCreation,
  RefineStateStore,
  storyIdentity,
  parseRefineOutput,
  type RefineOutput,
  type StoryCreationOps,
  type StoryCreationPlan,
} from "../src/refine.js";

const check = (ok: boolean, label: string) => {
  assert.ok(ok, label);
  console.log(`PASS: ${label}`);
};
const cfg: Config = { ..._DEFAULTS };
const meta: ProjectMetadata = {
  projectId: "P",
  statusFieldId: "STATUS",
  statusOptions: { Ready: "READY" },
  planFieldId: "PLAN",
  typeFieldId: "TYPE",
  typeOptions: { Task: "TASK", Story: "STORY" },
};
const storyCard: Card = {
  itemId: "STORY_ITEM",
  contentType: "Issue",
  number: 42,
  title: "Release 0.2.0",
  body: "Ship safely",
  status: cfg.columns.building,
  plan: "release-0.2.0",
  type: "Story",
  assignees: [],
  closed: false,
  repoOwner: "owner",
  repoName: "repo",
};
const refined: RefineOutput = {
  goal: "Ship safely",
  impactedAreas: ["src"],
  decisions: ["exact SHA"],
  risks: [],
  openQuestions: [],
  tasks: [
    { title: "First", acceptanceCriteria: ["one"] },
    { title: "Second", acceptanceCriteria: ["two"] },
  ],
};
const context = {
  cfg,
  meta,
  repoOwner: "owner",
  repoName: "repo",
  storyCard,
  projectId: "P",
  assertCurrent: async () => undefined,
};
const makePlan = () =>
  createStoryCreationPlan({
    cfg,
    meta,
    projectId: "P",
    storyCard,
    repoOwner: "owner",
    repoName: "repo",
    planSlug: "release-0.2.0",
    refine: refined,
    existingTaskCount: 0,
  });

type Operation = "create" | "add" | "status" | "plan" | "type";
type Timing = "before" | "after";

function harness(failure?: { operation: Operation; timing: Timing }) {
  const children: Array<{
    id: string;
    number: number;
    url: string;
    title: string;
    body: string;
    repoOwner: string;
    repoName: string;
    closed: boolean;
  }> = [];
  const itemByIssue = new Map<string, string>();
  const fields = new Map<
    string,
    { status?: string; plan?: string; type?: string }
  >();
  const calls = { create: 0, add: 0, status: 0, plan: 0, type: 0 };
  let fired = false;
  const fail = (operation: Operation, timing: Timing) => {
    if (
      !fired &&
      failure?.operation === operation &&
      failure.timing === timing
    ) {
      fired = true;
      throw new Error(`${operation} ${timing}`);
    }
  };
  const ops: StoryCreationOps = {
    listChildren: async () => structuredClone(children),
    resolveParent: async () => "PARENT",
    createChild: async (input) => {
      fail("create", "before");
      calls.create++;
      const issue = {
        id: `ISSUE_${calls.create}`,
        number: 100 + calls.create,
        url: `https://example.test/${100 + calls.create}`,
        title: input.title,
        body: input.body,
        repoOwner: input.repoOwner,
        repoName: input.repoName,
        closed: false,
      };
      children.push(issue);
      fail("create", "after");
      return issue;
    },
    findProjectItem: async (_projectId, issueId) => itemByIssue.get(issueId),
    addProjectItem: async (_projectId, issueId) => {
      fail("add", "before");
      calls.add++;
      const itemId = `ITEM_${issueId}`;
      itemByIssue.set(issueId, itemId);
      fields.set(itemId, {});
      fail("add", "after");
      return itemId;
    },
    readCard: async (itemId) => {
      const issueId = [...itemByIssue].find(([, item]) => item === itemId)?.[0];
      const issue = children.find((candidate) => candidate.id === issueId);
      const values = fields.get(itemId);
      if (!issue || !values) return undefined;
      return {
        itemId,
        contentType: "Issue",
        number: issue.number,
        title: issue.title,
        body: issue.body,
        status: values.status,
        plan: values.plan,
        type: values.type,
        assignees: [],
        closed: false,
        repoOwner: issue.repoOwner,
        repoName: issue.repoName,
      };
    },
    setSingle: async (_meta, itemId, fieldId, option) => {
      const operation: Operation = fieldId === "STATUS" ? "status" : "type";
      fail(operation, "before");
      calls[operation]++;
      const value = fields.get(itemId)!;
      if (operation === "status") value.status = option;
      else value.type = option;
      fail(operation, "after");
    },
    setText: async (_meta, itemId, _fieldId, value) => {
      fail("plan", "before");
      calls.plan++;
      fields.get(itemId)!.plan = value;
      fail("plan", "after");
    },
  };
  return { children, itemByIssue, fields, calls, ops };
}

for (const operation of ["create", "add", "status", "plan", "type"] as const) {
  for (const timing of ["before", "after"] as const) {
    const h = harness({ operation, timing });
    let creation = makePlan();
    let durable = structuredClone(creation);
    const persist = () => {
      durable = structuredClone(creation);
    };
    let failed = false;
    try {
      await reconcileStoryCreation(context, creation, persist, h.ops);
    } catch {
      failed = true;
    }
    creation = structuredClone(durable);
    if (
      timing === "before" &&
      (operation === "create" || operation === "add")
    ) {
      const calls = structuredClone(h.calls);
      await assert.rejects(
        () => reconcileStoryCreation(context, creation, persist, h.ops),
        /Cannot confirm prior/,
      );
      assert.deepEqual(
        h.calls,
        calls,
        "unconfirmed non-idempotent operation is not blindly retried",
      );
      check(
        failed,
        `${operation} before-side-effect failure requires explicit reconciliation, not a duplicate-capable retry`,
      );
      continue;
    }
    const created = await reconcileStoryCreation(
      context,
      creation,
      persist,
      h.ops,
    );
    check(
      failed &&
        created.length === 2 &&
        h.children.length === 2 &&
        h.itemByIssue.size === 2 &&
        [...h.fields.values()].every(
          (field) =>
            field.status === cfg.columns.ready &&
            field.plan === "release-0.2.0" &&
            field.type === "Task",
        ),
      `${operation} ${timing}-side-effect crash retries without duplicates`,
    );
  }
}

{
  const h = harness();
  const creation = makePlan();
  h.children.push(
    {
      id: "A",
      number: 501,
      url: "https://example.test/501",
      title: "A",
      body: creation.tasks[0].marker,
      repoOwner: "owner",
      repoName: "repo",
      closed: false,
    },
    {
      id: "B",
      number: 502,
      url: "https://example.test/502",
      title: "B",
      body: creation.tasks[0].marker,
      repoOwner: "owner",
      repoName: "repo",
      closed: false,
    },
  );
  let failed = false;
  try {
    await reconcileStoryCreation(context, creation, () => undefined, h.ops);
  } catch {
    failed = true;
  }
  check(
    failed && h.calls.create === 0,
    "ambiguous child markers fail closed before mutation",
  );
}

{
  const h = harness();
  const creation: StoryCreationPlan = makePlan();
  h.children.push({
    id: "FOREIGN",
    number: 600,
    url: "https://example.test/600",
    title: "Foreign",
    body: creation.tasks[0].marker,
    repoOwner: "other",
    repoName: "repo",
    closed: false,
  });
  const created = await reconcileStoryCreation(
    context,
    creation,
    () => undefined,
    h.ops,
  );
  check(
    created.length === 2 &&
      h.children.filter((child) => child.repoOwner === "owner").length === 2,
    "cross-repository marker collisions are never adopted",
  );
}

const markers = makePlan().tasks;
check(
  new Set(markers.map((task) => task.marker)).size === markers.length &&
    markers.every((task) => task.body.includes(task.marker)),
  "child markers are deterministic, unique, and embedded before creation",
);

// A syntactically valid JSON file must not bypass the durable trust boundary.
{
  const cwd = mkdtempSync(join(tmpdir(), "story-journal-invalid-"));
  try {
    const store = new RefineStateStore(cwd);
    const file = join(cwd, ".pi", "board-agent", "refine-state.json");
    writeFileSync(
      file,
      JSON.stringify({ 42: { refined: "false", creation: {} } }),
    );
    assert.throws(() => store.load(), /Invalid story journal/);
    console.log("PASS: malformed nested Story journals fail closed before use");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

{
  const cwd = mkdtempSync(join(tmpdir(), "story-journal-validation-"));
  try {
    const store = new RefineStateStore(cwd);
    const file = join(cwd, ".pi", "board-agent", "refine-state.json");
    const state = {
      42: {
        identity: storyIdentity(storyCard, "P"),
        refined: false,
        creation: makePlan(),
      },
    };
    store.save(state);
    assert.deepEqual(new RefineStateStore(cwd).get(42), state[42]);
    const corruptions: [string, (state: any) => void][] = [
      [
        "root issue key",
        (s) => {
          s.invalid = s[42];
        },
      ],
      [
        "unknown entry",
        (s) => {
          s[42].inflight = {};
        },
      ],
      [
        "unbound identity",
        (s) => {
          delete s[42].identity;
        },
      ],
      [
        "cross project",
        (s) => {
          s[42].creation.projectId = "OTHER";
        },
      ],
      [
        "cross repository",
        (s) => {
          s[42].creation.repoOwner = "OTHER";
        },
      ],
      [
        "issue replacement",
        (s) => {
          s[42].creation.storyNumber = 43;
        },
      ],
      [
        "unsupported schema",
        (s) => {
          s[42].creation.schemaVersion = 2;
        },
      ],
      [
        "task index",
        (s) => {
          s[42].creation.tasks[0].index = 3;
        },
      ],
      [
        "digest",
        (s) => {
          s[42].creation.tasks[0].digest = "tampered";
        },
      ],
      [
        "marker",
        (s) => {
          s[42].creation.tasks[0].marker = "tampered";
        },
      ],
      [
        "criteria body",
        (s) => {
          s[42].creation.tasks[0].body += "tampered";
        },
      ],
      [
        "title",
        (s) => {
          s[42].creation.tasks[0].title = "tampered";
        },
      ],
      [
        "duplicate key",
        (s) => {
          s[42].creation.tasks[1].taskKey = "T001";
        },
      ],
      [
        "partial identity",
        (s) => {
          s[42].creation.tasks[0].issueId = "I";
        },
      ],
      [
        "publication without fields",
        (s) => {
          s[42].creation.tasks[0].statusSet = true;
        },
      ],
      [
        "nonboolean progress",
        (s) => {
          s[42].creation.tasks[0].createAttempted = "false";
        },
      ],
      [
        "unknown progress",
        (s) => {
          s[42].creation.tasks[0].legacy = true;
        },
      ],
      [
        "empty output",
        (s) => {
          s[42].creation.refine.tasks = [];
        },
      ],
      [
        "invalid criterion",
        (s) => {
          s[42].creation.refine.tasks[0].acceptanceCriteria = [42];
        },
      ],
      [
        "unknown output field",
        (s) => {
          s[42].creation.refine.extra = true;
        },
      ],
      [
        "false completion",
        (s) => {
          s[42].refined = true;
        },
      ],
      [
        "duplicate Issue",
        (s) => {
          s[42].creation.tasks.forEach((task: any) =>
            Object.assign(task, {
              issueId: "I",
              number: 100,
              url: "https://example.test/100",
            }),
          );
        },
      ],
    ];
    for (const [label, corrupt] of corruptions) {
      const invalid = structuredClone(state);
      corrupt(invalid);
      writeFileSync(file, JSON.stringify(invalid));
      assert.throws(() => store.load(), /Invalid story journal/, label);
    }
    console.log(
      "PASS: nested schema, identity, deterministic intent, progress, uniqueness, and completion corruption all fail closed on durable reload",
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

for (const value of [
  { ...refined, tasks: [] },
  { ...refined, tasks: [{ title: "", acceptanceCriteria: ["x"] }] },
  { ...refined, tasks: [{ title: "x", acceptanceCriteria: [] }] },
  { ...refined, tasks: [{ title: "x", acceptanceCriteria: [null] }] },
  { ...refined, openQuestions: [42] },
  { ...refined, tasks: Array(13).fill(refined.tasks[0]) },
])
  assert.equal(parseRefineOutput(value), null);
console.log(
  "PASS: malformed refine output cannot silently truncate/drop tasks or acceptance criteria",
);

for (const [label, patch] of [
  ["missing", undefined],
  ["closed", { closed: true }],
  ["wrong Issue", { number: 999 }],
  ["wrong item", { itemId: "OTHER" }],
  ["wrong origin", { repoOwner: "OTHER" }],
  ["PR", { contentType: "PullRequest" }],
  ["Type", { type: "Story" }],
  ["Plan", { plan: "OTHER" }],
  ["claimed", { assignees: ["human"] }],
  ["advanced", { status: cfg.columns.building }],
  ["body", { body: "edited" }],
] as const) {
  const h = harness();
  const read = h.ops.readCard;
  h.ops.readCard = async (...args) =>
    patch === undefined
      ? undefined
      : ({ ...(await read(...args))!, ...patch } as Card);
  await assert.rejects(
    () => reconcileStoryCreation(context, makePlan(), () => undefined, h.ops),
    label,
  );
  assert.equal(
    h.calls.status + h.calls.plan + h.calls.type,
    0,
    `${label}: no child field mutation`,
  );
}
console.log(
  "PASS: every child mutation requires fresh expected open/unclaimed Issue, item, origin, Type, Plan, and contract",
);

for (const closed of [true, undefined]) {
  const h = harness();
  const list = h.ops.listChildren;
  // Deliberately inject malformed API data as well as a valid closed Issue.
  h.ops.listChildren = async (...args) =>
    (await list(...args)).map((child) => ({ ...child, closed })) as Awaited<
      ReturnType<typeof list>
    >;
  await assert.rejects(
    () => reconcileStoryCreation(context, makePlan(), () => undefined, h.ops),
    /not confirmed open/,
  );
  assert.equal(h.calls.add, 0);
}
console.log(
  "PASS: closed or unreadable child open-state blocks Project add before any Project mutation",
);

{
  const h = harness();
  const setPlan = h.ops.setText;
  h.ops.setText = async (...args) => {
    await setPlan(...args);
    h.fields.get(args[1])!.plan = "moved-by-human";
  };
  await assert.rejects(
    () => reconcileStoryCreation(context, makePlan(), () => undefined, h.ops),
    /expected child/,
  );
  assert.equal(h.calls.type, 0);
  assert.equal(h.calls.status, 0);
  console.log(
    "PASS: Plan drift after its write prevents the next Type/Ready mutations",
  );
}

{
  const cwd = mkdtempSync(join(tmpdir(), "story-journal-link-"));
  const target = mkdtempSync(join(tmpdir(), "story-journal-target-"));
  try {
    symlinkSync(target, join(cwd, ".pi"), "junction");
    assert.throws(() => new RefineStateStore(cwd), /symlinked Story journal/);
    assert.equal(existsSync(join(target, "board-agent")), false);
    console.log(
      "PASS: symlinked/junction runtime state is rejected before writing outside the repository",
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
}
