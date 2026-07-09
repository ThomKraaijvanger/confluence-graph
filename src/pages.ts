/**
 * Reads source pages from the filesystem and parses them into the Page model.
 *
 * Currently supports markdown files with YAML frontmatter (Obsidian / wiki style).
 * The root directory is set via the PAGES_DIR environment variable.
 *
 * To adapt for Confluence: replace getAllPageFiles() and parsePage() with
 * functions that call the Confluence REST API instead of reading from disk.
 */

import { readFileSync, readdirSync, statSync } from "fs";
import { createHash } from "crypto";
import { join, relative, dirname } from "path";
import { fileURLToPath } from "url";
import matter from "gray-matter";
import type { Page } from "./models.js";

// ── Configuration ─────────────────────────────────────────────────────────────

const DEFAULT_PAGES_DIR = join(dirname(fileURLToPath(import.meta.url)), "../pages");

function getPagesDir(): string {
  return process.env.PAGES_DIR ?? DEFAULT_PAGES_DIR;
}

// ── Parsing ───────────────────────────────────────────────────────────────────

export type ParsedPage = {
  page: Page;
  tags: string[];       // convenience alias for page.tags
  wikilinks: string[];  // [[...]] targets found in the body, .md stripped
  content: string;      // body text, stripped of frontmatter
};

export function parsePage(absPath: string): ParsedPage {
  const raw = readFileSync(absPath, "utf-8");
  const { data: fm, content } = matter(raw);
  const relPath = relative(getPagesDir(), absPath).replace(/\\/g, "/");
  // The id is the PAGES_DIR-relative path without extension, so same-named
  // files in different folders stay distinct (services/auth vs projects/auth).
  const id = relPath.replace(/\.md$/, "");
  const body = content.trim();

  const page: Page = {
    id,
    title: String(fm["title"] ?? id.split("/").pop()),
    path: relPath,
    type: typeof fm["type"] === "string" && fm["type"] ? fm["type"] : "page",
    tags: Array.isArray(fm["tags"]) ? fm["tags"].map(String) : [],
    author: fm["author"] ? String(fm["author"]) : undefined,
    created: toDateString(fm["created"]),
    updated: toDateString(fm["updated"]),
  };

  return { page, tags: page.tags, wikilinks: extractWikilinks(body), content: body };
}

export function getAllPageFiles(): string[] {
  return walkMarkdown(getPagesDir());
}

// Fingerprint of a page body, compared against Page.contentHash to decide
// whether a stored annotation is still current.
export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// [[target]] or [[target|label]]. Any folder prefix in the target is kept so
// full-path links resolve exactly; bare filenames are resolved against page
// basenames at ingest time.
function extractWikilinks(content: string): string[] {
  const targets: string[] = [];
  for (const match of content.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) {
    targets.push(match[1].trim().replace(/\.md$/, ""));
  }
  return [...new Set(targets)];
}

function walkMarkdown(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkMarkdown(full, out);
    else if (entry.endsWith(".md")) out.push(full);
  }
  return out;
}

function toDateString(value: unknown): string | undefined {
  if (!value) return undefined;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}
