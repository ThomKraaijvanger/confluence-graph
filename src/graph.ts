/**
 * All Neo4j interaction lives here.
 *
 * Graph schema
 * ────────────
 * Nodes
 *   (:Page)    – one per source document; properties mirror the Page model
 *   (:Concept) – LLM-created semantic nodes; no counterpart in source docs
 *
 * Relationships
 *   (:Page)-[:LINKS_TO]->(:Page)    – explicit link between documents
 *   (:Page)-[:ABOUT]->(:Concept)    – page covers this concept
 */

import neo4j, { type Driver, type Session } from "neo4j-driver";
import type { Page, Concept } from "./models.js";

let driver: Driver | null = null;

export function getDriver(): Driver {
  if (!driver) {
    driver = neo4j.driver(
      process.env.NEO4J_URI ?? "bolt://localhost:7687",
      neo4j.auth.basic(
        process.env.NEO4J_USER ?? "neo4j",
        process.env.NEO4J_PASSWORD ?? "password"
      )
    );
  }
  return driver;
}

export async function closeDriver() {
  await driver?.close();
  driver = null;
}

async function withSession<T>(fn: (s: Session) => Promise<T>): Promise<T> {
  const session = getDriver().session();
  try {
    return await fn(session);
  } finally {
    await session.close();
  }
}

// ── Setup ────────────────────────────────────────────────────────────────────

export async function setupConstraints() {
  await withSession(async (s) => {
    await s.run("CREATE CONSTRAINT page_id IF NOT EXISTS FOR (p:Page) REQUIRE p.id IS UNIQUE");
    await s.run("CREATE CONSTRAINT concept_name IF NOT EXISTS FOR (c:Concept) REQUIRE c.name IS UNIQUE");
  });
}

// ── Pages ────────────────────────────────────────────────────────────────────

export async function upsertPage(page: Page) {
  await withSession((s) =>
    s.run(
      `MERGE (p:Page {id: $id})
       SET p += $props`,
      {
        id: page.id,
        props: {
          title: page.title,
          path: page.path,
          type: page.type,
          tags: page.tags,
          author: page.author ?? null,
          created: page.created ?? null,
          updated: page.updated ?? null,
          oneLiner: page.oneLiner ?? null,
        },
      }
    )
  );
}

export async function linkPages(fromId: string, toId: string) {
  await withSession((s) =>
    s.run(
      `MATCH (a:Page {id: $fromId}), (b:Page {id: $toId})
       MERGE (a)-[:LINKS_TO]->(b)`,
      { fromId, toId }
    )
  );
}

export async function getAllPageIds(): Promise<string[]> {
  return withSession(async (s) => {
    const result = await s.run("MATCH (p:Page) RETURN p.id AS id");
    return result.records.map((r) => r.get("id") as string);
  });
}

export async function getPageById(id: string): Promise<Page | null> {
  return withSession(async (s) => {
    const result = await s.run("MATCH (p:Page {id: $id}) RETURN p", { id });
    if (!result.records.length) return null;
    return result.records[0].get("p").properties as Page;
  });
}

// ── Concepts ─────────────────────────────────────────────────────────────────

export async function upsertConcept(concept: Concept) {
  await withSession((s) =>
    s.run(
      `MERGE (c:Concept {name: $name})
       SET c.description = $description`,
      { name: concept.name, description: concept.description }
    )
  );
}

export async function linkPageToConcept(pageId: string, conceptName: string) {
  await withSession((s) =>
    s.run(
      `MATCH (p:Page {id: $pageId}), (c:Concept {name: $conceptName})
       MERGE (p)-[:ABOUT]->(c)`,
      { pageId, conceptName }
    )
  );
}

