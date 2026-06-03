#!/usr/bin/env tsx
/**
 * Query the graph via a conversational agent.
 *
 * Usage:
 *   npm run query "your question here"     # one-shot
 *   npm run query                          # interactive REPL
 */
import "dotenv/config";
import chalk from "chalk";
import { createInterface } from "readline";
import { runQueryAgent } from "./llm.js";
import { closeDriver } from "./graph.js";

const questionFromArgs = process.argv.slice(2).join(" ").trim();

async function ask(question: string) {
  console.log(chalk.bold(`\nQuery: ${question}\n`));

  const answer = await runQueryAgent(question, (tool, args) => {
    console.log(chalk.dim(`  [${tool}] ${JSON.stringify(args)}`));
  });

  console.log(chalk.bold("\nAnswer:\n") + answer + "\n");
}

async function repl() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log(chalk.bold("\n── Confluence Graph — Query ──"));
  console.log(chalk.dim("Ask a question. Ctrl+C to exit.\n"));

  const prompt = () =>
    rl.question(chalk.cyan("? "), async (input: string) => {
      if (input.trim()) await ask(input.trim());
      prompt();
    });

  prompt();
  rl.on("close", async () => { await closeDriver(); process.exit(0); });
}

async function main() {
  if (questionFromArgs) {
    await ask(questionFromArgs);
    await closeDriver();
  } else {
    await repl();
  }
}

main().catch((err) => {
  console.error(chalk.red(String(err)));
  process.exit(1);
});
