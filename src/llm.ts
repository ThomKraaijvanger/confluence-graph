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
import { PageAnalysisSchema, type PageAnalysis } from "./models.js";
import {
  searchPagesByKeyword,
  findPagesByConceptName,
  getRelatedPages,
  listConcepts,
  getConceptNeighborhood,
} from "./graph.js";
import { getPageContent } from "./pages.js";

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

const MODEL = () => process.env.MISTRAL_MODEL ?? "mistral-large-latest";

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
      const is429 =
        err instanceof Error &&
        (err.message.includes("429") || err.message.includes("rate_limited"));
      if (is429 && attempt < maxRetries) {
        const wait = 10_000 * (attempt + 1);
        process.stderr.write(`[rate limited, retrying in ${wait / 1000}s]\n`);
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
  existingConcepts: string[]
): Promise<PageAnalysis> {
  const conceptHint = existingConcepts.length
    ? `Reuse these existing concepts where appropriate: ${existingConcepts.slice(0, 60).join(", ")}.`
    : "No concepts exist yet — create new ones as needed.";

  const response = await chatWithRetry({
    model: MODEL(),
    responseFormat: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You are building a semantic knowledge graph over documents.
For each document, return JSON with:
  - oneLiner: one sentence (max 15 words) describing the page
  - concepts: 2–5 concept nodes this page belongs to.
    Each concept: { name (short, Title Case), description (one sentence), isNew (bool) }

Return ONLY valid JSON. No markdown, no explanation.`,
      },
      {
        role: "user",
        content: `Page: ${pageId}\nTitle: ${title}\n${conceptHint}\n\n${snippet}`,
      },
    ],
  });

  const raw = response.choices?.[0]?.message?.content ?? "{}";
  const parsed = JSON.parse(typeof raw === "string" ? raw : "{}");
  return PageAnalysisSchema.parse(parsed);
}

// ── Query agent ───────────────────────────────────────────────────────────────

const TOOLS: ChatCompletionRequestTool[] = [
  {
    type: "function",
    function: {
      name: "list_concepts",
      description: "List all concept nodes with descriptions and page counts. Good first step to orient yourself.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_concept_neighborhood",
      description: "Get a concept's description, its related concepts, and all pages tagged with it.",
      parameters: {
        type: "object",
        required: ["concept"],
        properties: {
          concept: { type: "string", description: "Concept name (partial match works)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_pages_about_concept",
      description: "Find all pages linked to a concept by name.",
      parameters: {
        type: "object",
        required: ["concept"],
        properties: {
          concept: { type: "string" },
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
  | "list_concepts"
  | "get_concept_neighborhood"
  | "find_pages_about_concept"
  | "search_pages"
  | "get_related_pages"
  | "get_page_content";

async function dispatchTool(name: ToolName, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "list_concepts":            return listConcepts();
    case "get_concept_neighborhood": return getConceptNeighborhood(args["concept"] as string);
    case "find_pages_about_concept": return findPagesByConceptName(args["concept"] as string);
    case "search_pages":             return searchPagesByKeyword(args["keywords"] as string[]);
    case "get_related_pages":        return getRelatedPages(args["pageId"] as string);
    case "get_page_content":         return getPageContent(args["pageId"] as string) ?? "Page not found.";
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
Start with list_concepts or search_pages to orient yourself. Synthesise a clear answer with page paths as citations.`,
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
