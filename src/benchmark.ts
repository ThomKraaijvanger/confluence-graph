#!/usr/bin/env tsx
/**
 * Benchmark: graph agent vs. the naive "read everything" baseline, same model.
 *
 *   1. Generate a corpus:   npx tsx src/gen-corpus.ts --pages 400 --out corpus
 *   2. Ingest it (one-time): PAGES_DIR=corpus npm run ingest
 *   3. Run the benchmark:    npx tsx src/benchmark.ts --corpus corpus --q amir
 *
 * Measures, for the same question on the same model:
 *   • naive  – stuff every page into one prompt (tokens + latency, scaled across
 *              corpus sizes to show the linear growth → context-window cliff)
 *   • graph  – the tool-calling agent (tokens summed across turns + latency)
 * and recall against the generator's ground truth.
 *
 * The point: graph query cost is ~constant in corpus size; naive grows linearly.
 */
import "dotenv/config";
import chalk from "chalk";
import { readFileSync, readdirSync } from "fs";
import { join, basename } from "path";
import matter from "gray-matter";
import { runQueryAgent, naiveAnswer, type Usage } from "./llm.js";
import { closeDriver } from "./graph.js";

const flags = parseFlags(process.argv.slice(2));
const CORPUS = String(flags["corpus"] ?? "corpus");
const QKEY = String(flags["q"] ?? "amir"); // "amir" | "kafka"
const SKIP_GRAPH = "skip-graph" in flags; // validate the naive harness without an ingested graph

function parseFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) out[key] = argv[++i];
    else out[key] = "true"; // boolean flag
  }
  return out;
}

type CorpusPage = { path: string; slug: string; text: string };

function loadCorpus(dir: string): CorpusPage[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const slug = basename(f, ".md");
      const { content } = matter(readFileSync(join(dir, f), "utf-8"));
      return { path: f, slug, text: content.trim() };
    });
}

function dump(pages: CorpusPage[]): string {
  return pages.map((p) => `## path: ${p.path}\n${p.text}`).join("\n\n---\n\n");
}

// Fraction of expected tokens the answer actually surfaces.
function recall(answer: string, expected: string[]): { hit: number; total: number } {
  const a = answer.toLowerCase();
  const hit = expected.filter((e) => a.includes(e.toLowerCase())).length;
  return { hit, total: expected.length };
}

const fmtTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);

async function main() {
  const gt = JSON.parse(readFileSync(join(CORPUS, "_ground_truth.json"), "utf-8"));
  const pages = loadCorpus(CORPUS);
  const total = pages.length;

  const qmeta = QKEY === "kafka" ? gt.questions.kafka_consumer_team_leads : gt.questions.amir_works_on;
  const question: string = qmeta.question;
  const expected: string[] = QKEY === "kafka" ? qmeta.answerLeads : qmeta.answerPages;

  console.log(chalk.bold(`\n── Benchmark: ${QKEY} ──`));
  console.log(chalk.dim(`Corpus: ${total} pages   Question: ${question}`));
  console.log(chalk.dim(`Ground-truth expects ${expected.length} items.\n`));

  // ── Naive, scaled across sizes (shows linear growth) ──
  const sizes = [...new Set([25, 100, 200, total].filter((n) => n <= total))];
  console.log(chalk.bold("NAIVE (full-context, no graph) — cost grows with corpus size:"));
  console.log(chalk.dim("  pages   prompt tokens   latency"));
  let lastNaive: { usage: Usage; ms: number; rec: { hit: number; total: number } } | null = null;
  for (const n of sizes) {
    const subset = pages.slice(0, n);
    const r = await naiveAnswer(question, dump(subset));
    console.log(
      `  ${String(n).padStart(5)}   ${fmtTokens(r.usage.prompt).padStart(13)}   ${(r.ms / 1000).toFixed(1).padStart(6)}s`
    );
    // Recall only meaningful at full corpus (subsets physically omit answer pages).
    if (n === total) lastNaive = { usage: r.usage, ms: r.ms, rec: recall(r.answer, expected) };
  }

  if (SKIP_GRAPH) {
    console.log(chalk.yellow("\n(--skip-graph: naive harness only; ingest the corpus and drop the flag for the full comparison.)\n"));
    await closeDriver();
    return;
  }

  // ── Graph agent on the full ingested graph ──
  console.log(chalk.bold("\nGRAPH (tool-calling agent):"));
  let gUsage: Usage = { prompt: 0, completion: 0, total: 0 };
  let turns = 0;
  const t0 = Date.now();
  const answer = await runQueryAgent(
    question,
    (tool, args) => console.log(chalk.dim(`  [${tool}] ${JSON.stringify(args)}`)),
    (u) => { gUsage = { prompt: gUsage.prompt + u.prompt, completion: gUsage.completion + u.completion, total: gUsage.total + u.total }; turns++; }
  );
  const gMs = Date.now() - t0;
  const gRec = recall(answer, expected);

  // ── Verdict ──
  console.log(chalk.bold("\n── Result (full corpus, same model) ──"));
  if (lastNaive) {
    console.log(`  naive:  ${fmtTokens(lastNaive.usage.total).padStart(7)} tokens   ${(lastNaive.ms / 1000).toFixed(1)}s   recall ${lastNaive.rec.hit}/${lastNaive.rec.total}`);
  }
  console.log(`  graph:  ${fmtTokens(gUsage.total).padStart(7)} tokens   ${(gMs / 1000).toFixed(1)}s   recall ${gRec.hit}/${gRec.total}   (${turns} turns)`);
  if (lastNaive && gUsage.total > 0) {
    console.log(chalk.green(`\n  → graph used ${(lastNaive.usage.total / gUsage.total).toFixed(1)}x fewer tokens, ` +
      `${(lastNaive.ms / gMs).toFixed(1)}x faster, on the same model.`));
  }
  console.log(chalk.dim("\n  Naive cost grows with every page added to the wiki; the graph agent\n  pulls a fixed neighborhood, so its cost barely moves as the wiki grows.\n"));

  await closeDriver();
}

main().catch((err) => { console.error(chalk.red(String(err))); process.exit(1); });
