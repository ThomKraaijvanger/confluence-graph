import { z } from "zod";

// A Page mirrors one source document — a Confluence page, a markdown file, etc.
export const PageSchema = z.object({
  id: z.string(),        // unique id: PAGES_DIR-relative path without extension, or Confluence page ID
  title: z.string(),
  path: z.string(),      // source-relative path, used as the "URL" shown to users
  type: z.string(),      // e.g. "article", "summary", "concept" — free-form for flexibility
  tags: z.array(z.string()).default([]),
  author: z.string().optional(),
  created: z.string().optional(),
  updated: z.string().optional(),
  // Full page body — the "textdump" the agent can inspect via get_page_content.
  // Stored on the node so the graph is self-contained (no dependency on PAGES_DIR at query time).
  content: z.string().optional(),
  // Written by the LLM during ingest; used for graph traversal without reading full content
  oneLiner: z.string().optional(),
});
export type Page = z.infer<typeof PageSchema>;

// The kinds of ephemeral entity the LLM may create. Constrained to a fixed set
// so each can map to a real Neo4j label (Browser colours them) without risk of
// injection — Cypher cannot parameterize labels.
export const ENTITY_KINDS = ["Concept", "Person", "Technology", "Team"] as const;
export const EntityKindSchema = z.enum(ENTITY_KINDS);
export type EntityKind = z.infer<typeof EntityKindSchema>;

// An Entity is an LLM-created "ephemeral" node — a semantic waypoint that helps
// the agent traverse the space. It lives only in Neo4j; it has no counterpart in
// the source documents. Entities are MERGEd by name, so the same Person/Technology
// referenced from several pages becomes one shared node that bridges them.
export const EntitySchema = z.object({
  name: z.string(),
  kind: EntityKindSchema,
  description: z.string(),
});
export type Entity = z.infer<typeof EntitySchema>;

// What the LLM returns when it analyses a page during ingest.
// Each entity carries the relationship label describing how THIS page relates to
// it (e.g. USES, OWNED_BY, MENTIONS) — that label becomes the ephemeral edge type.
// Tolerant per-entity schema: a stray kind or a missing field degrades to a
// sensible default instead of throwing away the whole page's analysis.
const AnalyzedEntitySchema = z.object({
  name: z.string(),
  kind: EntityKindSchema.catch("Concept"),
  description: z.string().catch(""),
  relation: z.string().catch("RELATES_TO"), // edge label: page -[relation]-> entity
});

export const PageAnalysisSchema = z.object({
  oneLiner: z.string().catch(""),
  entities: z.array(AnalyzedEntitySchema).catch([]),
});
export type PageAnalysis = z.infer<typeof PageAnalysisSchema>;
