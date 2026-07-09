#!/usr/bin/env tsx
/**
 * Ingest pages from PAGES_DIR into the Neo4j graph.
 *
 * Pass 1 (no LLM): build the structural layer — Page nodes and LINKS_TO edges
 *   derived from wikilinks in the page content. Links are re-derived on every
 *   run, so edits to the source never leave stale edges.
 *
 * Pass 2 (LLM): for each page whose annotation is missing or stale (content
 *   changed since it was written — tracked via contentHash), ask the LLM for a
 *   one-liner and 2–6 ephemeral entities (Concept/Person/Technology/Team), then
 *   write the Entity nodes and typed page→entity edges (USES, OWNED_BY, …).
 *   Ingest is incremental: pages with an up-to-date annotation are skipped.
 *
 * Flags:
 *   --delay <seconds>   Wait between LLM calls (default: 3). Helps with rate limits.
 *   --limit <n>         Only annotate the first n stale pages (default: all).
 */
import "dotenv/config";
import chalk from "chalk";
import {
  setupConstraints, upsertPage, linkPages, clearPageLinks,
  upsertEntity, linkPageToEntity, clearPageEntityEdges, deleteOrphanEntities,
  getAllPageIds, getPageById, getEntityCatalog, closeDriver,
  type EntityCatalogEntry,
} from "./graph.js";
import { getAllPageFiles, parsePage, hashContent } from "./pages.js";
import { analyzePage } from "./llm.js";
import { cleanName, entityKey } from "./normalize.js";
import type { Page } from "./models.js";

const flags = parseFlags(process.argv.slice(2));
const DELAY_MS = (flags["delay"] ?? 3) * 1000;
const LIMIT = flags["limit"] ?? Infinity;

function parseFlags(argv: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--") && argv[i + 1]) {
      out[argv[i].slice(2)] = parseFloat(argv[i + 1]);
    }
  }
  return out;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// Demo pages are small (~1–2 KB), so we send the whole body to the annotation
// pass: people, teams and technologies that make the ephemeral bridges often live
// further down the page (e.g. a "## Team" section). The cap is a safety net for
// unexpectedly large pages. For a very large corpus, lower this to control tokens.
const SNIPPET_CHARS = 4000;

function buildSnippet(title: string, tags: string[], content: string): string {
  const tagLine = tags.length ? `Tags: ${tags.join(", ")}` : "";
  const body = content.slice(0, SNIPPET_CHARS).trim();
  return [title, tagLine, body].filter(Boolean).join("\n");
}

// A page that pass 2 must (re-)annotate.
type StalePage = {
  page: Page;
  content: string;
  tags: string[];
  hash: string;
  reannotate: boolean; // had an annotation, but the content changed since
};

// ── Entity reuse hint ────────────────────────────────────────────────────────
// The LLM can only reuse entities it is shown, but pasting the whole catalog
// into the prompt stops working past a few dozen entities. Instead we show it
// the entities whose name (or alias) literally appears in the page — for
// People/Technologies/Teams a reuse is almost always a literal mention — plus
// the most-connected entities for concept-level reuse. Deterministic, no extra
// LLM calls, and the hint stays small however large the graph grows.
const HINT_MATCHED_MAX = 30;
const HINT_HUBS = 10;

function mentions(haystack: string, key: string): boolean {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "u").test(haystack);
}

function buildEntityHint(content: string, catalog: EntityCatalogEntry[]): string[] {
  const haystack = entityKey(content);
  const matched: string[] = [];
  for (const e of catalog) {         // catalog is most-connected first
    if (matched.length >= HINT_MATCHED_MAX) break;
    const keys = [e.key, ...e.aliases.map(entityKey)];
    if (keys.some((k) => k && mentions(haystack, k))) matched.push(e.name);
  }
  const hubs = catalog
    .slice(0, HINT_HUBS)
    .map((e) => e.name)
    .filter((n) => !matched.includes(n));
  return [...matched, ...hubs];
}

