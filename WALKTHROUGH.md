# Code walkthrough — how a weak LLM builds and navigates the knowledge graph

A guided tour of the codebase, following the four demo beats (see `DEMO.md` for
the runbook itself). Written for whoever inherits this project: every section
explains not just *what* the code does but *why it is shaped that way*. Console
output below is real, captured from verification runs.

---

## 1. The mental model

`mistral-medium` cannot hold a whole Confluence space in its head. What it *can*
do reliably is make one small decision at a time. The entire system is built on
giving it exactly two kinds of small decision:

- **At ingest:** read *one* page and name the 2–6 things it is about.
- **At query:** look at what it has gathered so far and choose *one* tool call.

The Neo4j graph is the memory between those decisions. It has two layers with
very different trust levels:

```
   GROUND TRUTH (rebuildable, no LLM)
   ┌──────────────┐      ┌───────────────┐      ┌───────────────┐
   │project-atlas │  ×   │project-hermes │  ×   │project-nimbus │   × = no hyperlink
   └──────┬───────┘      └───┬───────┬───┘      └───┬───────┬───┘
          │ LEADS           │ LEADS │ USES         │ LED_BY │
   ───────┼─────────────────┼───────┼──────────────┼────────┼──────
          ▼                 ▼       ▼              ▼        ▼
      ( Amir Hassan :Person )    ( Kafka :Technology )
   EPHEMERAL (LLM-made, disposable)
```

No page links Atlas to Hermes to Nimbus — but all three connect through the
shared **Amir Hassan** node. The agent hops *down* into the ephemeral layer and
back *up* to reach pages the wiki's own structure never connected.

- **Ground-truth layer** — one `(:Page)` node per source document (full body
  stored on the node), `[:LINKS_TO]` edges from real wikilinks. Built without
  any LLM call: fast, free, always rebuildable. This layer is *never wrong*.
- **Ephemeral layer** — `(:Entity)` nodes (`Concept`/`Person`/`Technology`/`Team`)
  extracted by Mistral, connected to pages by typed edges (`USES`, `OWNED_BY`,
  `LEADS`, …). LLM guesses: they live only in Neo4j, and because they are
  **merged by a canonical key**, an entity mentioned by five pages becomes *one*
  node — a bridge.

> **Talking point.** The layer split is the load-bearing design decision.
> Everything trustworthy is cheap and rebuildable; everything LLM-made is
> disposable. "What happens when the LLM gets it wrong?" — delete the ephemeral
> layer and re-ingest; ground truth is untouched.

---

## 2. File map & data flow

Strict dependency direction — entry points at the top, shared plumbing below,
nothing imports upward.

| File | Role | Depends on |
|---|---|---|
| `ingest.ts` | Entry point: build the graph from `PAGES_DIR` (two passes) | pages, graph, llm, normalize |
| `query.ts` | Entry point: one-shot question or REPL → runs the agent | llm, graph |
| `lint.ts` | Entry point: healthcheck — find & merge duplicate entities | graph, llm, normalize |
| `reset.ts` | Entry point: wipe the graph | graph |
| `llm.ts` | All Mistral calls: page analysis, merge audit, the tool-calling agent | graph, models |
| `graph.ts` | All Neo4j Cypher: upserts, cleanup, merge, the six agent tools | models, normalize |
| `pages.ts` | Filesystem → `Page` model: frontmatter, wikilinks, content hash | models |
| `models.ts` | Zod schemas — the contracts everything shares | — |
| `normalize.ts` | Entity display name vs. canonical identity key | — |
| `gen-corpus.ts` / `benchmark.ts` | Synthetic wiki generator + graph-vs-naive comparison | llm, graph |

One rule worth stating out loud: **LLM output never reaches Cypher
unsanitized.** Entity kinds are validated against a fixed enum before becoming
node labels; relation strings are reduced to `[A-Z0-9_]` before becoming edge
types. Both matter because Cypher cannot parameterize labels or relationship
types — they must be string-interpolated, which is an injection risk this
codebase closes explicitly (`safeKind` / `safeRelType` in `graph.ts`).

---

## 3. `models.ts` — the contracts

`PageSchema` mirrors one source document:

```
id           // PAGES_DIR-relative path without extension ("services/user-api")
title, path, type, tags, author, created, updated
content      // full body — stored on the node; queries never touch the filesystem
oneLiner     // LLM-written summary; lets the agent scan pages without reading bodies
contentHash  // sha256 of content at last annotation — staleness detector
```

