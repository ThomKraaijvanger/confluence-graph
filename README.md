# Confluence Graph

A Neo4j semantic layer that makes a large document space navigable by a weak LLM.

The problem it solves: an LLM cannot reason over hundreds of Confluence pages at once. But it *can* follow a graph. This project builds that graph automatically, then exposes it to the LLM as a set of typed tools so it can traverse the space and answer questions — or find the right pages to read before creating a new one.

---

## How it works

```
Source pages (Confluence / markdown)
         │
         │  npm run ingest
         ▼
    Neo4j Graph
    ┌──────────────────────────────────────────────────┐
    │  (:Page) ──[:LINKS_TO]──> (:Page)                 │  ground-truth layer
    │  (:Page) ──[:USES|OWNED_BY|…]──> (:Entity)        │  ephemeral layer (LLM-made)
    │            (:Entity = :Concept|:Person|            │
    │             :Technology|:Team)                     │
    └──────────────────────────────────────────────────┘
         │
         │  npm run query "..."
         ▼
    LLM agent (tool-calling loop)
    → list_entities → get_entity_neighborhood → get_page_content → answer
```

The graph has two layers:

**Ground-truth layer** — built without LLM involvement, mirrors the source exactly. One `(:Page)` node per document (the full page body is stored on the node); `[:LINKS_TO]` edges from the real hyperlinks/wikilinks in the content.

**Ephemeral layer** — built by the LLM during ingest. The LLM reads each page and extracts 2–6 `(:Entity)` nodes with a *kind* (`Concept`, `Person`, `Technology`, `Team`) and a typed edge describing the relationship (`USES`, `OWNED_BY`, `MENTIONS`, …). Entities live only in Neo4j — they have no counterpart in the source documents. Crucially they are **merged by name**, so a person or technology referenced by several pages becomes one shared node. These shared entities act as navigation waypoints: the query agent can hop *between pages that have no direct hyperlink* by going through the person/technology/team they have in common.

---

## Prerequisites

- **Node.js** ≥ 18
- **Docker or Podman** (for Neo4j)
- A **Mistral API key** — this project uses the Mistral SDK with `mistral-medium-latest`

---

## Setup

### 1. Clone the repo

```bash
git clone https://github.com/ThomKraaijvanger/confluence-graph.git
cd confluence-graph
npm install
```

### 2. Start Neo4j

Using Podman:

```bash
podman run \
  --name neo4j-graph \
  -p 7474:7474 \
  -p 7687:7687 \
  -e NEO4J_AUTH=neo4j/password \
  --detach \
  docker.io/neo4j:5
```

Using Docker:

```bash
docker run \
  --name neo4j-graph \
  -p 7474:7474 \
  -p 7687:7687 \
  -e NEO4J_AUTH=neo4j/password \
  --detach \
  neo4j:5
```

The Neo4j Browser is available at **http://localhost:7474/browser/** once the container is up (takes ~10 seconds).

### 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

| Variable | Description |
|---|---|
| `MISTRAL_API_KEY` | Your Mistral API key |
| `MISTRAL_MODEL` | Model ID (default: `mistral-medium-latest`) |
| `NEO4J_URI` | Bolt URI (default: `bolt://localhost:7687`) |
| `NEO4J_USER` | Neo4j username (default: `neo4j`) |
| `NEO4J_PASSWORD` | Neo4j password — must match `-e NEO4J_AUTH` above |
| `PAGES_DIR` | Path to the directory containing your source pages |

### 4. Prepare your source pages

`PAGES_DIR` should point to a directory of **markdown files with YAML frontmatter**. Each file becomes one `(:Page)` node in the graph.

Recommended frontmatter fields (all optional except the file being valid markdown):

```yaml
---
title: My Confluence Page
type: article          # free-form; shown in query results
tags: [backend, auth]
author: Jane Smith
created: 2025-01-15
---

Page content here...
```

Wikilinks in the content (`[[other-page]]`) are automatically extracted and become `[:LINKS_TO]` edges in the graph. A bare filename is resolved against all page basenames; if two pages share a basename the link is skipped with a warning (use the folder-qualified form, e.g. `[[services/auth]]`, to disambiguate).

**For Confluence**: fetch pages via the Confluence REST API and write them as markdown files into `PAGES_DIR`. The ingest step then picks them up. A Confluence → markdown fetcher is a natural next step but is out of scope here.

---

## Ingesting pages

```bash
npm run ingest
```

This runs in two passes:

1. **Ground-truth pass** (no LLM): creates all `(:Page)` nodes (storing the page body) and `[:LINKS_TO]` edges. Fast, free.
2. **Annotation pass** (LLM): for each unannotated page, sends the page to Mistral and gets back a one-liner plus 2–6 entities (`Concept`/`Person`/`Technology`/`Team`), each with a typed relation. Creates `(:Entity)` nodes (merged by a canonical name key) and the typed `(:Page)->(:Entity)` edges. To steer the model toward reusing existing nodes, each call includes a hint listing the entities whose name (or alias) appears in the page plus the most-connected entities — so the hint stays small no matter how large the graph grows.

The annotation pass is **incremental** — pages whose annotation is up to date are skipped. A page whose content changed since its last annotation is re-annotated: its old entity edges are replaced, and entities no page references anymore are swept at the end of the run.

### Ingest flags

```bash
# Custom delay between LLM calls (default: 3 seconds — helps with rate limits)
npx tsx src/ingest.ts --delay 5

# Annotate only the first N unannotated pages (useful for testing)
npx tsx src/ingest.ts --limit 10
```

### Typical token usage