async function main() {
  console.log(chalk.bold("\n── Confluence Graph — Ingest ──\n"));

  await setupConstraints();

  const files = getAllPageFiles();
  if (!files.length) {
    console.log(chalk.yellow("No pages found. Check PAGES_DIR in your .env file."));
    return;
  }
  console.log(chalk.dim(`Found ${files.length} pages in PAGES_DIR\n`));

  // ── Pass 1: structural layer ─────────────────────────────────────────────

  const stale: StalePage[] = [];
  let upToDate = 0;
  const wikilinkMap = new Map<string, string[]>();

  for (const file of files) {
    const { page, wikilinks, content, tags } = parsePage(file);
    const hash = hashContent(content);

    // Decide pass-2 work from the state stored at the last annotation —
    // read BEFORE the upsert below refreshes the node.
    const stored = await getPageById(page.id);
    const hasAnnotation = Boolean(stored?.oneLiner);
    if (hasAnnotation && stored?.contentHash === hash) {
      upToDate++;
    } else if (content) {
      stale.push({ page, content, tags, hash, reannotate: hasAnnotation });
    }

    page.content = content;        // store the full body on the node
    wikilinkMap.set(page.id, wikilinks);
    await upsertPage(page);
  }

  const allIds = new Set(await getAllPageIds());
  // Wikilinks usually carry just a filename ([[project-atlas]]) while page ids
  // are full PAGES_DIR-relative paths — resolve by unique basename.
  const byBasename = new Map<string, string[]>();
  for (const pid of allIds) {
    const base = pid.split("/").pop()!;
    byBasename.set(base, [...(byBasename.get(base) ?? []), pid]);
  }
  const resolveTarget = (target: string): string | undefined => {
    if (allIds.has(target)) return target;
    const candidates = byBasename.get(target) ?? [];
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) {
      console.log(chalk.yellow(`  ! [[${target}]] is ambiguous (${candidates.join(", ")}) — link skipped`));
    }
    return undefined;
  };

  for (const [id, links] of wikilinkMap) {
    await clearPageLinks(id);
    for (const target of links) {
      const resolved = resolveTarget(target);
      if (resolved && resolved !== id) await linkPages(id, resolved);
    }
  }

  console.log(chalk.green(`✓ Structural layer: ${files.length} pages, links wired\n`));

  // ── Pass 2: LLM annotation layer ─────────────────────────────────────────

  const catalog = await getEntityCatalog();
  // Canonical keys AND alias keys resolve to their catalog entry, so an LLM
  // that says "K8s" links to the existing "Kubernetes" node after a lint merge.
  const keyIndex = new Map<string, EntityCatalogEntry>();
  const indexEntry = (e: EntityCatalogEntry) => {
    keyIndex.set(e.key, e);
    for (const a of e.aliases) keyIndex.set(entityKey(a), e);
  };
  catalog.forEach(indexEntry);
  let annotated = 0;

  for (const { page, content, tags, hash, reannotate } of stale) {
    if (annotated >= LIMIT) break;

    console.log(chalk.dim(`  ${page.title}...`));

    try {
      const snippet = buildSnippet(page.title, tags, content);
      const hint = buildEntityHint(content, catalog);
      const analysis = await analyzePage(page.id, page.title, snippet, hint);

      // Only after a successful analysis: drop edges from the old version of
      // the content, then record the new annotation as current.
      if (reannotate) await clearPageEntityEdges(page.id);

      page.oneLiner = analysis.oneLiner;
      page.contentHash = hash;
      await upsertPage(page);

      for (const entity of analysis.entities) {
        if (!entity.name.trim()) continue;
        // Reuse vs new is decided by canonical (or alias) key. New entities
        // join the in-memory catalog so later pages in this run can match them.
        const key = entityKey(entity.name);
        let canonical = keyIndex.get(key);
        const reused = Boolean(canonical);
        if (!canonical) {
          canonical = {
            name: cleanName(entity.name), key, kind: entity.kind,
            description: entity.description ?? "", aliases: [], pageCount: 0,
          };
          catalog.push(canonical);
          indexEntry(canonical);
          await upsertEntity({ name: entity.name, kind: entity.kind, description: entity.description ?? "" });
        }
        canonical.pageCount++;
        await linkPageToEntity(page.id, canonical.name, entity.relation);

        // Show the ephemeral layer being built — reused entities are how a new
        // page wires itself into the existing graph (the demo's "shared waypoints").
        const tag = reused ? chalk.cyan("↻ reuse") : chalk.green("+ new  ");
        console.log(
          `      ${tag} ${chalk.bold(canonical.name)} ${chalk.dim(`(${canonical.kind})`)} ` +
          chalk.dim(`—[${entity.relation}]→`)
        );
      }
      annotated++;
      if (DELAY_MS > 0) await sleep(DELAY_MS);
    } catch (err) {
      console.log(chalk.red(`✗ ${String(err).replace(/\s+/g, " ").slice(0, 160)}`));
    }
  }

  // Re-annotation can leave entities behind that no page references anymore.
  const orphans = await deleteOrphanEntities();
  if (orphans) console.log(chalk.dim(`\n  swept ${orphans} orphaned entities`));

  const summary = [`${annotated} annotated`];
  if (upToDate) summary.push(`${upToDate} already up to date`);
  console.log(chalk.bold(`\n── Done: ${summary.join(", ")} ──\n`));

  await closeDriver();
}

main().catch((err) => {
  console.error(chalk.red(String(err)));
  process.exit(1);
});