Two fields deserve emphasis. `id` is the *relative path*, not the bare
filename — so `services/auth.md` and `projects/auth.md` can never silently
merge into one node. And `contentHash` is written *only when annotation
succeeds*, which is what makes incremental ingest correct (§6).

`ENTITY_KINDS` is a fixed four-value enum, and that is a security decision as
much as a modeling one: each kind becomes a real Neo4j label (so the Browser
colors node types), and since labels must be interpolated into Cypher, the set
is closed and validated before interpolation.

The shape Mistral returns per page has `.catch()` on every field:

```ts
const AnalyzedEntitySchema = z.object({
  name: z.string(),
  kind: EntityKindSchema.catch("Concept"),
  description: z.string().catch(""),
  relation: z.string().catch("RELATES_TO"),
});
```

This is the "weak model" posture in one snippet: a stray kind or missing field
degrades to a default instead of the whole page's analysis being thrown away.
With a strong model you would tighten this; with a weak one, tolerance beats
strictness.

---

## 4. `normalize.ts` — what "the same entity" means

Bridges only form if two pages' mentions land on *one* node, so entity identity
is the most fragile thing in the system. It is solved in layers:

1. **Lexical (this file, at ingest):** every entity has a display `name`
   ("Kubernetes", first-seen casing preserved) and a canonical `key`
   ("kubernetes" — NFC-normalized, whitespace-collapsed, lowercased). Neo4j
   `MERGE`s on the key, so `Kubernetes`, `kubernetes` and `  Kubernetes  ` are
   one node.
2. **Prompt-level (§6):** the ingest hint shows Mistral the existing names so
   it reuses them instead of inventing variants.
3. **Semantic (§10):** string rules can never know that `K8s` *is*
   `Kubernetes`. That is the lint pass's job, and its merges persist as
   `aliases` on the surviving node.

`normalize.ts` is deliberately *only* lexical — fast, deterministic, zero LLM.
Anything requiring meaning is kept off the ingest hot path.

---

## 5. Beat 0 · ingest pass 1 — the structural layer

The demo opens with `npm run demo:reset`: wipe the database, then ingest
`./pages` (14 mock Confluence pages). Pass 1 involves no LLM at all.

**Parsing (`pages.ts`).** `parsePage()` reads a markdown file with
`gray-matter`, splitting YAML frontmatter from the body. It derives the id from
the relative path, pulls wikilinks with one regex — `[[target]]` or
`[[target|label]]` — and the caller hashes the body with `hashContent()`.

**Writing pages, deciding staleness.** For every file, pass 1 does three
things *in a careful order*:

```ts
const stored = await getPageById(page.id);          // 1. read old state FIRST
const fresh = stored?.oneLiner && stored?.contentHash === hash;
if (!fresh && content) stale.push({ page, ... });   // 2. queue for pass 2
await upsertPage(page);                             // 3. then overwrite the node
```

Reading before writing matters because the upsert refreshes `content` — if you
checked staleness afterwards you would compare the new content against itself.
The other subtlety lives in `upsertPage`: it only writes fields the caller
provided. Cypher's `SET p += $props` *deletes* a property when the value is
`null`, so a naive upsert from pass 1 (which knows nothing about annotations)
would wipe the `oneLiner` pass 2 wrote on the previous run — and every ingest
would re-annotate the whole corpus. Skipping `undefined` fields is a two-line
filter that lets the two passes safely co-own one node.

**Wiring links.** Wikilinks usually carry just a filename
(`[[project-atlas]]`) while ids are full paths, so ingest builds a
basename → ids map and resolves each target: exact id match wins, a unique
basename resolves, an ambiguous one is skipped with a console warning telling
the author to use the folder-qualified form (`[[services/auth]]`). Each page's
outgoing `LINKS_TO` edges are cleared and re-derived every run, so a link
removed from the source disappears from the graph.

> **Talking point.** Pause here before mentioning the LLM at all: "this much —
> a page node per document, an edge per hyperlink — we get for free,
> deterministically, from the documents themselves." Everything after this
> point is the LLM adding *navigability* on top of facts.

---

## 6. Beat 0 · ingest pass 2 — the annotation layer

Pass 2 loops over the stale queue; one Mistral call per page. The loop body in
order:

**1 · Build the reuse hint.** The model can only reuse entities it is *shown*.
Early versions pasted the first 80 entity names into every prompt — fine at
demo scale, useless once the catalog outgrows the window. `buildEntityHint()`
replaces that with retrieval:

```ts
// entities whose name or alias literally appears in this page (max 30) ...
if (keys.some((k) => mentions(haystack, k))) matched.push(e.name);
// ... plus the 10 most-connected entities, for concept-level reuse
const hubs = catalog.slice(0, HINT_HUBS).map((e) => e.name).filter(...);
```

The insight making this work: a Person, Technology or Team is almost always a
*literal mention* — if "Amir Hassan" isn't in the text, the page won't produce
that entity. Matching is word-boundary, on canonical keys, aliases included.
Deterministic, zero extra LLM calls, and the hint stays ~40 names whether the
graph holds 30 entities or 3,000.

**2 · Ask Mistral (`analyzePage` in `llm.ts`).** One call with
`responseFormat: json_object`. The system prompt fixes the output shape,
defines the four kinds, demands canonical Title Case names, and pushes two
behaviors that shape the whole graph: *always include named individuals in
leadership/ownership roles* (people are the best bridges), and *prefer reusing
the hinted names*. Parsing is defensive twice over — a brace-slice pulls the
JSON object out even if the model wrapped it in prose, then the tolerant Zod
schema absorbs field-level damage.

**3 · Write entities through the key index.** Each returned entity is resolved
through `keyIndex` — a map from canonical keys *and alias keys* to catalog
entries. A hit is a reuse (link to the existing node, even if the model said
"K8s" and the node is "Kubernetes"); a miss creates the node and adds it to the
in-memory catalog so *later pages in the same run* can match it. Then
`linkPageToEntity` writes the typed edge, relation sanitized by `safeRelType`.

**4 · Commit the annotation, clean up.** If the page was previously annotated
(content changed), its old entity edges are cleared — *only after* the new
analysis succeeded, so a failed API call never strips a page bare. Then
`oneLiner` and `contentHash` are written together: the hash marks "this
annotation reflects this content". After the loop, one sweep deletes entities
no page references anymore.

Real output, excerpt:

```
  Order Service — Service Page...
      ↻ reuse Project Atlas (Team) —[PART_OF]→
      ↻ reuse Java (Technology) —[WRITTEN_IN]→
      ↻ reuse Kafka (Technology) —[USES]→
      ↻ reuse Project Hermes (Team) —[DEPENDS_ON]→
  User API — Service Page...
      ↻ reuse JWT (Technology) —[USES]→
      + new   PostgreSQL (Technology) —[DEPENDS_ON]→

── Done: 14 annotated ──
```

The `↻ reuse` / `+ new` markers *are* the demo: every reuse line is a page
wiring itself into the existing graph through a shared waypoint. Run ingest a
second time and nothing happens (`0 annotated, 14 already up to date`); edit
one page and exactly that page is re-annotated, with orphaned entities swept:

```
  User API — Service Page...
      + new   Fatima Zahra (Person) —[MAINTAINED_BY]→
── Done: 1 annotated, 13 already up to date ──
… revert the edit, ingest again …
  swept 1 orphaned entities
── Done: 1 annotated, 13 already up to date ──
```

---

## 7. Beats 1–2 · reading the graph in the Browser

At `http://localhost:7474`, the point is the contrast between two queries.
Ground truth only:

```cypher
MATCH (p:Page)-[:LINKS_TO]->(q:Page) RETURN p, q
```

A sparse tree — the wiki's real structure, exactly as poor as real Confluence
spaces are. Then the full picture:

```cypher
MATCH (n) OPTIONAL MATCH (n)-[r]->(m) RETURN n, r, m
```

Dense, colored (each kind is a label, so the Browser colors Person nodes
differently from Technology), visibly hub-and-spoke around shared entities.
The money query names the bridges explicitly:

```cypher
MATCH (e:Person)<--(p:Page)
WITH e, collect(p.title) AS pages
WHERE size(pages) > 1
RETURN e.name AS person, pages
```

> **Talking point.** "Amir Hassan appears on both Project Atlas and Project
> Hermes — but no page links those two. The Person node *is* the link the wiki
> never had." That sentence is the whole pitch; everything else is machinery to
> make it true at scale.

---

## 8. Beat 3 · a new page wires itself in

`incoming/project-nimbus.md` is held out of the base ingest on purpose, and it
contains **zero wikilinks** to the existing corpus. In classic Confluence it
would be an island. `npm run demo:newpage` ingests just that file, live:

```
  Project Nimbus — Edge Caching Layer...
      + new   Project Nimbus (Concept) —[ABOUT]→
      ↻ reuse Java (Technology) —[WRITTEN_IN]→
      ↻ reuse Spring Boot (Technology) —[USES]→
      ↻ reuse Kafka (Technology) —[DEPENDS_ON]→
      ↻ reuse Amir Hassan (Person) —[LED_BY]→
      ↻ reuse Yuki Tanaka (Person) —[INVOLVES]→
      + new   Priya Sharma (Person) —[INVOLVES]→

── Done: 1 annotated ──
```