The LLM receives the page body (capped at ~4,000 characters; see `SNIPPET_CHARS` in `src/ingest.ts`). For the small demo pages that is a few hundred tokens each. If you ingest a large corpus and want to control cost, lower that cap to send only the opening of each page.

---

## Querying

```bash
# One-shot question
npm run query "What pages cover authentication and OAuth?"

# Interactive REPL
npm run query
```

The query agent runs a tool-calling loop. It starts by listing entities or searching by keyword to orient itself, then traverses the graph — including through shared entities — to build an answer. Tool calls are printed to the console so you can follow the reasoning:

```
Query: What is Amir Hassan working on, and what else is he responsible for?

  [list_entities] {}
  [get_entity_neighborhood] {"entity":"Amir Hassan"}
  [get_page_content] {"pageId":"projects/project-hermes"}

Answer:

Amir Hassan leads infrastructure across several efforts:
1. **Project Hermes — Messaging Infrastructure** — `projects/project-hermes.md`
2. **Project Atlas — Core Platform** — `projects/project-atlas.md`
   ...
```

---

## Graph schema

### Nodes

| Label | Description |
|---|---|
| `(:Page)` | Ground truth — one per source document |
| `(:Entity)` | LLM-created ephemeral node; carries a second kind-label and lives only in Neo4j |
| `(:Entity:Concept\|Person\|Technology\|Team)` | The kind-label so the Neo4j Browser colours each type |

**Page properties:** `id`, `title`, `path`, `type`, `tags`, `author`, `created`, `updated`, `content`, `oneLiner`, `contentHash`

**Entity properties:** `key` (unique, canonical — see `src/normalize.ts`), `name` (display), `kind`, `description`, `aliases` (names folded in by `npm run lint`)

### Relationships

| Relationship | Meaning |
|---|---|
| `(:Page)-[:LINKS_TO]->(:Page)` | Ground truth — explicit hyperlink/wikilink between pages |
| `(:Page)-[:<RELATION>]->(:Entity)` | Ephemeral — LLM-assigned typed edge, e.g. `USES`, `OWNED_BY`, `MENTIONS` |

### Useful Cypher queries

Browse the graph in the Neo4j Browser at `http://localhost:7474/browser/`:

```cypher
-- All nodes and edges
MATCH (n)-[r]->(m) RETURN n, r, m LIMIT 300

-- Ground truth only
MATCH (p:Page)-[:LINKS_TO]->(q:Page) RETURN p, q

-- Pages connected to each entity
MATCH (p:Page)-[r]->(e:Entity) RETURN p, r, e

-- People who span more than one page (the ephemeral bridges)
MATCH (e:Person)<--(p:Page)
WITH e, collect(p.title) AS pages
WHERE size(pages) > 1
RETURN e.name AS person, pages

-- Pages that link to a specific page (ids are PAGES_DIR-relative paths)
MATCH (p:Page)-[:LINKS_TO]->(target:Page {id: 'projects/project-atlas'})
RETURN p.title, p.path
```

---

## Agent tools

The query agent has six tools:

| Tool | Description |
|---|---|
| `list_entities` | List entity nodes with kind and page counts, most-connected first (capped) — good starting point |
| `get_entity_neighborhood` | An entity's related entities (via shared pages) and all pages connected to it |
| `find_pages_by_entity` | All pages connected to an entity (partial name match) |
| `search_pages` | Keyword search on title, tags, and one-liner |
| `get_related_pages` | Pages reachable from a given page via links **and** shared entities (the ephemeral bridges) |
| `get_page_content` | Full text of a page, read from the node — used sparingly for detail |

---

## Graph healthcheck (lint)

Deterministic normalization catches `kubernetes` vs `Kubernetes`, but not `K8s` vs `Kubernetes` — that needs meaning. The lint pass audits each entity kind with the LLM and merges true duplicates:

```bash
npm run lint             # dry run: print proposed merges
npm run lint -- --apply  # execute them
```

A merge repoints the duplicate's page edges to the survivor and keeps the duplicate's name as an **alias** on the surviving node. Ingest and entity lookup resolve aliases, so once `K8s` is folded into `Kubernetes`, later pages that say "K8s" link to the `Kubernetes` node instead of re-creating the duplicate. See `NOTES.md` for the design rationale.

---

## Project structure

```
src/
├── models.ts      Zod schemas for Page, Entity, PageAnalysis
├── normalize.ts   Deterministic entity-name normalization (canonical key)
├── graph.ts       All Neo4j interaction (CRUD + query tools)
├── pages.ts       Reads source pages from PAGES_DIR and parses markdown
├── llm.ts         LLM calls — analyzePage() for ingest, runQueryAgent() for queries
├── ingest.ts      Entry point: build the graph from PAGES_DIR
├── query.ts       Entry point: answer questions via the agent
├── lint.ts        Entry point: graph healthcheck — merge duplicate entities
├── reset.ts       Entry point: wipe the graph
├── gen-corpus.ts  Synthetic wiki generator for the scale benchmark
└── benchmark.ts   Graph agent vs. naive full-context baseline
```

---

## Adapting for Confluence

The only file that needs changing is `src/pages.ts`. Replace `getAllPageFiles()` and `parsePage()` with functions that call the Confluence REST API:

```
GET /wiki/rest/api/content?spaceKey=DEV&type=page&expand=body.storage,metadata.labels
```

Map each Confluence page to the `Page` model (use the page ID as `id`, the page title as `title`, etc.) and return its body as `content`. The rest of the pipeline — graph building, LLM annotation, query agent — stays exactly the same.
