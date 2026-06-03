/**
 * All LLM interaction lives here.
 *
 * Uses the OpenAI-compatible API so it works with any endpoint:
 * Mistral, Azure OpenAI, a self-hosted model, a company proxy, etc.
 * Configure via LLM_BASE_URL, LLM_API_KEY, and LLM_MODEL in .env.
 *
 * Two entry points:
 *   analyzePage()   – called during ingest; returns a one-liner + concept tags
 *   runQueryAgent() – agentic loop that traverses the graph to answer questions
 */

import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions.js";
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

function getClient(): OpenAI {
  return new OpenAI({
    apiKey: process.env.LLM_API_KEY ?? "no-key",
    baseURL: process.env.LLM_BASE_URL,  // undefined = OpenAI default
  });
}

const MODEL = () => process.env.LLM_MODEL ?? "gpt-4o-mini";

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function chatWithRetry(
  params: Parameters<OpenAI["chat"]["completions"]["create"]>[0],
  maxRetries = 4
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await getClient().chat.completions.create(params) as OpenAI.Chat.Completions.ChatCompletion;
    } catch (err: unknown) {
      const is429 = err instanceof OpenAI.APIError && err.status === 429;
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
    response_format: { type: "json_object" },
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

  const raw = response.choices[0]?.message?.content ?? "{}";
  const parsed = JSON.parse(raw);
  return PageAnalysisSchema.parse(parsed);
}

// ── Query agent ───────────────────────────────────────────────────────────────

const TOOLS: ChatCompletionTool[] = [
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

type ToolName = "list_concepts" | "get_concept_neighborhood" | "find_pages_about_concept" | "search_pages" | "get_related_pages" | "get_page_content";

async function dispatchTool(name: ToolName, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "list_concepts":              return listConcepts();
    case "get_concept_neighborhood":   return getConceptNeighborhood(args["concept"] as string);
    case "find_pages_about_concept":   return findPagesByConceptName(args["concept"] as string);
    case "search_pages":               return searchPagesByKeyword(args["keywords"] as string[]);
    case "get_related_pages":          return getRelatedPages(args["pageId"] as string);
    case "get_page_content":           return getPageContent(args["pageId"] as string) ?? "Page not found.";
  }
}

export async function runQueryAgent(
  question: string,
  onToolCall?: (name: string, args: unknown) => void
): Promise<string> {
  const messages: ChatCompletionMessageParam[] = [
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
      tool_choice: "auto",
    });

    const choice = response.choices[0];
    if (!choice) break;

    const msg = choice.message;
    messages.push(msg);

    if (choice.finish_reason === "stop" || !msg.tool_calls?.length) {
      return msg.content ?? "(no response)";
    }

    for (const call of msg.tool_calls) {
      if (call.type !== "function") continue;
      const name = call.function.name as ToolName;
      const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
      onToolCall?.(name, args);
      const result = await dispatchTool(name, args);
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
    }
  }

  return "(agent reached iteration limit)";
}
