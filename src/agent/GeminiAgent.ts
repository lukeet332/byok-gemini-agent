// The local agent engine. Runs entirely client-side: it talks to Google AI
// Studio's generateContent endpoint directly over fetch, and when the model asks
// to call a tool it executes that tool on-device (here: a Notion API write) and
// feeds the result back. No backend of ours is ever involved.

import { Content, FunctionCall, Part, Tool } from "../types";
import { getSecret, StorageKeys } from "../storage/SecureStorage";

const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const NOTION_API = "https://api.notion.com/v1/pages";
const NOTION_VERSION = "2022-06-28";

// Safety valve: never loop forever if the model keeps requesting tools.
const MAX_TOOL_ROUNDS = 6;

// ---- Tool schema (Gemini function declarations) ----
// Add new tools here AND register an executor in `TOOL_EXECUTORS` below.
export const TOOLS: Tool[] = [
  {
    functionDeclarations: [
      {
        name: "create_notion_task",
        description:
          "Create a new task as a page in the user's Notion database. " +
          "Use this whenever the user wants to capture a to-do, reminder, or task.",
        parameters: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description: "The title / text of the task to create.",
            },
          },
          required: ["title"],
        },
      },
    ],
  },
];

// A tool executor takes the model-supplied args and returns a JSON-serialisable
// result object. Whatever it returns is handed straight back to the model.
type ToolExecutor = (args: Record<string, unknown>) => Promise<Record<string, unknown>>;

const TOOL_EXECUTORS: Record<string, ToolExecutor> = {
  create_notion_task: createNotionTask,
};

// Create a Notion page (a "task") in the configured database.
async function createNotionTask(
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const title = typeof args.title === "string" ? args.title : String(args.title ?? "");

  const [notionKey, databaseId] = await Promise.all([
    getSecret(StorageKeys.NOTION_API_KEY),
    getSecret(StorageKeys.NOTION_DATABASE_ID),
  ]);

  if (!notionKey || !databaseId) {
    return {
      success: false,
      error:
        "Notion is not configured. Add NOTION_API_KEY and NOTION_DATABASE_ID in Settings.",
    };
  }

  const body = {
    parent: { database_id: databaseId },
    properties: {
      // Assumes the database's title property is named "Name" (the Notion default).
      Name: {
        title: [{ text: { content: title } }],
      },
    },
  };

  const res = await fetch(NOTION_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${notionKey}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  // Return Notion's raw JSON to the model either way so it can react to errors.
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return {
    success: res.ok,
    status: res.status,
    notion: json,
  };
}

// ---- Gemini call ----

interface GeminiCandidate {
  content?: Content;
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
  error?: { message?: string };
  promptFeedback?: { blockReason?: string };
}

async function callGemini(contents: Content[]): Promise<Content> {
  const apiKey = await getSecret(StorageKeys.GEMINI_API_KEY);
  if (!apiKey) {
    throw new Error("No Gemini API key. Add GEMINI_API_KEY in Settings.");
  }

  const res = await fetch(`${GEMINI_ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents, tools: TOOLS }),
  });

  const data = (await res.json().catch(() => ({}))) as GeminiResponse;

  if (!res.ok) {
    throw new Error(data.error?.message ?? `Gemini request failed (${res.status}).`);
  }
  if (data.promptFeedback?.blockReason) {
    throw new Error(`Request blocked by Gemini: ${data.promptFeedback.blockReason}.`);
  }

  const content = data.candidates?.[0]?.content;
  if (!content) {
    throw new Error("Gemini returned no content.");
  }
  return content;
}

// Pull every functionCall part out of a model turn (there can be more than one).
function functionCallsIn(content: Content): FunctionCall[] {
  return (content.parts ?? [])
    .map((p) => p.functionCall)
    .filter((fc): fc is FunctionCall => !!fc);
}

// Concatenate any text parts of a model turn into a single string.
function textIn(content: Content): string {
  return (content.parts ?? [])
    .map((p) => p.text)
    .filter((t): t is string => typeof t === "string")
    .join("")
    .trim();
}

export interface AgentCallbacks {
  // Subtle status line for the UI (e.g. "Running tool: create_notion_task..."),
  // or null to clear it.
  onStatus?: (status: string | null) => void;
}

export interface AgentResult {
  // The full, updated conversation history (model + tool turns appended).
  contents: Content[];
  // The model's final natural-language reply.
  reply: string;
}

// Run a single user turn to completion: call Gemini, execute any tool calls it
// makes, feed results back, and loop until the model produces a text answer.
//
// `contents` should already include the new user message as its last entry.
export async function runAgentTurn(
  contents: Content[],
  callbacks: AgentCallbacks = {}
): Promise<AgentResult> {
  const history: Content[] = [...contents];
  const setStatus = callbacks.onStatus ?? (() => {});

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    setStatus("Thinking...");
    const modelTurn = await callGemini(history);

    // Always record the model's turn verbatim — the API requires the exact
    // functionCall object to be present before the matching functionResponse.
    history.push(modelTurn);

    const calls = functionCallsIn(modelTurn);
    if (calls.length === 0) {
      // Plain text answer: we're done.
      setStatus(null);
      return { contents: history, reply: textIn(modelTurn) || "(no response)" };
    }

    // Execute every requested tool and build one user turn of functionResponses.
    const responseParts: Part[] = [];
    for (const call of calls) {
      setStatus(`Running tool: ${call.name}...`);
      const executor = TOOL_EXECUTORS[call.name];
      let result: Record<string, unknown>;
      if (!executor) {
        result = { success: false, error: `Unknown tool: ${call.name}` };
      } else {
        try {
          result = await executor(call.args ?? {});
        } catch (err) {
          result = { success: false, error: String(err) };
        }
      }
      responseParts.push({
        functionResponse: { name: call.name, response: result },
      });
    }

    history.push({ role: "user", parts: responseParts });
    // Loop: feed the tool results back to the model for another round.
  }

  setStatus(null);
  throw new Error(
    `Agent stopped after ${MAX_TOOL_ROUNDS} tool rounds without a final answer.`
  );
}
