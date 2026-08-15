/**
 * Deterministic repo context digest for builder agents (Phase B — basic).
 *
 * Generates a compact markdown "map" of the repository so builders start
 * oriented WITHOUT exploring the whole tree: pruned file tree, per-file
 * exported symbols, key package.json scripts, AGENTS.md/README, recent
 * conventional commits. Zero LLM tokens to produce; target well under
 * ~5K tokens (maxChars).
 *
 * Regenerated when the git HEAD (or the config) changes — cached under
 * .pi/board-agent/context.md with a .hash marker.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

export interface ContextOptions {
  cwd: string;
  maxChars: number;
  exclude: string[];
}

const DEFAULT_EXCLUDE = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".expo",
  ".vercel",
  ".maestro",
  "playwright-report",
  "test-results",
  ".pi",
  ".specify",
  ".claude",
  "*.lock",
  "*.png",
  "*.jpg",
  "*.jpeg",
  "*.gif",
  "*.webp",
  "*.ico",
  "*.woff",
  "*.woff2",
  "*.ttf",
  "*.otf",
  "*.pdf",
  "*.apk",
  "*.aab",
  "*.keystore",
  "*.p12",
  "*.mobileprovision",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);

function isExcluded(relPath: string, opts: ContextOptions): boolean {
  for (const seg of relPath.split(/[/\\]/)) {
    if (DEFAULT_EXCLUDE.has(seg)) return true;
  }
  const base = relPath.split(/[/\\]/).pop() ?? relPath;
  for (const pattern of DEFAULT_EXCLUDE) {
    if (pattern.startsWith("*") && base.endsWith(pattern.slice(1))) return true;
  }
  for (const pattern of opts.exclude) {
    if (pattern.startsWith("*") && base.endsWith(pattern.slice(1))) return true;
    if (!pattern.includes("/") && pattern === base) return true;
    if (relPath === pattern) return true;
  }
  return false;
}

interface FileEntry {
  path: string;
  lines: number;
  size: number;
}

function collectFiles(root: string, opts: ContextOptions): FileEntry[] {
  const out: FileEntry[] = [];
  const walk = (dir: string) => {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      const rel = relative(root, full);
      if (isExcluded(rel, opts)) continue;
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
      } else if (st.isFile() && st.size <= 300_000) {
        let lines = 0;
        try {
          lines = readFileSync(full, "utf8").split("\n").length;
        } catch {
          lines = 0;
        }
        out.push({ path: rel, lines, size: st.size });
      }
    }
  };
  walk(root);
  return out;
}

const SYMBOL_RE =
  /export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;

/** Extract exported symbols + leading comment from a ts/tsx file. */
function extractSymbols(file: string): { symbols: string[]; head: string } {
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { symbols: [], head: "" };
  }
  const symbols: string[] = [];
  const m = text.matchAll(SYMBOL_RE);
  for (const hit of m) {
    const name = hit[1];
    if (!symbols.includes(name)) symbols.push(name);
  }
  // Leading comment: first contiguous // or /* */ lines at the top (max 6).
  const headLines: string[] = [];
  const lines = text.split("\n");
  let inBlock = false;
  for (const line of lines.slice(0, 40)) {
    const t = line.trim();
    if (t.startsWith("/*")) inBlock = true;
    if (inBlock || t.startsWith("//")) {
      headLines.push(t.replace(/^\/\*+|\*+\/$/g, "").trim().replace(/^\*+ ?/, ""));
      if (headLines.length >= 6) break;
    }
    if (t.includes("*/")) inBlock = false;
    if (!t.startsWith("//") && !inBlock && headLines.length > 0) break;
  }
  return {
    symbols: symbols.slice(0, 20),
    head: headLines.filter(Boolean).join(" · ").slice(0, 160),
  };
}

function gitLog(cwd: string): string[] {
  const res = spawnSync(
    "git",
    ["log", "--pretty=format:%s", "-30"],
    { cwd, encoding: "utf-8" },
  );
  if (res.status !== 0) return [];
  return res.stdout.split("\n").filter(Boolean);
}

function groupCommits(commits: string[]): string {
  const groups = new Map<string, string[]>();
  for (const c of commits) {
    const m = c.match(/^([a-z]+)(\([^)]*\))?!?:\s*(.+)/);
    const type = m ? m[1] : "other";
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type)!.push(m ? m[3] : c);
  }
  const out: string[] = [];
  for (const [type, items] of groups) {
    out.push(`- **${type}**: ${items.slice(0, 8).join("; ")}`);
  }
  return out.join("\n");
}

