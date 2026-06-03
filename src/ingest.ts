#!/usr/bin/env tsx
/**
 * Ingest pages from PAGES_DIR into the Neo4j graph.
 *
 * Pass 1 (no LLM): build the structural layer — Page nodes and LINKS_TO edges
 *   derived from wikilinks in the page content.
 *
 * Pass 2 (LLM): for each page not yet annotated, ask the LLM for a one-liner
 *   and 2–5 concept tags, then write Concept nodes and ABOUT edges.
 *
 * Flags:
 *   --delay <seconds>   Wait between LLM calls (default: 3). Helps with rate limits.
 *   --limit <n>         Only annotate the first n unannotated pages (default: all).
 */
import "dotenv/config";
import chalk from "chalk";
import {
  setupConstraints, upsertPage, linkPages,
  upsertConcept, linkPageToConcept,
  getAllPageIds, getPageById, listConcepts, closeDriver,
} from "./graph.js";
import { getAllPageFiles, parsePage } from "./pages.js";
import { analyzePage } from "./llm.js";

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

function buildSnippet(title: string, tags: string[], content: string): string {
  const tagLine = tags.length ? `Tags: ${tags.join(", ")}` : "";
  const body = content.slice(0, 300).replace(/\n+/g, " ").trim();
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
    const { page, wikilinks } = parsePage(file);
    wikilinkMap.set(page.id, wikilinks);
    await upsertPage(page);
  }

  const allIds = new Set(await getAllPageIds());
  for (const [slug, links] of wikilinkMap) {
    for (const target of links) {
      if (allIds.has(target) && target !== slug) {
        await linkPages(slug, target);
      }
    }
  }

  console.log(chalk.green(`✓ Structural layer: ${files.length} pages, links wired\n`));

  // ── Pass 2: LLM annotation layer ─────────────────────────────────────────

  const existingConcepts = (await listConcepts()).map((c) => c.name);
  let annotated = 0;
  let skipped = 0;

  for (const file of files) {
    if (annotated >= LIMIT) break;

    const { page, content, tags } = parsePage(file);
    if (!content) continue;

    const stored = await getPageById(page.id);
    if (stored?.oneLiner) { skipped++; continue; }

    process.stdout.write(chalk.dim(`  ${page.title}... `));

    try {
      const snippet = buildSnippet(page.title, tags, content);
      const analysis = await analyzePage(page.id, page.title, snippet, existingConcepts);

      page.oneLiner = analysis.oneLiner;
      await upsertPage(page);

      for (const concept of analysis.concepts) {
        if (!concept.name) continue;
        if (concept.isNew) existingConcepts.push(concept.name);
        await upsertConcept({ name: concept.name, description: concept.description ?? "" });
        await linkPageToConcept(page.id, concept.name);
      }

      console.log(chalk.green("✓"));
      annotated++;
      if (DELAY_MS > 0) await sleep(DELAY_MS);
    } catch (err) {
      console.log(chalk.red(`✗ ${String(err).split("\n")[0]}`));
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
