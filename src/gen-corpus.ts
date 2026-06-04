#!/usr/bin/env tsx
/**
 * Synthetic corpus generator — a fake company wiki at arbitrary scale.
 *
 * Produces markdown pages (frontmatter + wikilinks) into an output directory,
 * plus a _ground_truth.json describing the answers to our benchmark questions.
 * Generation is deterministic (seeded), so the ground truth is stable across runs.
 *
 *   npx tsx src/gen-corpus.ts --pages 400 --out corpus --seed 1
 *
 * The cast (people, teams, projects, technologies) is controlled so we KNOW,
 * e.g., exactly which pages mention "Amir Hassan" and which services consume
 * Kafka — letting the benchmark measure recall, not just vibes.
 */
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";

// ── CLI ─────────────────────────────────────────────────────────────────────
const flags = parseFlags(process.argv.slice(2));
const TARGET = Math.max(20, Number(flags["pages"] ?? 400));
const OUT = String(flags["out"] ?? "corpus");
const SEED = Number(flags["seed"] ?? 1);

function parseFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++)
    if (argv[i].startsWith("--") && argv[i + 1]) out[argv[i].slice(2)] = argv[++i];
  return out;
}

// ── Deterministic PRNG (mulberry32) ──────────────────────────────────────────
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(SEED);
const pick = <T,>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];
const sample = <T,>(arr: T[], n: number): T[] => {
  const c = [...arr];
  for (let i = c.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [c[i], c[j]] = [c[j], c[i]]; }
  return c.slice(0, n);
};

// ── Cast ──────────────────────────────────────────────────────────────────────
const PEOPLE = [
  "Amir Hassan", "Priya Sharma", "Yuki Tanaka", "Jan de Vries", "Lucas Müller",
  "Sofia Andersen", "Chen Wei", "Maria Garcia", "Tom Bakker", "Aisha Khan",
  "Diego Fernández", "Nina Petrova", "Omar Farouk", "Elena Rossi", "Kwame Mensah",
  "Hana Kim", "Liam O'Brien", "Fatima Zahra", "Noah Schmidt", "Ingrid Larsen",
];
const TECHS = [
  "Java", "Spring Boot", "Kafka", "Kubernetes", "PostgreSQL", "Redis", "gRPC",
  "Elasticsearch", "Prometheus", "Grafana", "Terraform", "GraphQL", "RabbitMQ",
];
const TEAM_NAMES = [
  "Platform", "Payments", "Identity", "Catalogue", "Logistics", "Messaging",
  "Search", "Analytics", "Billing", "Mobile", "Growth", "Reliability",
];
const PROJECT_NAMES = [
  "Atlas", "Hermes", "Nimbus", "Orion", "Vega", "Helios", "Titan", "Phoenix",
];
const SERVICE_KINDS = ["api", "service", "worker", "gateway", "processor", "scheduler"];

// ── Build the relational structure (ground truth lives here) ──────────────────
type Team = { name: string; slug: string; lead: string; members: string[] };
type Project = { name: string; slug: string; lead: string; techs: string[] };
type Service = { name: string; slug: string; team: Team; project: Project; techs: string[]; consumesKafka: boolean; topics: string[] };

const teams: Team[] = TEAM_NAMES.map((n) => ({
  name: `${n} Team`, slug: `team-${n.toLowerCase()}`,
  lead: "", members: [],
}));
const projects: Project[] = PROJECT_NAMES.map((n) => ({
  name: `Project ${n}`, slug: `project-${n.toLowerCase()}`,
  lead: "", techs: sample(TECHS, 3 + Math.floor(rand() * 3)),
}));

// Assign leads. Amir deliberately leads a couple of teams + a project so he is
// a known, multi-page figure (and a node behind several Kafka-consuming services).
teams.forEach((t, i) => { t.lead = i < 2 ? "Amir Hassan" : pick(PEOPLE); t.members = sample(PEOPLE, 3 + Math.floor(rand() * 3)); });
projects.forEach((p, i) => { p.lead = i === 1 ? "Amir Hassan" : pick(PEOPLE); });

// Services — the bulk of the corpus. Each owned by a team, part of a project.
const serviceCount = Math.max(10, Math.round(TARGET * 0.6));
const services: Service[] = [];
for (let i = 0; i < serviceCount; i++) {
  const team = pick(teams);
  const project = pick(projects);
  const kind = pick(SERVICE_KINDS);
  const consumesKafka = rand() < 0.45;
  services.push({
    name: `${team.name.split(" ")[0]} ${kind} ${String(i + 1).padStart(2, "0")}`,
    slug: `${kind}-${i + 1}`,
    team, project,
    techs: Array.from(new Set([...sample(TECHS, 2 + Math.floor(rand() * 3)), ...(consumesKafka ? ["Kafka"] : [])])),
    consumesKafka,
    topics: consumesKafka ? sample(["orders", "users", "inventory", "billing", "events", "audit"], 1 + Math.floor(rand() * 2)).map((t) => `${t}.v1`) : [],
  });
}

// ── Prose pools (varied so pages aren't identical) ────────────────────────────
const INTROS = [
  (s: string) => `${s} is a backend component in our platform.`,
  (s: string) => `This page documents ${s} and its operational details.`,
  (s: string) => `${s} handles a slice of the request path for internal and external clients.`,
  (s: string) => `Overview and ownership information for ${s}.`,
];
const NOTES = [
  "Deployments follow the standard blue/green rollout.",
  "On-call rotation is shared across the owning team.",
  "SLOs are tracked in the reliability dashboard.",
  "All changes require a reviewed pull request before merge.",
  "Configuration is managed through the central config service.",
  "Secrets are sourced from the managed secret store at boot.",
];

