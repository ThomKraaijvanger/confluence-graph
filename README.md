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
    ┌─────────────────────────────────────────┐
    │  (:Page) ──[:LINKS_TO]──> (:Page)       │  structural layer
    │  (:Page) ──[:ABOUT]────> (:Concept)     │  semantic layer (LLM-created)
    └─────────────────────────────────────────┘
         │
         │  npm run query "..."
         ▼
    LLM agent (tool-calling loop)
    → list_concepts → find_pages_about_concept → get_page_content → answer
```

**Structural layer** — built without LLM involvement. One `(:Page)` node per document; `[:LINKS_TO]` edges from wikilinks in the content.

**Semantic layer** — built by the LLM during ingest. The LLM reads a short snippet of each page and assigns it to 2–5 `(:Concept)` nodes (e.g. "Behavioral Engineering", "Distributed Systems"). Concept nodes live only in Neo4j — they have no counterpart in the source documents. They act as semantic waypoints so the query agent can navigate by topic without reading every page.

---

## Prerequisites

- **Node.js** ≥ 18
- **Docker or Podman** (for Neo4j)
- An **OpenAI-compatible LLM API** (Mistral, Azure OpenAI, a self-hosted model, etc.)

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
| `LLM_API_KEY` | API key for your LLM provider |
| `LLM_MODEL` | Model ID (e.g. `mistral-medium-latest`, `gpt-4o`) |
| `LLM_BASE_URL` | Base URL of the OpenAI-compatible endpoint. Leave blank for OpenAI. For Mistral: `https://api.mistral.ai/v1` |
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

Wikilinks in the content (`[[other-page-slug]]`) are automatically extracted and become `[:LINKS_TO]` edges in the graph.

**For Confluence**: fetch pages via the Confluence REST API and write them as markdown files into `PAGES_DIR`. The ingest step then picks them up. A Confluence → markdown fetcher is a natural next step but is out of scope here.

---

## Ingesting pages

```bash
npm run ingest
```

This runs in two passes:

1. **Structural pass** (no LLM): creates all `(:Page)` nodes and `[:LINKS_TO]` edges. Fast, free.
2. **Annotation pass** (LLM): for each unannotated page, sends a short snippet to the LLM and gets back a one-liner description and 2–5 concept tags. Creates `(:Concept)` nodes and `[:ABOUT]` edges.

The annotation pass is **incremental** — if you stop and restart, already-annotated pages are skipped.

### Ingest flags

```bash
# Custom delay between LLM calls (default: 3 seconds — helps with rate limits)
npx tsx src/ingest.ts --delay 5

# Annotate only the first N unannotated pages (useful for testing)
npx tsx src/ingest.ts --limit 10
```

### Typical token usage

The LLM receives a small snippet per page: title + tags + first 300 characters of content. This is roughly 100–150 tokens per page. For 100 pages that is ~12,000 tokens total for the annotation pass.

---

## Querying

```bash
# One-shot question
npm run query "What pages cover authentication and OAuth?"

# Interactive REPL
npm run query
```

The query agent runs a tool-calling loop. It starts by listing concepts or searching by keyword to orient itself, then traverses the graph to build an answer. Tool calls are printed to the console so you can follow the reasoning:

```
Query: What pages cover authentication and OAuth?

  [list_concepts] {}
  [find_pages_about_concept] {"concept":"authentication"}
  [get_related_pages] {"pageId":"oauth-guide"}

Answer:

Here are the relevant pages:
1. **OAuth 2.0 Guide** — `docs/auth/oauth-guide.md`
   ...
```

---

## Graph schema

### Nodes

| Label | Description |
|---|---|
| `(:Page)` | One per source document |
| `(:Concept)` | LLM-created semantic topic node; no counterpart in source docs |

**Page properties:** `id`, `title`, `path`, `type`, `tags`, `author`, `created`, `updated`, `oneLiner`

**Concept properties:** `name`, `description`

### Relationships

| Relationship | Meaning |
|---|---|
| `(:Page)-[:LINKS_TO]->(:Page)` | Explicit wikilink between pages |
| `(:Page)-[:ABOUT]->(:Concept)` | This page covers this concept |

### Useful Cypher queries

Browse the graph in the Neo4j Browser at `http://localhost:7474/browser/`:

```cypher
-- All nodes and edges
MATCH (n)-[r]->(m) RETURN n, r, m LIMIT 300

-- Pages grouped by concept
MATCH (p:Page)-[:ABOUT]->(c:Concept)
RETURN p, c

-- Find pages about a topic
MATCH (p:Page)-[:ABOUT]->(c:Concept)
WHERE toLower(c.name) CONTAINS 'authentication'
RETURN p.title, p.path, p.oneLiner, collect(c.name) AS concepts

-- Pages that link to a specific page
MATCH (p:Page)-[:LINKS_TO]->(target:Page {id: 'oauth-guide'})
RETURN p.title, p.path
```

---

## Agent tools

The query agent has six tools:

| Tool | Description |
|---|---|
| `list_concepts` | List all concept nodes with page counts — good starting point |
| `get_concept_neighborhood` | A concept's related concepts and all pages tagged with it |
| `find_pages_about_concept` | All pages tagged with a concept (partial name match) |
| `search_pages` | Keyword search on title, tags, and one-liner |
| `get_related_pages` | Pages connected to a given page via links and shared concepts |
| `get_page_content` | Full text of a page — used sparingly for detail |

---

## Project structure

```
src/
├── models.ts    Zod schemas for Page, Concept, PageAnalysis
├── graph.ts     All Neo4j interaction (CRUD + query tools)
├── pages.ts     Reads source pages from PAGES_DIR and parses markdown
├── llm.ts       LLM calls — analyzePage() for ingest, runQueryAgent() for queries
├── ingest.ts    Entry point: build the graph from PAGES_DIR
└── query.ts     Entry point: answer questions via the agent
```

---

## Adapting for Confluence

The only file that needs changing is `src/pages.ts`. Replace `getAllPageFiles()` and `parsePage()` with functions that call the Confluence REST API:

```
GET /wiki/rest/api/content?spaceKey=DEV&type=page&expand=body.storage,metadata.labels
```

Map each Confluence page to the `Page` model (use the page ID as `id`, the page title as `title`, etc.) and return its body as `content`. The rest of the pipeline — graph building, LLM annotation, query agent — stays exactly the same.
