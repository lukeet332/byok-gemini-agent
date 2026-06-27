// The local agent engine. Runs entirely client-side: it talks to Google AI
// Studio's generateContent endpoint directly over fetch, and gives the model
// real tools so it can act like a CLI coding/agent assistant — but on a phone,
// on the free Gemini model, with genuine internet access:
//   - http_request:  call ANY API on the user's behalf (auth via {{SECRET}})
//   - fetch_webpage: read a web page and get back clean text to digest
// Stored credentials are referenced by name and substituted in on-device right
// before a request, so raw secret values never reach the model.

import { Content, FunctionCall, Part, Tool } from "../types";
import { getGeminiKey, getSecretValue, listSecretNames } from "../storage/SecureStorage";
import { appendError } from "../storage/ErrorLogStore";

const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// Safety valve: never loop forever if the model keeps requesting tools. Set
// high enough to allow deep multi-step chains (fetch -> API -> API -> ...).
const MAX_TOOL_ROUNDS = 12;
// Cap tool output fed back to the model (context + cost control).
const MAX_API_CHARS = 8000;
const MAX_PAGE_CHARS = 16000;

// ---- Tool schema (Gemini function declarations) ----
export const TOOLS: Tool[] = [
  {
    functionDeclarations: [
      {
        name: "http_request",
        description:
          "Make an HTTP request to ANY API on the user's behalf and get the " +
          "response back. To authenticate, reference the user's stored secrets " +
          "by name as {{SECRET_NAME}} inside the url, headers, or body — they are " +
          "substituted securely on-device and never exposed to you. The available " +
          "secret names are listed in the system instruction.",
        parameters: {
          type: "object",
          properties: {
            method: { type: "string", description: "HTTP method: GET, POST, PUT, PATCH, or DELETE." },
            url: { type: "string", description: "Full URL including https:// (may contain {{SECRET}} placeholders)." },
            headers: {
              type: "string",
              description:
                'Optional headers as a JSON object string, e.g. ' +
                '\'{"Authorization":"Bearer {{OPENAI_KEY}}","Content-Type":"application/json"}\'.',
            },
            body: { type: "string", description: "Optional request body string (often JSON). May contain {{SECRET}} placeholders." },
          },
          required: ["method", "url"],
        },
      },
      {
        name: "fetch_webpage",
        description:
          "Fetch a web page and return its readable text content (HTML markup, " +
          "scripts, and styles stripped out) so you can read and digest it as " +
          "context. Use this to look things up, read articles, or gather " +
          "information before answering.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "Full URL of the page to read, including https://." },
          },
          required: ["url"],
        },
      },
    ],
  },
];

// Replace every {{SECRET_NAME}} token with its stored value. Unknown names are
// left untouched so the model can see they weren't resolved.
async function substituteSecrets(text: string): Promise<string> {
  const matches = Array.from(text.matchAll(/\{\{\s*([A-Z0-9_]+)\s*\}\}/g));
  let out = text;
  for (const m of matches) {
    const value = await getSecretValue(m[1]);
    if (value !== null) out = out.split(m[0]).join(value);
  }
  return out;
}

// Strip HTML to roughly-readable plain text without a parser dependency.
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|br|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

type ToolExecutor = (args: Record<string, unknown>) => Promise<Record<string, unknown>>;

const TOOL_EXECUTORS: Record<string, ToolExecutor> = {
  http_request: executeHttpRequest,
  fetch_webpage: executeFetchWebpage,
};

async function executeHttpRequest(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const method = String(args.method ?? "GET").toUpperCase();
  const rawUrl = typeof args.url === "string" ? args.url : "";
  if (!rawUrl) return { ok: false, error: "Missing url." };
  const url = await substituteSecrets(rawUrl);

  const headers: Record<string, string> = {};
  if (typeof args.headers === "string" && args.headers.trim()) {
    try {
      const parsed = JSON.parse(await substituteSecrets(args.headers));
      for (const [k, v] of Object.entries(parsed)) headers[k] = String(v);
    } catch {
      return { ok: false, error: "headers must be a valid JSON object string." };
    }
  }

  const init: RequestInit = { method, headers };
  if (typeof args.body === "string" && args.body.length && method !== "GET" && method !== "HEAD") {
    init.body = await substituteSecrets(args.body);
  }

  try {
    const res = await fetch(url, init);
    const text = await res.text();
    const truncated = text.length > MAX_API_CHARS;
    return {
      ok: res.ok,
      status: res.status,
      body: truncated ? text.slice(0, MAX_API_CHARS) + "\n...[truncated]" : text,
    };
  } catch (err) {
    return { ok: false, error: `Network error: ${String(err)}` };
  }
}