// ── Emit ──────────────────────────────────────────────────────────────────────
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

let written = 0;
const wl = (slug: string) => `[[${slug}]]`;
const fm = (o: Record<string, unknown>) =>
  "---\n" + Object.entries(o).map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.join(", ")}]` : v}`).join("\n") + "\n---\n\n";
const amirPages = new Set<string>();
const note = (slug: string, body: string) => { if (body.includes("Amir Hassan")) amirPages.add(slug); };

const write = (slug: string, front: Record<string, unknown>, body: string) => {
  writeFileSync(join(OUT, `${slug}.md`), fm(front) + body);
  note(slug, body);
  written++;
};

// Team pages
for (const t of teams) {
  const owned = services.filter((s) => s.team === t);
  const body =
    `# ${t.name}\n\n${t.name} owns several backend services. The team is led by **${t.lead}**.\n\n` +
    `## Members\n${[t.lead, ...t.members].map((m) => `- ${m}`).join("\n")}\n\n` +
    `## Owned services\n${owned.slice(0, 12).map((s) => `- ${wl(s.slug)}`).join("\n") || "- (none yet)"}\n\n` +
    `${pick(NOTES)}\n`;
  write(t.slug, { title: t.name, type: "team", tags: ["team", t.name.split(" ")[0].toLowerCase()], lead: t.lead }, body);
}

// Project pages
for (const p of projects) {
  const svc = services.filter((s) => s.project === p);
  const body =
    `# ${p.name}\n\n${p.name} is led by **${p.lead}**. It groups a set of related services and a shared technology stack.\n\n` +
    `## Stack\n${p.techs.map((t) => `- ${t}`).join("\n")}\n\n` +
    `## Services\n${svc.slice(0, 15).map((s) => `- ${wl(s.slug)}`).join("\n") || "- (none yet)"}\n\n` +
    `Infrastructure ownership for ${p.name} sits with ${wl(pick(teams).slug)}.\n`;
  write(p.slug, { title: p.name, type: "project", tags: ["project", p.name.split(" ")[1].toLowerCase()], lead: p.lead }, body);
}

// Service pages (the bulk)
for (const s of services) {
  const kafka = s.consumesKafka
    ? `\n## Messaging\nThis service consumes Kafka topics: ${s.topics.map((t) => `\`${t}\``).join(", ")}. See the owning team for topic governance.\n`
    : "";
  const body =
    `# ${s.name}\n\n${pick(INTROS)(s.name)} It is part of ${wl(s.project.slug)} and owned by ${wl(s.team.slug)} (team lead: ${s.team.lead}).\n\n` +
    `## Technology\n${s.techs.map((t) => `- ${t}`).join("\n")}\n` +
    kafka +
    `\n## Notes\n${sample(NOTES, 2).map((n) => `- ${n}`).join("\n")}\n`;
  write(s.slug, { title: s.name, type: "service", tags: ["service", ...s.techs.slice(0, 2).map((t) => t.toLowerCase().replace(/\s+/g, "-"))], team: s.team.name, project: s.project.name }, body);
}

// Filler pages (runbooks / standards / notes) to pad volume and add link noise
const fillerKinds = ["runbook", "standard", "guide", "postmortem", "meeting-notes"];
let fi = 0;
while (written < TARGET) {
  const kind = fillerKinds[fi % fillerKinds.length];
  const svc = pick(services);
  const author = pick(PEOPLE);
  const body =
    `# ${kind[0].toUpperCase() + kind.slice(1)} ${fi + 1}\n\nAuthor: ${author}.\n\n` +
    `This ${kind} relates to ${wl(svc.slug)} and ${wl(pick(services).slug)}. ${pick(NOTES)} ${pick(NOTES)}\n\n` +
    `Relevant technologies: ${sample(TECHS, 2).join(", ")}.\n`;
  write(`${kind}-${fi + 1}`, { title: `${kind} ${fi + 1}`, type: kind, tags: [kind], author }, body);
  fi++;
}

// ── Ground truth ──────────────────────────────────────────────────────────────
const kafkaServices = services.filter((s) => s.consumesKafka);
const kafkaTeams = [...new Set(kafkaServices.map((s) => s.team.slug))];
const kafkaLeads = [...new Set(kafkaServices.map((s) => s.team.lead))];
const groundTruth = {
  seed: SEED,
  totalPages: written,
  questions: {
    amir_works_on: {
      question: "What is Amir Hassan responsible for? List every page that involves him.",
      answerPages: [...amirPages].sort(),
      answerCount: amirPages.size,
    },
    kafka_consumer_team_leads: {
      question: "Who leads the teams that own services consuming Kafka topics?",
      hops: "service --consumes--> Kafka, service --owned_by--> team, team --led_by--> person",
      kafkaServiceCount: kafkaServices.length,
      teams: kafkaTeams.sort(),
      answerLeads: kafkaLeads.sort(),
    },
  },
};
writeFileSync(join(OUT, "_ground_truth.json"), JSON.stringify(groundTruth, null, 2));

console.log(`✓ Generated ${written} pages in ./${OUT}/`);
console.log(`  Amir Hassan appears on ${amirPages.size} pages`);
console.log(`  Kafka-consuming services: ${kafkaServices.length}; their team leads: ${kafkaLeads.join(", ")}`);
console.log(`  Ground truth → ./${OUT}/_ground_truth.json`);
