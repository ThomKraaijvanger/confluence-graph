#!/usr/bin/env tsx
/**
 * Graph healthcheck: find semantically duplicate entities and merge them.
 *
 * Deterministic normalization (normalize.ts) already folds case/whitespace
 * variants at ingest time, but it cannot know that "K8s" is "Kubernetes" —
 * that needs meaning. This pass shows the LLM every entity of one kind and
 * asks for merge groups, validates the proposals against the actual catalog,
 * and then either prints them (dry run, the default) or applies them.
 *
 * A merge repoints the duplicate's page edges to the survivor and records the
 * duplicate's name as an alias on the survivor — so future ingests and lookups
 * resolve the old name to the merged node and the duplicate cannot come back.
 *
 *   npm run lint             # dry run: print proposed merges
 *   npm run lint -- --apply  # execute them
 *
 * Kept off the ingest hot path on purpose: ingest stays deterministic;
 * cleanup is a deliberate, auditable action (see NOTES.md).
 */
import "dotenv/config";
import chalk from "chalk";
import { getEntityCatalog, mergeEntities, closeDriver, type EntityCatalogEntry } from "./graph.js";
import { proposeEntityMerges } from "./llm.js";
import { entityKey } from "./normalize.js";

const APPLY = process.argv.includes("--apply");

type ValidatedMerge = {
  survivor: EntityCatalogEntry;
  duplicate: EntityCatalogEntry;
  reason: string;
};

async function main() {
  console.log(chalk.bold(`\n── Confluence Graph — Lint ${APPLY ? "(apply)" : "(dry run)"} ──\n`));

  const catalog = await getEntityCatalog();
  const byKey = new Map(catalog.map((e) => [e.key, e]));

  const byKind = new Map<string, EntityCatalogEntry[]>();
  for (const e of catalog) {
    byKind.set(e.kind, [...(byKind.get(e.kind) ?? []), e]);
  }

  const merges: ValidatedMerge[] = [];
  for (const [kind, entities] of byKind) {
    if (entities.length < 2) continue;
    console.log(chalk.dim(`  auditing ${entities.length} ${kind} entities...`));

    const groups = await proposeEntityMerges(kind, entities);
    for (const group of groups) {
      // Trust nothing the model says until it maps onto real catalog entries.
      const survivor = byKey.get(entityKey(group.survivor));
      if (!survivor) {
        console.log(chalk.yellow(`    ! skipped group with unknown survivor "${group.survivor}"`));
        continue;
      }
      for (const dupName of group.duplicates) {
        const duplicate = byKey.get(entityKey(dupName));
        if (!duplicate || duplicate.key === survivor.key) {
          if (!duplicate) console.log(chalk.yellow(`    ! skipped unknown duplicate "${dupName}"`));
          continue;
        }
        merges.push({ survivor, duplicate, reason: group.reason });
      }
    }
  }

  if (!merges.length) {
    console.log(chalk.green("\n✓ No duplicate entities found\n"));
    await closeDriver();
    return;
  }

  console.log();
  for (const { survivor, duplicate, reason } of merges) {
    console.log(
      `  ${chalk.bold(duplicate.name)} ${chalk.dim(`(${duplicate.pageCount} pages)`)} → ` +
      `${chalk.bold(survivor.name)} ${chalk.dim(`(${survivor.pageCount} pages)`)}` +
      (reason ? chalk.dim(`  — ${reason}`) : "")
    );
    if (APPLY) {
      const moved = await mergeEntities(survivor.key, duplicate.key);
      console.log(chalk.green(`    ✓ merged, ${moved} edges moved; "${duplicate.name}" kept as alias`));
    }
  }

  console.log(
    APPLY
      ? chalk.bold(`\n── Done: ${merges.length} merges applied ──\n`)
      : chalk.bold(`\n── ${merges.length} merges proposed — re-run with "npm run lint -- --apply" ──\n`)
  );

  await closeDriver();
}

main().catch((err) => {
  console.error(chalk.red(String(err)));
  process.exit(1);
});
