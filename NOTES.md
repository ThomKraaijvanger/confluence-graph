# Notes & roadmap

## Entity normalization

**Implemented — deterministic (lexical) normalization.** See `src/normalize.ts`.
Entity identity is a canonical `key` (trim + collapse whitespace + Unicode NFC +
lowercase); the display `name` from the first occurrence is preserved. So
`Kubernetes`, `kubernetes` and `  Kubernetes ` merge into one node. Runs inline
during ingest — fast, deterministic, side-effect-free.

**Implemented — semantic normalization via the graph healthcheck.** See
`src/lint.ts` — the `/lint` pass in the spirit of **Karpathy's llm-wiki**.
Lexical keys cannot know that `K8s` is `Kubernetes`; the lint pass shows the
LLM every entity of one kind, validates the proposed merge groups against the
actual catalog, and then either:

- **proposes** the merges for human review (`npm run lint`, the default), or
- **applies** them (`npm run lint -- --apply`),

depending on how much the organization trusts it. A merge repoints the
duplicate's page edges to the survivor and keeps the duplicate's name as an
**alias** on the surviving node — ingest and entity lookup resolve aliases, so
a merged duplicate cannot be re-created by the next ingest. Kept deliberately
*off* the ingest hot path so ingest stays predictable; cleanup is a deliberate,
auditable action that can be run manually or on a schedule.

Not covered yet: staleness (a concept superseded by a newer one) — the merge
machinery is there, but nothing detects it.

## Entity reuse hint at scale

**Implemented — lexical candidate retrieval.** The ingest prompt used to paste
the first N entity names into every annotation call, which stops working once
the catalog outgrows the window. `buildEntityHint()` in `src/ingest.ts` now
shows the model only the entities whose name or alias literally appears in the
page (People/Technologies/Teams are almost always literal mentions), topped up
with the most-connected entities for concept-level reuse. Deterministic, no
extra LLM calls, and the hint stays small however large the graph grows.

**Upgrade path — embedding retrieval.** Literal matching misses paraphrases
("the container platform" → Kubernetes). At client scale, store an embedding
(e.g. `mistral-embed`) on each entity node, add a Neo4j vector index, and hint
with the top-K entities most similar to the page snippet. More moving parts
(embedding calls at ingest, index management), so deliberately not part of the
demo. The same embeddings would also improve lint candidate generation.
