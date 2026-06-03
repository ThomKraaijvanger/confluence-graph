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
import { join, relative, basename, extname, dirname } from "path";
import { fileURLToPath } from "url";
import matter from "gray-matter";
import type { Page } from "./models.js";

// ── Configuration ─────────────────────────────────────────────────────────────

const DEFAULT_PAGES_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../pages");

function getPagesDir(): string {
  return process.env.PAGES_DIR ?? DEFAULT_PAGES_DIR;
}

// Files that are structural metadata, not navigable content
const SKIP_FILENAMES = new Set(["index.md", "log.md", "inbox.md", "reading-list.md", "reading-practice.md"]);

// ── Parsing ───────────────────────────────────────────────────────────────────

export type ParsedPage = {
  page: Page;
  tags: string[];       // convenience alias for page.tags
  wikilinks: string[];  // slugs of other pages this page links to
  content: string;      // body text, stripped of frontmatter
};

export function parsePage(absPath: string): ParsedPage {
  const raw = readFileSync(absPath, "utf-8");
  const { data: fm, content } = matter(raw);
  const pagesDir = getPagesDir();
  const relPath = relative(pagesDir, absPath).replace(/\\/g, "/");
  const slug = basename(absPath, extname(absPath));

  const page: Page = {
    id: slug,
    title: String(fm["title"] ?? slug),
    path: relPath,
    type: deriveType(fm["type"], relPath),
    tags: Array.isArray(fm["tags"]) ? fm["tags"].map(String) : [],
    author: fm["author"] ? String(fm["author"]) : undefined,
    created: toDateString(fm["created"] ?? fm["date_ingested"]),
    updated: toDateString(fm["updated"]),
    oneLiner: undefined,
  };

  return { page, tags: page.tags, wikilinks: extractWikilinks(content), content: content.trim() };
}

export function getAllPageFiles(): string[] {
  const dir = getPagesDir();
  return walkMarkdown(dir).filter((f) => !SKIP_FILENAMES.has(basename(f)));
}

export function getPageContent(pageId: string): string | null {
  const match = getAllPageFiles().find((f) => basename(f, extname(f)) === pageId);
  if (!match) return null;
  const { content } = matter(readFileSync(match, "utf-8"));
  return content.trim();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractWikilinks(content: string): string[] {
  const slugs: string[] = [];
  for (const match of content.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) {
    slugs.push(basename(match[1].trim(), ".md"));
  }
  return [...new Set(slugs)];
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

// Map directory path prefixes to a human-readable type label.
// Add entries here as the page structure evolves.
const PATH_TYPE_MAP: [prefix: string, type: string][] = [
  ["sources/books", "book"],
  ["sources/videos", "video"],
  ["sources/papers", "paper"],
  ["sources/notes", "note"],
  ["wiki/summaries", "summary"],
  ["wiki/concepts", "concept"],
  ["wiki/entities", "entity"],
  ["wiki/overviews", "overview"],
];

function deriveType(fmType: unknown, relPath: string): string {
  if (typeof fmType === "string" && fmType && fmType !== "source") return fmType;
  for (const [prefix, type] of PATH_TYPE_MAP) {
    if (relPath.startsWith(prefix + "/")) return type;
  }
  return "page";
}
