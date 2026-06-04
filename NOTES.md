# Notes & roadmap

## Entity normalization

**Implemented — deterministic (lexical) normalization.** See `src/normalize.ts`.
Entity identity is a canonical `key` (trim + collapse whitespace + Unicode NFC +
lowercase); the display `name` from the first occurrence is preserved. So
`Kubernetes`, `kubernetes` and `  Kubernetes ` merge into one node. Runs inline
during ingest — fast, deterministic, side-effect-free.

**Out of scope (for now) — semantic normalization.** Lexical keys cannot merge
synonyms or fold stale/near-duplicate entities: `Kubernetes` vs `K8s`,
`Spring Boot` vs `Spring`, or an old concept superseded by a newer one. That
needs meaning, not string rules.

The intended design — in the spirit of **Karpathy's `/lint` in llm-wiki**: a
separate, explicitly-invoked **graph healthcheck** that scans for duplication,
staleness and orphan nodes/edges, and then either:

- **proposes** fixes for human review (merge A into B, retire stale concept), or
- **applies** them autonomously,

depending on how much the organization trusts it. Kept deliberately *off* the
ingest hot path so ingest stays predictable; cleanup is a deliberate, auditable
action that can be run manually or on a schedule (periodic/programmatic).

Not built yet. Candidate entry point: `npm run lint` → an agent pass over the
graph using the existing query tools.
