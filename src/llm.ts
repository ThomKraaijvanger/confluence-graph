/**
 * All LLM interaction lives here.
 *
 * Uses the Mistral SDK (api.mistral.ai).
 * Configure via MISTRAL_API_KEY and MISTRAL_MODEL in .env.
 *
 * Two entry points:
 *   analyzePage()   – called during ingest; returns a one-liner + concept tags
 *   runQueryAgent() – agentic loop that traverses the graph to answer questions
 *
 * Mistral-specific notes:
 *   - Tool results use `toolCallId` (not `tool_call_id`)
 *   - The assistant message must echo back `toolCalls` so Mistral can match IDs
 *   - `finishReason` / `toolChoice` (camelCase, not snake_case)
 */

import { Mistral } from "@mistralai/mistralai";
import type {
  ChatCompletionRequestMessage,
  ChatCompletionRequestTool,
} from "@mistralai/mistralai/models/components/index.js";
import { PageAnalysisSchema, ENTITY_KINDS, type PageAnalysis } from "./models.js";
import {
  searchPagesByKeyword,
  findPagesByEntityName,
  getRelatedPages,
  listEntities,
  getEntityNeighborhood,
  getPageContent,
} from "./graph.js";

// ── Client ────────────────────────────────────────────────────────────────────

let client: Mistral | null = null;

function getClient(): Mistral {
  if (!client) {
    const apiKey = process.env.MISTRAL_API_KEY;
    if (!apiKey) throw new Error("MISTRAL_API_KEY not set");
    client = new Mistral({ apiKey });
  }
  return client;
}

const MODEL = () => process.env.MISTRAL_MODEL ?? "mistral-medium-latest";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function chatWithRetry(
  params: Parameters<InstanceType<typeof Mistral>["chat"]["complete"]>[0],
  maxRetries = 4
): Promise<Awaited<ReturnType<InstanceType<typeof Mistral>["chat"]["complete"]>>> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await getClient().chat.complete(params);
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      // Retry rate limits and transient server/network errors (the cause of the
      // occasional dropped page during a batch ingest).
      const retryable =
        m.includes("429") || m.includes("rate_limited") ||
        m.includes("500") || m.includes("502") || m.includes("503") ||
        m.includes("timeout") || m.includes("ECONN") || m.includes("fetch failed");
      if (retryable && attempt < maxRetries) {
        const wait = 10_000 * (attempt + 1);
        process.stderr.write(`[retrying in ${wait / 1000}s: ${m.split("\n")[0].slice(0, 80)}]\n`);
        await sleep(wait);
      } else {
        throw err;
      }
    }
  }
  throw new Error("unreachable");
}

// ── Ingest: page analysis ─────────────────────────────────────────────────────