Five of seven entities reused: the page's only connection to the rest of the
graph is through the ephemeral layer, and the reuse hint made sure those
connections landed on existing nodes rather than duplicates. Ingest-side value
proposition: *knowledge files itself*.

---

## 9. Beat 4 · the query agent

`runQueryAgent()` in `llm.ts` is a plain tool-calling loop — no framework. Per
turn: send the conversation plus six tool definitions with
`toolChoice: "auto"`; if the model answers in prose, return it; if it calls
tools, execute each against Neo4j, append the results, go again. Two
Mistral-specific details cost real debugging time:

- The assistant message you append **must echo back the `toolCalls`** it
  made — Mistral matches each `role: "tool"` result to its call by
  `toolCallId` and rejects histories where the ids don't line up.
- The SDK is camelCase (`toolCallId`, `finishReason`, `toolChoice`) where the
  raw HTTP API is snake_case.

The six tools:

| Tool | What it runs | Why the agent needs it |
|---|---|---|
| `list_entities` | All entities + page counts, most-connected first, capped at 50 | Orientation — turn one on most queries |
| `get_entity_neighborhood` | One entity: its pages + entities it shares pages with | **The bridge hop.** Exact-key match wins; ambiguous names return candidates instead of a guess ("Java" can never resolve to "JavaScript") |
| `find_pages_by_entity` | Pages connected to an entity (partial match) | Fan-out from a person/tech to everything touching it |
| `search_pages` | Keyword `CONTAINS` over title, tags, one-liners | Entry point when no entity name is known |
| `get_related_pages` | Paths of length ≤ 2 from a page — includes Page→Entity←Page | "What's near this page", hyperlinks *and* shared entities |
| `get_page_content` | Full body off the node | Detail, used sparingly — one-liners carry most traversal |

Budgets: 8 tool turns; if the budget runs out the loop does *not* give up — it
appends "stop searching, answer now" and makes one final call with
`toolChoice: "none"`, forcing a synthesis from whatever was gathered. Around
every call, `chatWithRetry` retries 429s and 5xx (read from the SDK error's
`statusCode`) with linear backoff — that is what makes a 400-page batch ingest
survivable on a rate-limited key.

Real trace:

```
Query: What is Amir Hassan currently working on, and what else is he responsible for?

  [list_entities] {}
  [get_entity_neighborhood] {"entity":"Amir Hassan"}
  [find_pages_by_entity] {"entity":"Amir Hassan"}
  [get_page_content] {"pageId":"project-nimbus"}
  [get_page_content] {"pageId":"projects/project-hermes"}
  [get_page_content] {"pageId":"projects/project-atlas"}

Answer: Amir Hassan is currently tech leading Project Nimbus … also maintains
infrastructure responsibilities for Project Atlas and Project Hermes. (3 sources)
```

Read the trace aloud when demoing: orient → hop through the person node → fan
out → read only the three pages that matter. Six calls against a question whose
answer spans three pages with *no hyperlink path* between them.

---

## 10. `npm run lint` — the healthcheck

Lexical keys and the reuse hint prevent most duplicates, but no string rule
knows that `K8s` is `Kubernetes`. Left alone, such a pair silently partitions
the graph: some pages link to one node, some to the other, and the bridge
property degrades. The lint pass (in the spirit of Karpathy's `/lint` in
llm-wiki) fixes this off the hot path:

1. **Audit** — for each entity kind, one LLM call sees every entity (name,
   description, page count) and proposes merge groups. The prompt is
   deliberately conservative: abbreviations, spelling variants, unmistakable
   synonyms only; "when in doubt, do not merge".
2. **Validate** — every proposed name is resolved against the real catalog via
   canonical keys; anything the model hallucinated is skipped with a warning.
   The model proposes, the code disposes.
3. **Dry run by default** — `npm run lint` prints; only
   `npm run lint -- --apply` executes. This is the "trust dial": review-first
   for a cautious org, scheduled auto-apply for a trusting one.
4. **Merge** — repoint the duplicate's page edges onto the survivor (edge
   types preserved; re-created one by one because Cypher can't copy a
   relationship with a dynamic type), fold the duplicate's name into the
   survivor's `aliases`, delete the node.

Real output (seeded duplicate):

