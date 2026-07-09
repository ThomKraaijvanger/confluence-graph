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
import { cleanName, entityKey } from "./normalize.js";

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
    // Identity is the canonical key (see normalize.ts), not the display name.
    await s.run("CREATE CONSTRAINT entity_key IF NOT EXISTS FOR (e:Entity) REQUIRE e.key IS UNIQUE");
  });
}

// ── Pages ────────────────────────────────────────────────────────────────────

export async function upsertPage(page: Page) {
  // Only write the fields the caller provided (SET += with a null value would
  // erase the property) — the structural pass must not wipe what the
  // annotation pass wrote (oneLiner, contentHash), and vice versa.
  const props = Object.fromEntries(
    Object.entries({
      title: page.title,
      path: page.path,
      type: page.type,
      tags: page.tags,
      author: page.author,
      created: page.created,
      updated: page.updated,
      content: page.content,
      oneLiner: page.oneLiner,
      contentHash: page.contentHash,
    }).filter(([, v]) => v !== undefined)
  );
  await withSession((s) =>
    s.run(
      `MERGE (p:Page {id: $id})
       SET p += $props`,
      { id: page.id, props }
    )
  );
}

// Drop a page's outgoing LINKS_TO edges so pass 1 can re-derive them — links
// removed from the source must not linger in the graph.
export async function clearPageLinks(pageId: string) {
  await withSession((s) =>
    s.run(`MATCH (:Page {id: $pageId})-[r:LINKS_TO]->() DELETE r`, { pageId })
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
  const name = cleanName(entity.name);
  const key = entityKey(entity.name);
  await withSession((s) =>
    s.run(
      // Identity is the canonical key; the display name of the first occurrence
      // is kept. kind is enum-validated above, so the interpolated label is safe.
      `MERGE (e:Entity {key: $key})
       ON CREATE SET e.name = $name
       SET e:${kind}, e.kind = $kind, e.description = $description`,
      { key, name, kind, description: entity.description }
    )
  );
}

export async function linkPageToEntity(pageId: string, entityName: string, relation: string) {
  await linkPageToEntityByKey(pageId, entityKey(entityName), relation);
}

export async function linkPageToEntityByKey(pageId: string, key: string, relation: string) {
  const rel = safeRelType(relation);
  await withSession((s) =>
    s.run(
      // Match the entity by canonical key. rel is sanitized to [A-Z0-9_] above,
      // so the interpolated type is safe.
      `MATCH (p:Page {id: $pageId}), (e:Entity {key: $key})
       MERGE (p)-[:${rel}]->(e)`,
      { pageId, key }
    )
  );
}

// Fold `duplicate` into `survivor` (the lint pass's merge operation): repoint
// the duplicate's page edges keeping their relation types, remember the
// duplicate's name as an alias — so future ingests and lookups resolve it to
// the survivor — and delete the node. Returns the number of edges moved.
export async function mergeEntities(survivorKey: string, duplicateKey: string): Promise<number> {
  // Edge types are dynamic and Cypher cannot re-create a relationship with a
  // dynamic type, so read the duplicate's edges and re-link them one by one.
  const edges = await withSession(async (s) => {
    const result = await s.run(
      `MATCH (p:Page)-[r]->(e:Entity {key: $duplicateKey})
       RETURN p.id AS pageId, type(r) AS rel`,
      { duplicateKey }
    );
    return result.records.map((r) => ({
      pageId: r.get("pageId") as string,
      rel: r.get("rel") as string,
    }));
  });

  await withSession((s) =>
    s.run(
      `MATCH (surv:Entity {key: $survivorKey}), (dup:Entity {key: $duplicateKey})
       WITH surv, dup, coalesce(surv.aliases, []) + dup.name + coalesce(dup.aliases, []) AS all
       UNWIND all AS a
       WITH surv, dup, collect(DISTINCT a) AS aliases
       SET surv.aliases = [x IN aliases WHERE x <> surv.name]
       DETACH DELETE dup`,
      { survivorKey, duplicateKey }
    )
  );

  for (const { pageId, rel } of edges) {
    await linkPageToEntityByKey(pageId, survivorKey, rel);
  }
  return edges.length;
}

// Drop a page's entity edges before re-annotating changed content, so
// relations extracted from an old version don't linger.
export async function clearPageEntityEdges(pageId: string) {
  await withSession((s) =>
    s.run(`MATCH (:Page {id: $pageId})-[r]->(:Entity) DELETE r`, { pageId })
  );
}

// Entities no page points at (left behind by re-annotation) carry no signal.
export async function deleteOrphanEntities(): Promise<number> {
  return withSession(async (s) => {
    const result = await s.run(
      `MATCH (e:Entity) WHERE NOT (:Page)-->(e)
       DETACH DELETE e
       RETURN count(e) AS n`
    );
    return (result.records[0].get("n") as { toNumber(): number }).toNumber();
  });
}

// Capped so the agent's opening move stays small on a large graph — the most
// connected entities carry the most navigation signal.
export async function listEntities(limit = 50): Promise<Array<{ name: string; kind: string; description: string; pageCount: number }>> {
  return withSession(async (s) => {
    const result = await s.run(
      `MATCH (e:Entity)
       OPTIONAL MATCH (p:Page)-->(e)
       RETURN e.name AS name, e.kind AS kind, e.description AS description, count(p) AS pageCount
       ORDER BY pageCount DESC
       LIMIT $limit`,
      { limit: neo4j.int(Math.max(1, Math.floor(limit))) }
    );
    return result.records.map((r) => ({
      name: r.get("name") as string,
      kind: (r.get("kind") as string) ?? "Concept",
      description: r.get("description") as string,
      pageCount: (r.get("pageCount") as { toNumber(): number }).toNumber(),
    }));
  });
}

export type EntityCatalogEntry = {
  name: string;
  key: string;
  kind: string;
  description: string;
  aliases: string[];
  pageCount: number;
};

// Every entity with its canonical key, aliases and connectivity — the ingest
// pass matches these against page text to build the reuse hint, and the lint
// pass audits them for duplicates. Most-connected first.
export async function getEntityCatalog(): Promise<EntityCatalogEntry[]> {
  return withSession(async (s) => {
    const result = await s.run(
      `MATCH (e:Entity)
       OPTIONAL MATCH (p:Page)-->(e)
       RETURN e.name AS name, e.key AS key, e.kind AS kind, e.description AS description,
              coalesce(e.aliases, []) AS aliases, count(p) AS pageCount
       ORDER BY pageCount DESC`
    );
    return result.records.map((r) => ({
      name: r.get("name") as string,
      key: r.get("key") as string,
      kind: (r.get("kind") as string) ?? "Concept",
      description: (r.get("description") as string) ?? "",
      aliases: r.get("aliases") as string[],
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

export type EntityNeighborhood =
  | { found: false; message: string; candidates?: Array<{ name: string; kind: string }> }
  | {
      found: true;
      entity: { name: string; kind: string; description: string };
      relatedEntities: string[];
      pages: PageRef[];
    };

export async function getEntityNeighborhood(entityName: string): Promise<EntityNeighborhood> {
  // Match on the canonical key: an exact hit wins; a partial hit only counts
  // when it is unique. Anything else is reported back as candidates instead of
  // silently picking one ("Java" must never resolve to "JavaScript").
  const q = entityKey(entityName);
  return withSession(async (s) => {
    const matches = await s.run(
      `MATCH (e:Entity)
       WHERE e.key CONTAINS $q
          OR any(a IN coalesce(e.aliases, []) WHERE toLower(a) CONTAINS $q)
       RETURN e.name AS name, e.kind AS kind, e.key AS key,
              coalesce(e.aliases, []) AS aliases
       ORDER BY name LIMIT 25`,
      { q }
    );
    const candidates = matches.records.map((r) => ({
      name: r.get("name") as string,
      kind: (r.get("kind") as string) ?? "Concept",
      key: r.get("key") as string,
      aliases: r.get("aliases") as string[],
    }));
    if (!candidates.length) {
      return { found: false, message: `No entity matches "${entityName}". Try list_entities or search_pages.` };
    }
    const target =
      candidates.find((c) => c.key === q || c.aliases.some((a) => entityKey(a) === q)) ??
      (candidates.length === 1 ? candidates[0] : undefined);
    if (!target) {
      return {
        found: false,
        message: `"${entityName}" is ambiguous — call again with one of the candidate names.`,
        candidates: candidates.map(({ name, kind }) => ({ name, kind })),
      };
    }

    const result = await s.run(
      `MATCH (e:Entity {key: $key})
       OPTIONAL MATCH (p:Page)-->(e)
       // related entities = those reachable through a shared page
       OPTIONAL MATCH (e)<--(:Page)-->(re:Entity) WHERE re <> e
       RETURN e.name AS name, e.kind AS kind, e.description AS description,
              collect(DISTINCT re.name) AS related,
              collect(DISTINCT {
                id: p.id, title: p.title, path: p.path,
                type: p.type, oneLiner: p.oneLiner
              }) AS pages`,
      { key: target.key }
    );
    const r = result.records[0];
    return {
      found: true,
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