export async function analyzePage(
  pageId: string,
  title: string,
  snippet: string,        // title + tags + first ~300 chars — keep it small
  existingEntities: string[]
): Promise<PageAnalysis> {
  const entityHint = existingEntities.length
    ? `Existing entities in the graph — REUSE these exact names where they apply (do not invent variants): ${existingEntities.slice(0, 80).join(", ")}.`
    : "No entities exist yet — create new ones as needed.";

  const response = await chatWithRetry({
    model: MODEL(),
    responseFormat: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You are building a semantic knowledge graph over documents.
For each document, return JSON with:
  - oneLiner: one sentence (max 15 words) describing the page
  - entities: 2–6 entities this page references. Each entity:
      { name, kind, description, relation }
      • kind: one of ${ENTITY_KINDS.join(", ")}.
        Concept = a topic/area; Person = a named individual; Technology = a tool,
        language or system; Team = a named group.
      • name: canonical and reusable — use a person's real name, the technology's
        proper name, etc. (Title Case). The SAME entity may be shared by many pages.
      • description: one sentence.
      • relation: SHORT_UPPER_SNAKE verb for how THIS page relates to the entity,
        e.g. USES, OWNED_BY, MAINTAINED_BY, MENTIONS, DEPENDS_ON, ABOUT, RUNS_ON.

Always include every named individual in a leadership, ownership or responsibility
role (leads, owners, maintainers) as a Person — there may be several on one page.
Prefer reusing existing entity names so pages that share a person/technology link up.
Return ONLY valid JSON. No markdown, no explanation.`,
      },
      {
        role: "user",
        content: `Page: ${pageId}\nTitle: ${title}\n${entityHint}\n\n${snippet}`,
      },
    ],
  });

  const raw = response.choices?.[0]?.message?.content ?? "{}";
  const text = typeof raw === "string" ? raw : "{}";
  // The model occasionally wraps JSON in prose or a code fence; pull out the object.
  const jsonText = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1) || "{}";
  const parsed = PageAnalysisSchema.parse(JSON.parse(jsonText));
  // Drop entities the model left unnamed.
  parsed.entities = parsed.entities.filter((e) => e.name.trim());
  return parsed;
}

// ── Query agent ───────────────────────────────────────────────────────────────

const TOOLS: ChatCompletionRequestTool[] = [
  {
    type: "function",
    function: {
      name: "list_entities",
      description: "List all ephemeral entity nodes (Concept/Person/Technology/Team) with their kind, description and page counts. Good first step to orient yourself.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_entity_neighborhood",
      description: "Get an entity's kind and description, the entities it shares pages with, and all pages connected to it. Use this to hop between pages that share a person, technology or team but have no direct link.",
      parameters: {
        type: "object",
        required: ["entity"],
        properties: {
          entity: { type: "string", description: "Entity name (partial match works)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_pages_by_entity",
      description: "Find all pages connected to an entity by name (e.g. all pages that use a technology, or mention a person).",
      parameters: {
        type: "object",
        required: ["entity"],
        properties: {
          entity: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_pages",
      description: "Keyword search across page titles, tags, and one-liner descriptions.",
      parameters: {
        type: "object",
        required: ["keywords"],
        properties: {
          keywords: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_related_pages",
      description: "Get pages related to a specific page via links and shared concepts.",
      parameters: {
        type: "object",
        required: ["pageId"],
        properties: {
          pageId: { type: "string", description: "Page ID (slug)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_page_content",
      description: "Fetch the full text of a page. Use sparingly — only when the one-liner is not enough.",
      parameters: {
        type: "object",
        required: ["pageId"],
        properties: {
          pageId: { type: "string" },
        },
      },
    },
  },
];

type ToolName =
  | "list_entities"
  | "get_entity_neighborhood"
  | "find_pages_by_entity"
  | "search_pages"
  | "get_related_pages"
  | "get_page_content";

async function dispatchTool(name: ToolName, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "list_entities":            return listEntities();
    case "get_entity_neighborhood":  return getEntityNeighborhood(args["entity"] as string);
    case "find_pages_by_entity":     return findPagesByEntityName(args["entity"] as string);
    case "search_pages":             return searchPagesByKeyword(args["keywords"] as string[]);
    case "get_related_pages":        return getRelatedPages(args["pageId"] as string);
    case "get_page_content":         return (await getPageContent(args["pageId"] as string)) ?? "Page not found.";
  }
}

export async function runQueryAgent(
  question: string,
  onToolCall?: (name: string, args: unknown) => void
): Promise<string> {
  const messages: ChatCompletionRequestMessage[] = [
    {
      role: "system",
      content: `You are a knowledge graph navigator. Use the tools to find relevant pages and answer the user's question.
Start with list_entities or search_pages to orient yourself, then follow entities (people, technologies, teams) to reach pages that have no direct hyperlink between them. Synthesise a clear answer with page paths as citations.`,
    },
    { role: "user", content: question },
  ];

  for (let i = 0; i < 8; i++) {
    const response = await chatWithRetry({
      model: MODEL(),
      messages,
      tools: TOOLS,
      toolChoice: "auto",
    });

    const choice = response.choices?.[0];
    if (!choice) break;

    const msg = choice.message;
    if (!msg) break;
    const content = typeof msg.content === "string" ? msg.content : "";

    // Mistral requires the assistant message to include toolCalls so it can
    // match tool result IDs back to the call that produced them.
    messages.push({
      role: "assistant",
      content,
      ...(msg.toolCalls?.length ? { toolCalls: msg.toolCalls } : {}),
    } as ChatCompletionRequestMessage);

    if (choice.finishReason === "stop" || !msg.toolCalls?.length) {
      return content || "(no response)";
    }

    for (const call of msg.toolCalls) {
      const name = call.function.name as ToolName;
      const rawArgs = call.function.arguments;
      const args = (typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs) as Record<string, unknown>;
      onToolCall?.(name, args);
      const result = await dispatchTool(name, args);
      messages.push({
        role: "tool",
        toolCallId: call.id,
        name,
        content: JSON.stringify(result),
      });
    }
  }

  return "(agent reached iteration limit)";
}