export async function listConcepts(): Promise<Array<{ name: string; description: string; pageCount: number }>> {
  return withSession(async (s) => {
    const result = await s.run(
      `MATCH (c:Concept)
       OPTIONAL MATCH (p:Page)-[:ABOUT]->(c)
       RETURN c.name AS name, c.description AS description, count(p) AS pageCount
       ORDER BY pageCount DESC`
    );
    return result.records.map((r) => ({
      name: r.get("name") as string,
      description: r.get("description") as string,
      pageCount: (r.get("pageCount") as { toNumber(): number }).toNumber(),
    }));
  });
}

// ── Query tools (called by the LLM agent) ────────────────────────────────────

export type PageRef = Pick<Page, "id" | "title" | "path" | "type" | "oneLiner">;

export async function searchPagesByKeyword(keywords: string[]): Promise<PageRef[]> {
  return withSession(async (s) => {
    const result = await s.run(
      `MATCH (p:Page)
       WHERE any(kw IN $keywords WHERE
         toLower(p.title)   CONTAINS toLower(kw) OR
         toLower(coalesce(p.oneLiner, '')) CONTAINS toLower(kw) OR
         any(tag IN p.tags WHERE toLower(tag) CONTAINS toLower(kw))
       )
       RETURN p.id AS id, p.title AS title, p.path AS path,
              p.type AS type, p.oneLiner AS oneLiner`,
      { keywords }
    );
    return result.records.map(toPageRef);
  });
}

export async function findPagesByConceptName(conceptName: string): Promise<PageRef[]> {
  return withSession(async (s) => {
    const result = await s.run(
      `MATCH (p:Page)-[:ABOUT]->(c:Concept)
       WHERE toLower(c.name) CONTAINS toLower($conceptName)
          OR toLower(c.description) CONTAINS toLower($conceptName)
       RETURN DISTINCT p.id AS id, p.title AS title, p.path AS path,
              p.type AS type, p.oneLiner AS oneLiner`,
      { conceptName }
    );
    return result.records.map(toPageRef);
  });
}

export async function getRelatedPages(pageId: string): Promise<PageRef[]> {
  return withSession(async (s) => {
    const result = await s.run(
      `MATCH (p:Page {id: $pageId})-[:LINKS_TO|ABOUT*1..2]-(related:Page)
       WHERE related.id <> $pageId
       RETURN DISTINCT related.id AS id, related.title AS title,
              related.path AS path, related.type AS type, related.oneLiner AS oneLiner
       LIMIT 20`,
      { pageId }
    );
    return result.records.map(toPageRef);
  });
}

export async function getConceptNeighborhood(conceptName: string): Promise<{
  concept: { name: string; description: string };
  relatedConcepts: string[];
  pages: PageRef[];
}> {
  return withSession(async (s) => {
    const result = await s.run(
      `MATCH (c:Concept)
       WHERE toLower(c.name) CONTAINS toLower($conceptName)
       OPTIONAL MATCH (c)-[:RELATED_TO]-(rc:Concept)
       OPTIONAL MATCH (p:Page)-[:ABOUT]->(c)
       RETURN c.name AS name, c.description AS description,
              collect(DISTINCT rc.name) AS related,
              collect(DISTINCT {
                id: p.id, title: p.title, path: p.path,
                type: p.type, oneLiner: p.oneLiner
              }) AS pages`,
      { conceptName }
    );
    if (!result.records.length) {
      return { concept: { name: conceptName, description: "" }, relatedConcepts: [], pages: [] };
    }
    const r = result.records[0];
    return {
      concept: { name: r.get("name") as string, description: r.get("description") as string },
      relatedConcepts: (r.get("related") as string[]).filter(Boolean),
      pages: (r.get("pages") as PageRef[]).filter((p) => p.id),
    };
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function toPageRef(r: { get(k: string): unknown }): PageRef {
  return {
    id: r.get("id") as string,
    title: r.get("title") as string,
    path: r.get("path") as string,
    type: r.get("type") as string,
    oneLiner: r.get("oneLiner") as string | undefined,
  };
}
