# Demo runbook

A four-beat walkthrough of the knowledge graph: ground truth → ephemeral layer →
live ingest → traversal. Run the Cypher in the Neo4j Browser
(http://localhost:7474) and the `npm` commands in a terminal.

> One-time: make sure Neo4j is running and `.env` is configured
> (`MISTRAL_MODEL=mistral-medium-latest`).

---

## Beat 0 — Build the base graph

```bash
npm run demo:reset      # wipes the DB, then ingests ./pages
```

This ingests every page **except** `incoming/project-nimbus.md` (held back for
beat 3). Pass 1 builds the ground-truth layer; pass 2 has Mistral create the
ephemeral layer.

---

## Beat 1 — Ground truth only

The Confluence pages and their real hyperlinks. Nothing the LLM invented.

```cypher
MATCH (p:Page)-[:LINKS_TO]->(q:Page)
RETURN p, q
```

> Talking point: this is all we can build *for free* from the documents
> themselves — one node per page, one edge per hyperlink.

---

## Beat 2 — The ephemeral layer the LLM built

Now show the entities (Concept / Person / Technology / Team) and the typed edges
Mistral created during ingest.

```cypher
-- Everything: ground truth + ephemeral
MATCH (n) OPTIONAL MATCH (n)-[r]->(m) RETURN n, r, m

-- Just the ephemeral entities and what connects to them
MATCH (p:Page)-[r]->(e:Entity) RETURN p, r, e

-- The bridge: people who span multiple pages
MATCH (e:Person)<--(p:Page)
WITH e, collect(p.title) AS pages
WHERE size(pages) > 1
RETURN e.name AS person, pages
```

> Talking point: `Amir Hassan` appears on both **Project Atlas** and **Project
> Hermes**, but no page hyperlinks one to the other. The Person node bridges them.

---

## Beat 3 — Ingest a new page, live

Project Nimbus has **no wikilinks** to the existing corpus — its only path to the
rest of the graph is through entities the LLM is about to create.

```bash
npm run demo:newpage    # ingests only incoming/project-nimbus.md
```

Then re-run a graph query and point out the new node:

```cypher
MATCH (p:Page {id: 'project-nimbus'})-[r]->(e:Entity)
RETURN p, r, e
```

> Talking point: watch the console — Mistral *reuses* existing entities
> (`Amir Hassan`, `Java`, `Kafka`) rather than inventing duplicates, so Nimbus
> wires itself into the graph through shared waypoints.

---

## Beat 4 — Traverse through an ephemeral node

A question with **no hyperlink path** to the answer — it can only be reached via
the Person bridge:

```bash
npm run query "What is Amir Hassan currently working on, and what else is he responsible for?"
```

Watch the tool-call trace: `list_entities` → `get_entity_neighborhood` /
`find_pages_by_entity` → answer. The agent finds Atlas, Hermes **and** the
freshly-added Nimbus, none of which link to each other directly.

Other good traversal questions:

```bash
npm run query "Which projects and services use Java?"
npm run query "Everything Yuki Tanaka touches"
```

---

## Reset between rehearsals

```bash
npm run demo:reset      # back to the base graph (Nimbus removed)
```