```
  auditing 17 Technology entities...

  K8s (1 pages) → Kubernetes (11 pages)  — K8s is a common abbreviation for Kubernetes.
    ✓ merged, 1 edges moved; "K8s" kept as alias
```

The alias is what makes the fix *permanent*, closing a loop across three
files: the ingest hint matches aliases against page text, the ingest key index
resolves alias keys to the surviving node, and `get_entity_neighborhood("K8s")`
finds Kubernetes. Verified end-to-end — a page mentioning only "K8s", ingested
after the merge:

```
  Order Service — Service Page...
      ↻ reuse Kubernetes (Technology) —[RUNS_ON]→
```

Without the alias that line would read `+ new K8s` and the duplicate would be
back. This is the answer to "won't the LLM just re-create every duplicate you
clean up?" — no, because merges write memory the ingest reads.

---

## 11. The benchmark — why a graph at all

`gen-corpus.ts` generates a seeded, deterministic fake company wiki at any size
(teams, projects, services, filler runbooks) *plus a ground-truth file*:
because generation is controlled, we know exactly which pages mention Amir
Hassan and which services consume Kafka. `benchmark.ts` then asks the same
question two ways on the same model:

- **Naive:** stuff every page into one prompt. Token cost grows linearly with
  corpus size until it falls off the context-window cliff.
- **Graph agent:** the tool loop. Cost is roughly constant in corpus size —
  the agent reads a handful of pages regardless of how many exist.

Recall is measured against the generator's ground truth, not vibes. One
honesty caveat to volunteer before a client asks: the naive baseline is a
strawman — nobody ships "paste the wiki into the prompt". The serious
comparison is against embedding retrieval (RAG), which this project
deliberately doesn't include. Expected honest answer: vectors win topical
questions ("pages about authentication"), the graph wins *relational* ones
("everything Amir owns", "who leads the teams whose services consume Kafka") —
which suggests hybrid, and `NOTES.md` sketches the embedding upgrade path.

---

## 12. Honest limits — the client FAQ

| Question | Honest answer |
|---|---|
| **Permissions?** | The graph flattens Confluence page restrictions — anyone who can query can reach any ingested page. Fine for one team over its own space (the intended scope); at broader rollout this is the first hard design problem. |
| **Deleted / renamed pages?** | The one known sync gap. Edited pages are handled (re-annotation via `contentHash`); a page deleted or renamed in the source leaves its old node in the graph until a reset. A reconciliation step in pass 1 is the natural fix. |
| **Extraction quality?** | Unmeasured. The benchmark scores traversal, not whether extracted entities are right. Before client scale: a small hand-labeled golden set (≈10 pages) to iterate the prompt against. |
| **Real Confluence?** | Replace `getAllPageFiles()` / `parsePage()` in `pages.ts` with REST API calls; use the Confluence page ID as `id`. Everything downstream is unchanged. |
| **Cost?** | Ingest: one small call per page, once (incremental thereafter). Query: ≤ 9 calls, mostly tiny. Lint: one call per entity kind. All on `mistral-medium` — the premise is that this works *without* a frontier model. |
| **Why not embeddings?** | Not "instead of" — "not yet". Lexical hint + graph covers the demo honestly with zero extra infrastructure; `NOTES.md` documents where embeddings slot in (hint retrieval, lint candidates, hybrid search) when scale demands it. |

---

## 13. Command crib sheet

| Command | Effect |
|---|---|
| `npm run demo:reset` | Wipe DB, ingest `./pages` — demo beat 0 (≈1 min, 14 LLM calls) |
| `npm run demo:newpage` | Ingest only `incoming/project-nimbus.md` — beat 3 |
| `npm run query "…"` | One-shot agent query (no arg → REPL) — beat 4 |
| `npm run ingest -- --delay 5 --limit 10` | Ingest with custom pacing / partial annotation |
| `npm run lint` / `npm run lint -- --apply` | Propose / apply duplicate-entity merges |
| `npm run reset` | Wipe the graph, nothing else |
| `npm run gen:corpus` → `bench:reset` → `benchmark` | Synthetic corpus → ingest it → graph-vs-naive comparison |

Prerequisites: Node ≥ 18, the Neo4j container running, `MISTRAL_API_KEY` in
`.env`. The Browser lives at `http://localhost:7474` (log in with the
`NEO4J_USER` / `NEO4J_PASSWORD` from your `.env`). Rehearse with
`npm run demo:reset` — entity extraction varies slightly per run, which is
itself worth mentioning in the demo: the ephemeral layer is a living artifact,
not a build product.
