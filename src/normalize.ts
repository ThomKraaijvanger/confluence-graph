/**
 * Deterministic entity-name normalization.
 *
 * Entity identity in the graph is decided by MERGE on a canonical *key* (see
 * graph.upsertEntity). This module produces that key, plus a cleaned display
 * name. The two are kept separate on purpose:
 *
 *   • name  – what we show ("Kubernetes", "OAuth", "Amir Hassan")
 *   • key   – what we dedup on  ("kubernetes", "oauth", "amir hassan")
 *
 * So "Kubernetes", "kubernetes" and "  Kubernetes " all collapse to one node
 * while the human-readable casing of the first occurrence is preserved. This is
 * purely lexical — it fixes case/whitespace/unicode drift, nothing more.
 *
 * ── Out of scope: semantic normalization ───────────────────────────────────
 * Lexical keys do NOT merge synonyms or near-duplicates: "Kubernetes" vs "K8s",
 * "Spring Boot" vs "Spring", or a stale concept that should be folded into a
 * newer one. That requires meaning, not string rules.
 *
 * The intended home for that is a separate, explicitly-invoked healthcheck —
 * in the spirit of Karpathy's `/lint` in llm-wiki: a pass that scans the graph
 * for duplication / staleness / orphans and either *proposes* fixes (review
 * before apply) or applies them autonomously, depending on how much the org
 * trusts it. Deliberately kept out of the ingest hot path: ingest stays fast,
 * deterministic and side-effect-free; cleanup is a deliberate, auditable action.
 * Not implemented yet — tracked in NOTES.md.
 */

/**
 * Cleaned, human-readable display name: trimmed, internal whitespace collapsed,
 * and Unicode normalized (NFC) so accents compare consistently (e.g. "Müller").
 * Casing is preserved.
 */
export function cleanName(raw: string): string {
  return raw.normalize("NFC").replace(/\s+/g, " ").trim();
}

/**
 * Canonical identity key for MERGE/dedup: the cleaned name, case-folded.
 * Equal display names always yield equal keys, so node identity stays stable.
 */
export function entityKey(raw: string): string {
  return cleanName(raw).toLowerCase();
}