function readHead(cwd: string): string {
  const res = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd,
    encoding: "utf-8",
  });
  return res.status === 0 ? res.stdout.trim() : "no-git";
}

/** Generate the context digest (pure, no cache). */
export function renderContext(opts: ContextOptions): string {
  const { cwd } = opts;
  const files = collectFiles(cwd, opts);
  const sections: string[] = [];

  // 1) Tree overview
  const byDir = new Map<string, number>();
  for (const f of files) {
    const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : ".";
    byDir.set(dir, (byDir.get(dir) ?? 0) + 1);
  }
  const treeLines = Array.from(byDir.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([dir, n]) => `- \`${dir}/\` — ${n} file`);
  sections.push(`## Repo tree (${files.length} files)\n\n${treeLines.join("\n")}`);

  // 2) File inventory with symbols (ts/tsx/js/jsx only)
  const codeFiles = files.filter((f) =>
    /\.(ts|tsx|js|jsx)$/.test(f.path),
  );
  const inv: string[] = [];
  for (const f of codeFiles.slice(0, 150)) {
    const { symbols, head } = extractSymbols(join(cwd, f.path));
    const sym = symbols.length ? ` exports: ${symbols.join(", ")}` : "";
    const hd = head ? ` — ${head}` : "";
    inv.push(`- \`${f.path}\` (${f.lines} lines)${sym}${hd}`);
  }
  if (inv.length) sections.push(`## Source files\n\n${inv.join("\n")}`);

  // 3) AGENTS.md + README (up to 6KB each)
  for (const doc of ["AGENTS.md", "README.md"]) {
    const p = join(cwd, doc);
    if (existsSync(p)) {
      const text = readFileSync(p, "utf8").slice(0, 6000);
      sections.push(`## ${doc}\n\n${text}`);
    }
  }

  // 4) package.json scripts (root + apps/*)
  const pkgLines: string[] = [];
  for (const p of ["package.json", "apps/web/package.json", "apps/api/package.json", "apps/mobile/package.json"]) {
    const pj = join(cwd, p);
    if (!existsSync(pj)) continue;
    try {
      const json = JSON.parse(readFileSync(pj, "utf8"));
      const scripts = Object.keys(json.scripts ?? {})
        .map((k) => `${k}=${json.scripts[k]}`)
        .join(" | ");
      pkgLines.push(`- \`${p}\` scripts: ${scripts}`);
    } catch {
      /* ignore */
    }
  }
  if (pkgLines.length) sections.push(`## Scripts\n\n${pkgLines.join("\n")}`);

  // 5) Recent commits
  const commits = gitLog(cwd);
  if (commits.length) {
    sections.push(`## Recent commits\n\n${groupCommits(commits)}`);
  }

  let text = sections.join("\n\n---\n\n");
  if (text.length > opts.maxChars) {
    text = `${text.slice(0, opts.maxChars)}\n\n…(truncated at ${opts.maxChars} chars)`;
  }
  return text;
}

const CACHE_DIR = ".pi/board-agent";
const CACHE_FILE = "context.md";
const CACHE_HASH = "context.hash";

/** Generate (or reuse cached) context digest. Returns the text. */
export function generateContext(opts: ContextOptions): string {
  const dir = resolve(opts.cwd, CACHE_DIR);
  mkdirSync(dir, { recursive: true });
  const head = readHead(opts.cwd);
  const hash = createHash("sha1")
    .update(head)
    .update(JSON.stringify({ maxChars: opts.maxChars, exclude: opts.exclude }))
    .digest("hex")
    .slice(0, 12);
  const hashFile = join(dir, CACHE_HASH);
  const cachePath = join(dir, CACHE_FILE);

  if (existsSync(cachePath) && existsSync(hashFile)) {
    try {
      if (readFileSync(hashFile, "utf8") === hash) {
        return readFileSync(cachePath, "utf8");
      }
    } catch {
      /* fall through */
    }
  }

  const text = renderContext(opts);
  writeFileSync(cachePath, text, "utf8");
  writeFileSync(hashFile, hash, "utf8");
  return text;
}
