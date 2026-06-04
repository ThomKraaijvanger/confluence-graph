/**
 * All Neo4j interaction lives here.
 *
 * Graph schema
 * ────────────
 * Two layers:
 *
 *   Ground truth (mirrors the source docs, no LLM)
 *     (:Page)                         – one per source document
 *     (:Page)-[:LINKS_TO]->(:Page)    – explicit hyperlink between documents
 *
 *   Ephemeral (LLM-created at ingest; navigation waypoints, no source counterpart)
 *     (:Entity:Concept|Person|Technology|Team)   – the dual label gives Browser its colour
 *     (:Page)-[:<RELATION>]->(:Entity)            – e.g. USES, OWNED_BY, MENTIONS
 *
 * Entities are MERGEd by name, so a Person/Technology referenced from several
 * pages becomes one shared node that bridges them — letting the agent traverse
 * between pages that have no direct hyperlink.
 */

import neo4j, { type Driver, type Session } from "neo4j-driver";
import { ENTITY_KINDS, type Page, type Entity, type EntityKind } from "./models.js";

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
    await s.run("CREATE CONSTRAINT entity_name IF NOT EXISTS FOR (e:Entity) REQUIRE e.name IS UNIQUE");
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
          content: page.content ?? null,
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

// Full body text of a page, read straight from the node (the graph is the
// source of truth at query time — no filesystem dependency).
export async function getPageContent(id: string): Promise<string | null> {
  return withSession(async (s) => {
    const result = await s.run("MATCH (p:Page {id: $id}) RETURN p.content AS content", { id });
    const content = result.records[0]?.get("content");
    return (content as string) ?? null;
  });
}

// ── Entities (ephemeral layer) ───────────────────────────────────────────────

const KIND_SET = new Set<string>(ENTITY_KINDS);

// Validate against the fixed enum so it is safe to interpolate as a Neo4j label.
function safeKind(kind: string): EntityKind {
  return (KIND_SET.has(kind) ? kind : "Concept") as EntityKind;
}

// Relationship types come from the LLM, so sanitize to an UPPER_SNAKE token
// before interpolating (Cypher cannot parameterize relationship types).
function safeRelType(rel: string): string {
  const cleaned = rel.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || "RELATES_TO";
}

export async function upsertEntity(entity: Entity) {
  const kind = safeKind(entity.kind);
  await withSession((s) =>
    s.run(
      // kind is enum-validated above, so the interpolated label is safe.
      `MERGE (e:Entity {name: $name})
       SET e:${kind}, e.kind = $kind, e.description = $description`,
      { name: entity.name, kind, description: entity.description }
    )
  );
}

export async function linkPageToEntity(pageId: string, entityName: string, relation: string) {
  const rel = safeRelType(relation);
  await withSession((s) =>
    s.run(
      // rel is sanitized to [A-Z0-9_] above, so the interpolated type is safe.
      `MATCH (p:Page {id: $pageId}), (e:Entity {name: $entityName})
       MERGE (p)-[:${rel}]->(e)`,
      { pageId, entityName }
    )
  );
}

export async function listEntities(): Promise<Array<{ name: string; kind: string; description: string; pageCount: number }>> {
  return withSession(async (s) => {
    const result = await s.run(
      `MATCH (e:Entity)
       OPTIONAL MATCH (p:Page)-->(e)
       RETURN e.name AS name, e.kind AS kind, e.description AS description, count(p) AS pageCount
       ORDER BY pageCount DESC`
    );
    return result.records.map((r) => ({
      name: r.get("name") as string,
      kind: (r.get("kind") as string) ?? "Concept",
      description: r.get("description") as string,
      pageCount: (r.get("pageCount") as { toNumber(): number }).toNumber(),
    }));
  });
}

// All distinct entity names currently in the graph — used to nudge the LLM
// toward reusing existing entities during ingest.
export async function getAllEntityNames(): Promise<string[]> {
  return withSession(async (s) => {
    const result = await s.run("MATCH (e:Entity) RETURN e.name AS name");
    return result.records.map((r) => r.get("name") as string);
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

export async function findPagesByEntityName(entityName: string): Promise<PageRef[]> {
  return withSession(async (s) => {
    const result = await s.run(
      `MATCH (p:Page)-->(e:Entity)
       WHERE toLower(e.name) CONTAINS toLower($entityName)
          OR toLower(e.description) CONTAINS toLower($entityName)
       RETURN DISTINCT p.id AS id, p.title AS title, p.path AS path,
              p.type AS type, p.oneLiner AS oneLiner`,
      { entityName }
    );
    return result.records.map(toPageRef);
  });
}

export async function getRelatedPages(pageId: string): Promise<PageRef[]> {
  return withSession(async (s) => {
    // Any path up to length 2 — this includes ground-truth LINKS_TO hops AND
    // ephemeral bridges (Page -> Entity <- Page), which is what surfaces pages
    // that share a Person/Technology but have no direct hyperlink.
    const result = await s.run(
      `MATCH (p:Page {id: $pageId})-[*1..2]-(related:Page)
       WHERE related.id <> $pageId
       RETURN DISTINCT related.id AS id, related.title AS title,
              related.path AS path, related.type AS type, related.oneLiner AS oneLiner
       LIMIT 20`,
      { pageId }
    );
    return result.records.map(toPageRef);
  });
}

export async function getEntityNeighborhood(entityName: string): Promise<{
  entity: { name: string; kind: string; description: string };
  relatedEntities: string[];
  pages: PageRef[];
}> {
  return withSession(async (s) => {
    const result = await s.run(
      `MATCH (e:Entity)
       WHERE toLower(e.name) CONTAINS toLower($entityName)
       WITH e LIMIT 1
       OPTIONAL MATCH (p:Page)-->(e)
       // related entities = those reachable through a shared page
       OPTIONAL MATCH (e)<--(:Page)-->(re:Entity) WHERE re <> e
       RETURN e.name AS name, e.kind AS kind, e.description AS description,
              collect(DISTINCT re.name) AS related,
              collect(DISTINCT {
                id: p.id, title: p.title, path: p.path,
                type: p.type, oneLiner: p.oneLiner
              }) AS pages`,
      { entityName }
    );
    if (!result.records.length) {
      return { entity: { name: entityName, kind: "Concept", description: "" }, relatedEntities: [], pages: [] };
    }
    const r = result.records[0];
    return {
      entity: {
        name: r.get("name") as string,
        kind: (r.get("kind") as string) ?? "Concept",
        description: r.get("description") as string,
      },
      relatedEntities: (r.get("related") as string[]).filter(Boolean),
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
