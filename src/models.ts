import { z } from "zod";

// A Page mirrors one source document — a Confluence page, a markdown file, etc.
export const PageSchema = z.object({
  id: z.string(),        // unique slug derived from filename or Confluence page ID
  title: z.string(),
  path: z.string(),      // source-relative path, used as the "URL" shown to users
  type: z.string(),      // e.g. "article", "summary", "concept" — free-form for flexibility
  tags: z.array(z.string()).default([]),
  author: z.string().optional(),
  created: z.string().optional(),
  updated: z.string().optional(),
  // Written by the LLM during ingest; used for graph traversal without reading full content
  oneLiner: z.string().optional(),
});
export type Page = z.infer<typeof PageSchema>;

// A Concept is an LLM-created semantic node that groups related pages by topic.
// It lives only in Neo4j — it has no counterpart in the source documents.
export const ConceptSchema = z.object({
  name: z.string(),
  description: z.string(),
});
export type Concept = z.infer<typeof ConceptSchema>;

// What the LLM returns when it analyses a page during ingest
export const PageAnalysisSchema = z.object({
  oneLiner: z.string(),
  concepts: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      // true = this concept is new and should be created; false = reuse existing
      isNew: z.boolean(),
    })
  ),
});
export type PageAnalysis = z.infer<typeof PageAnalysisSchema>;
