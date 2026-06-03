#!/usr/bin/env tsx
/**
 * Wipes all nodes and relationships from the graph.
 * Run before a fresh ingest to start with a clean slate.
 *
 *   npm run reset
 */
import "dotenv/config";
import chalk from "chalk";
import { getDriver, closeDriver } from "./graph.js";

const session = getDriver().session();
try {
  const result = await session.run("MATCH (n) DETACH DELETE n");
  const deleted = result.summary.counters.updates();
  console.log(chalk.green(`✓ Database cleared (${deleted.nodesDeleted} nodes, ${deleted.relationshipsDeleted} relationships deleted)`));
} finally {
  await session.close();
  await closeDriver();
}