async function executeFetchWebpage(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const url = typeof args.url === "string" ? args.url : "";
  if (!url) return { ok: false, error: "Missing url." };
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (BYOK-Gemini-Agent)", Accept: "text/html,*/*" },
    });
    const raw = await res.text();
    const looksHtml = /<html|<body|<!doctype/i.test(raw) || (res.headers.get("content-type") ?? "").includes("html");
    const text = looksHtml ? htmlToText(raw) : raw;
    const truncated = text.length > MAX_PAGE_CHARS;
    return {
      ok: res.ok,
      status: res.status,
      url,
      content: truncated ? text.slice(0, MAX_PAGE_CHARS) + "\n...[truncated]" : text,
    };
  } catch (err) {
    return { ok: false, error: `Could not fetch page: ${String(err)}` };
  }
}

// ---- Gemini call ----

interface GeminiResponse {
  candidates?: { content?: Content }[];
  error?: { message?: string };
  promptFeedback?: { blockReason?: string };
}

async function buildSystemInstruction(memo?: string): Promise<Content> {
  const names = await listSecretNames();
  const secretsLine =
    names.length > 0
      ? `The user has stored these secret credentials, usable by referencing ` +
        `them as {{NAME}} in an http_request: ${names.join(", ")}. You never see ` +
        `their real values.`
      : `The user has not stored any secret credentials yet. If a request needs ` +
        `one, tell them to add it in Settings.`;

  const memoBlock =
    memo && memo.trim()
      ? `\n\nDense memory of earlier conversation (your own notes, may be terse):\n${memo.trim()}`
      : "";

  return {
    role: "user",
    parts: [
      {
        text:
          "You are a capable assistant running entirely on the user's device, " +
          "like a command-line agent but on a phone. You have real internet " +
          "access via two tools: fetch_webpage (read pages as text) and " +
          "http_request (call any API). Use them proactively to look things up " +
          "and take actions rather than guessing or saying you can't browse. " +
          secretsLine +
          " After using a tool, summarise what you found or did in plain language." +
          memoBlock,
      },
    ],
  };
}

async function callGemini(contents: Content[], systemInstruction: Content): Promise<Content> {
  const apiKey = await getGeminiKey();
  if (!apiKey) throw new Error("No Gemini API key. Add it in Settings.");

  const res = await fetch(`${GEMINI_ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents, tools: TOOLS, systemInstruction }),
  });

  const data = (await res.json().catch(() => ({}))) as GeminiResponse;
  if (!res.ok) throw new Error(data.error?.message ?? `Gemini request failed (${res.status}).`);
  if (data.promptFeedback?.blockReason)
    throw new Error(`Request blocked by Gemini: ${data.promptFeedback.blockReason}.`);

  const content = data.candidates?.[0]?.content;
  if (!content) throw new Error("Gemini returned no content.");
  return content;
}

function functionCallsIn(content: Content): FunctionCall[] {
  return (content.parts ?? [])
    .map((p) => p.functionCall)
    .filter((fc): fc is FunctionCall => !!fc);
}

function textIn(content: Content): string {
  return (content.parts ?? [])
    .map((p) => p.text)
    .filter((t): t is string => typeof t === "string")
    .join("")
    .trim();
}

export interface AgentCallbacks {
  onStatus?: (status: string | null) => void;
}
export interface AgentResult {
  contents: Content[];
  reply: string;
}
// Context for attributing error-log entries to the originating chat.
export interface AgentContext {
  threadId: string;
  threadTitle: string;
}

// A tool call counts as failed if it explicitly reports ok:false or carries an
// error string. We log the raw (placeholder) request, never substituted secrets.
async function maybeLogFailure(
  call: FunctionCall,
  result: Record<string, unknown>,
  ctx?: AgentContext
): Promise<void> {
  if (!ctx) return;
  const failed = result.ok === false || typeof result.error === "string";
  if (!failed) return;
  try {
    await appendError({
      threadId: ctx.threadId,
      threadTitle: ctx.threadTitle,
      tool: call.name,
      method: typeof call.args?.method === "string" ? (call.args.method as string) : undefined,
      url: typeof call.args?.url === "string" ? (call.args.url as string) : undefined,
      status: typeof result.status === "number" ? (result.status as number) : undefined,
      message:
        typeof result.error === "string"
          ? (result.error as string)
          : `HTTP ${result.status ?? "?"}`,
      detail: typeof result.body === "string" ? (result.body as string).slice(0, 600) : undefined,
    });
  } catch {
    // Logging must never break a turn.
  }
}

function statusFor(call: FunctionCall): string {
  const url = typeof call.args?.url === "string" ? call.args.url : "";
  if (call.name === "fetch_webpage") return `Reading page: ${url}`;
  if (call.name === "http_request") return `Calling API: ${String(call.args?.method ?? "")} ${url}`.trim();
  return `Running tool: ${call.name}...`;
}

// Run one user turn to completion: call Gemini, execute any tool calls it makes,
// feed results back, and loop until the model produces a text answer.
export async function runAgentTurn(
  contents: Content[],
  callbacks: AgentCallbacks = {},
  memo?: string,
  ctx?: AgentContext
): Promise<AgentResult> {
  const history: Content[] = [...contents];
  const setStatus = callbacks.onStatus ?? (() => {});
  const systemInstruction = await buildSystemInstruction(memo);

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    setStatus("Thinking...");
    const modelTurn = await callGemini(history, systemInstruction);
    history.push(modelTurn);

    const calls = functionCallsIn(modelTurn);
    if (calls.length === 0) {
      setStatus(null);
      return { contents: history, reply: textIn(modelTurn) || "(no response)" };
    }

    const responseParts: Part[] = [];
    for (const call of calls) {
      setStatus(statusFor(call));
      const executor = TOOL_EXECUTORS[call.name];
      let result: Record<string, unknown>;
      if (!executor) {
        result = { ok: false, error: `Unknown tool: ${call.name}` };
      } else {
        try {
          result = await executor(call.args ?? {});
        } catch (err) {
          result = { ok: false, error: String(err) };
        }
      }
      await maybeLogFailure(call, result, ctx);
      responseParts.push({ functionResponse: { name: call.name, response: result } });
    }

    history.push({ role: "user", parts: responseParts });
  }

  setStatus(null);
  throw new Error(`Agent stopped after ${MAX_TOOL_ROUNDS} tool rounds without a final answer.`);
}

// Render structured turns into compact text for the summariser to read.
function renderTurns(turns: Content[]): string {
  return turns
    .map((c) => {
      const bits = (c.parts ?? []).map((p) => {
        if (typeof p.text === "string") return p.text;
        if (p.functionCall) return `[tool ${p.functionCall.name}(${JSON.stringify(p.functionCall.args)})]`;
        if (p.functionResponse) return `[tool result: ${JSON.stringify(p.functionResponse.response).slice(0, 1200)}]`;
        return "";
      });
      return `${c.role.toUpperCase()}: ${bits.join(" ").trim()}`;
    })
    .join("\n");
}

// Fold older turns into an updated dense memory note. The output is written for
// the model's own future reference — terse, information-dense, NOT formatted for
// humans. This is the on-device equivalent of context compaction.
export async function compactConversation(memo: string, turnsToFold: Content[]): Promise<string> {
  const apiKey = await getGeminiKey();
  if (!apiKey) throw new Error("No Gemini API key.");

  const prompt =
    "You maintain a dense, token-efficient MEMORY LOG of a conversation, for your " +
    "own future reference only (never shown to a human, so do not optimise for " +
    "readability). Merge the PRIOR MEMORY and the NEW EXCHANGES into one updated " +
    "memory. Preserve: durable facts, user preferences, decisions, task state, " +
    "useful tool results/URLs, and open threads. Drop pleasantries and redundancy. " +
    "Use terse bullet shorthand. Output ONLY the updated memory text.\n\n" +
    `PRIOR MEMORY:\n${memo || "(none)"}\n\nNEW EXCHANGES:\n${renderTurns(turnsToFold)}`;

  const res = await fetch(`${GEMINI_ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }] }),
  });
  const data = (await res.json().catch(() => ({}))) as GeminiResponse;
  if (!res.ok) throw new Error(data.error?.message ?? `Compaction failed (${res.status}).`);
  const text = data.candidates?.[0]?.content
    ? textIn(data.candidates[0].content as Content)
    : "";
  return text || memo;
}

// A short title for a new thread, derived from the first user message.
export async function suggestTitle(firstMessage: string): Promise<string> {
  const apiKey = await getGeminiKey();
  if (!apiKey) return firstMessage.slice(0, 40);
  try {
    const res = await fetch(`${GEMINI_ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: `Give a 3-5 word title (no quotes) for a chat that starts: "${firstMessage}"` }],
          },
        ],
      }),
    });
    const data = (await res.json().catch(() => ({}))) as GeminiResponse;
    const t = data.candidates?.[0]?.content ? textIn(data.candidates[0].content as Content) : "";
    return (t || firstMessage).replace(/^["']|["']$/g, "").slice(0, 48) || "New chat";
  } catch {
    return firstMessage.slice(0, 40) || "New chat";
  }
}
