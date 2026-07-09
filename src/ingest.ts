#!/usr/bin/env tsx
/**
 * Ingest pages from PAGES_DIR into the Neo4j graph.
 *
 * Pass 1 (no LLM): build the structural layer — Page nodes and LINKS_TO edges
 *   derived from wikilinks in the page content.
 *
 * Pass 2 (LLM): for each page not yet annotated, ask the LLM for a one-liner
 *   and 2–6 ephemeral entities (Concept/Person/Technology/Team), then write the
 *   Entity nodes and typed page→entity edges (USES, OWNED_BY, MENTIONS, …).
 *
 * Flags:
 *   --delay <seconds>   Wait between LLM calls (default: 3). Helps with rate limits.
 *   --limit <n>         Only annotate the first n unannotated pages (default: all).
 */
import "dotenv/config";
import chalk from "chalk";
import {
  setupConstraints, upsertPage, linkPages,
  upsertEntity, linkPageToEntity,
  getAllPageIds, getPageById, getAllEntityNames, closeDriver,
} from "./graph.js";
import { getAllPageFiles, parsePage } from "./pages.js";
import { analyzePage } from "./llm.js";
import { cleanName, entityKey } from "./normalize.js";

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

  const wikilinkMap = new Map<string, string[]>();
  for (const file of files) {
    const { page, wikilinks, content } = parsePage(file);
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
    for (const target of links) {
      const resolved = resolveTarget(target);
      if (resolved && resolved !== id) await linkPages(id, resolved);
    }
  }

  console.log(chalk.green(`✓ Structural layer: ${files.length} pages, links wired\n`));

  // ── Pass 2: LLM annotation layer ─────────────────────────────────────────

  const existingEntities = await getAllEntityNames();      // display names — the LLM reuse hint
  const seenKeys = new Set(existingEntities.map(entityKey)); // canonical keys — dedup decision
  let annotated = 0;
  let skipped = 0;

  for (const file of files) {
    if (annotated >= LIMIT) break;

    const { page, content, tags } = parsePage(file);
    if (!content) continue;

    const stored = await getPageById(page.id);
    if (stored?.oneLiner) { skipped++; continue; }

    console.log(chalk.dim(`  ${page.title}...`));

    try {
      const snippet = buildSnippet(page.title, tags, content);
      const analysis = await analyzePage(page.id, page.title, snippet, existingEntities);

      page.oneLiner = analysis.oneLiner;
      page.content = content;       // keep the node's textdump in sync
      await upsertPage(page);

      for (const entity of analysis.entities) {
        if (!entity.name.trim()) continue;
        // Reuse vs new is decided by canonical key, BEFORE recording the entity.
        const key = entityKey(entity.name);
        const reused = seenKeys.has(key);
        if (!reused) {
          seenKeys.add(key);
          existingEntities.push(cleanName(entity.name));
        }
        await upsertEntity({ name: entity.name, kind: entity.kind, description: entity.description ?? "" });
        await linkPageToEntity(page.id, entity.name, entity.relation);

        // Show the ephemeral layer being built — reused entities are how a new
        // page wires itself into the existing graph (the demo's "shared waypoints").
        const tag = reused ? chalk.cyan("↻ reuse") : chalk.green("+ new  ");
        console.log(
          `      ${tag} ${chalk.bold(entity.name)} ${chalk.dim(`(${entity.kind})`)} ` +
          chalk.dim(`—[${entity.relation}]→`)
        );
      }
      annotated++;
      if (DELAY_MS > 0) await sleep(DELAY_MS);
    } catch (err) {
      console.log(chalk.red(`✗ ${String(err).replace(/\s+/g, " ").slice(0, 160)}`));
    }
  }

  const summary = [`${annotated} annotated`];
  if (skipped) summary.push(`${skipped} already done`);
  console.log(chalk.bold(`\n── Done: ${summary.join(", ")} ──\n`));

  await closeDriver();
}

main().catch((err) => {
  console.error(chalk.red(String(err)));
  process.exit(1);
});
