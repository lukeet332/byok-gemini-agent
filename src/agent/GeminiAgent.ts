// The local agent engine. Runs entirely client-side: it talks to Google AI
// Studio's generateContent endpoint directly over fetch, and gives the model
// real tools so it can act like a CLI coding/agent assistant — but on a phone,
// on the free Gemini model, with genuine internet access:
//   - http_request:  call ANY API on the user's behalf (auth via {{SECRET}})
//   - fetch_webpage: read a web page and get back clean text to digest
// Stored credentials are referenced by name and substituted in on-device right
// before a request, so raw secret values never reach the model.

import { fetch as expoFetch } from "expo/fetch";

import { Content, FunctionCall, FunctionDeclaration, Part, Tool } from "../types";
import {
  getAnthropicConfig,
  getGeminiKey,
  getGithubToken,
  getModel,
  getOpenAiConfig,
  getExecMode,
  getProvider,
  getSecretValue,
  getSystemPrompt,
  listSecretNames,
  normalizeSecretName,
  saveSecret,
  saveBackgroundRun,
  saveModel,
  saveProvider,
  saveWriteMode,
  AiProvider,
  GitWriteMode,
} from "../storage/SecureStorage";
import { appendError } from "../storage/ErrorLogStore";
import { getUserNotes, saveUserNotes } from "../storage/UserNotes";
import * as Memory from "../storage/MemoryStore";
import * as Background from "./Background";
import { BrowserEngine } from "../browser/BrowserEngine";
import * as Device from "../device/DeviceTools";
import * as Files from "../device/FileTools";
import * as Github from "../device/GithubTools";
import * as McpClient from "../mcp/McpClient";
import * as Shell from "../../modules/shell-exec";

// Default model + the presets offered in Settings. Users can also type any
// model id (e.g. a newer one) as a custom value.
export const DEFAULT_MODEL = "gemini-2.5-flash";
// Scoped to the real tiers (like the Gemini app) + 2.5 Flash for its generous
// free-tier limits. The -latest aliases track the current Flash/Pro/Lite.
export const MODEL_PRESETS: { id: string; label: string }[] = [
  { id: "gemini-2.5-flash", label: "2.5 Flash · generous free limits" },
  { id: "gemini-flash-latest", label: "Flash · all-round help" },
  { id: "gemini-flash-lite-latest", label: "Flash-Lite · fastest" },
  { id: "gemini-pro-latest", label: "Pro · advanced maths & code" },
];
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models/";

// Build the generateContent endpoint for the currently-selected model.
async function genEndpoint(): Promise<string> {
  const model = (await getModel()) || DEFAULT_MODEL;
  return `${GEMINI_BASE}${model}:generateContent`;
}

// Fetch the live list of Gemini models that support generateContent, straight
// from Google (so new models like newer flash/pro versions appear automatically).
// Returns [] on any failure; callers fall back to MODEL_PRESETS.
let modelsCache: string[] | null = null;

export async function listModels(): Promise<string[]> {
  if (modelsCache) return modelsCache; // cache for the session — avoids refetching
  const apiKey = await getGeminiKey();
  if (!apiKey) return [];
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${encodeURIComponent(apiKey)}`
    );
    const data = (await res.json().catch(() => ({}))) as {
      models?: { name?: string; supportedGenerationMethods?: string[] }[];
    };
    if (!res.ok || !Array.isArray(data.models)) return [];
    const out = data.models
      .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
      .map((m) => (m.name ?? "").replace(/^models\//, ""))
      .filter((id) => id.startsWith("gemini"))
      .sort();
    if (out.length) modelsCache = out;
    return out;
  } catch {
    return [];
  }
}

// Safety valve: never loop forever if the model keeps requesting tools. Set
// high enough to allow deep multi-step chains (fetch -> API -> API -> ...).
const MAX_TOOL_ROUNDS = 12;
// Cap tool output fed back to the model (context + cost control).
const MAX_API_CHARS = 8000;
const MAX_PAGE_CHARS = 16000;
const MAX_SEARCH_CHARS = 8000;

// Present as a real browser so naive user-agent blocks don't reject http_request.
const BROWSER_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";
const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent": BROWSER_UA,
  "Accept-Language": "en-US,en;q=0.9",
};

// The agent's default persona / operating manual. Users can override it in
// Settings; an empty override falls back to this.
export const DEFAULT_SYSTEM_PROMPT = [
  "You are a capable, autonomous assistant running entirely on the user's phone — like a command-line agent, not a sandboxed chatbot. You have REAL internet access.",
  "",
  "Tools:",
  "- web_search(query): search the web; returns top results with readable content.",
  "- fetch_webpage(url): read a specific page as clean text.",
  "- http_request(method,url,headers,body): call ANY API. Authenticate by putting {{SECRET_NAME}} in the url/headers/body — values are substituted on-device; you never see them.",
  "- Device / other apps: check_app_available(url-or-scheme), open_link(url or deep link), share_content(text), clipboard_get(), clipboard_set(text), send_android_intent(...).",
  "- Files: grant_folder (one-time per folder), list_files(folderUri?), read_file(uri), write_file(uri,content), create_file(folderUri,name,content), pick_file. To find/edit a file in e.g. Downloads: list_files() to see granted folders; if none, call grant_folder and ask the user to pick Downloads; then list_files(uri), read_file, and write_file/create_file as needed.",
  "- GitHub coding: github_list_path / github_get_file / github_search_code to read & answer questions about a repo (free). To EDIT, prefer github_apply_patch with a unified git diff — surgical, verifiable, works with no local toolchain; ALWAYS read the file first so the diff's context matches, and show the user the change as a ```diff block. Use github_commit (FULL new file content) only for new files or full rewrites. Both honour the user's write mode (branch+PR by default) and need confirmation.",
  "",
  "Acting on the phone: to use another app (e.g. send a WhatsApp message), FIRST check_app_available (e.g. 'whatsapp://'), then format that app's deep link yourself (e.g. https://wa.me/<number>?text=...) and open_link it, or use send_android_intent for advanced handoffs. Use clipboard_set to hand the user text to paste anywhere.",
  "",
  "Behaviour:",
  "- Be proactive: when a question needs current or external info, USE the tools instead of guessing or saying you can't browse.",
  "- Chain steps: search -> open the most relevant pages -> extract what matters -> (optionally call APIs) -> synthesise.",
  "- VERIFY WHEN IT MATTERS — DON'T GUESS. Answer directly from your own knowledge when you're genuinely confident and the fact is stable (general knowledge, definitions, how-tos, well-known history). But you have web access, so search/fetch and CONFIRM (citing URLs) whenever the answer is time-sensitive or current (prices, news, scores, 'latest'/'now', availability), niche/specific/obscure, or you're at all unsure. The test is your confidence: sure and stable -> just answer; shaky, fresh, or specific -> look it up. Never pass off a guess or a hazy memory as certain fact.",
  "- If a tool fails, read the error, adjust (different URL, headers, or query) and retry a couple of times before giving up.",
  "- BE HONEST — NEVER GUESS OR LIE. Do not fabricate success, data, results, prices, quotes, or sources. If, after genuinely using your tools, you still cannot verify a fact or complete an action (a site blocks access, an app can't be driven silently, a file is binary), say so plainly — a truthful 'I searched but couldn't confirm X' or 'I couldn't do X because Y' is ALWAYS better than a confident made-up answer.",
  "- For app handoffs prefer standard intents/deep links: ACTION_SENDTO (smsto:/mailto:), ACTION_SEND, ACTION_INSERT (calendar/contacts), ACTION_VIEW, ACTION_DIAL. Remember these open the target app; truly background actions are only possible via an API (http_request).",
  "- REMEMBER LASTING PREFERENCES. If the user asks you to always do something — a tone/voice (formal, casual, blunt), length (brief), format, language, or any standing instruction or fact to remember — immediately save it with update_user_notes so it persists across all future chats. Don't save one-off requests. (Behaviour/persona lives in user notes, NOT in your own instructions.)",
  "- CHANGE APP SETTINGS ON REQUEST. If the user asks to change a setting, use update_setting (key = model | provider | background | write_mode). It asks them to confirm. You can't set API keys/secrets; behaviour/tone goes to update_user_notes, not here.",
  "- CREDENTIALS. The user may share an API key/token/secret. Judge whether it's actually a credential and what service it's for, agree a clear NAME, and store it with save_secret(name, value). Once stored, its raw value is PURGED from this conversation and you reference it as {{NAME}} thereafter — NEVER repeat the raw value in a reply. Don't nanny: if the user wants something stored, store it. Users can also add keys in Settings.",
  "- SHOW CODE CHANGES AS DIFFS. When you propose or make a code change, show it as a unified diff inside a ```diff code block (lines starting +/- ) so the user can review the exact changes — they render colourised. Do this by default for non-trivial edits, and ALWAYS when the user asks to see the diff. For tiny one-liners a short inline mention is fine.",
  "- Be concise and direct. Use markdown. Include relevant image URLs so they render inline.",
].join("\n");

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
          "Fetch a web page and return its readable text content (markup, scripts " +
          "and styles removed; JavaScript-rendered pages supported) so you can " +
          "read and digest it as context. Use after web_search to open a specific result.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "Full URL of the page to read, including https://." },
            offset: {
              type: "integer",
              description: "Character offset to start from, for paging past truncation (default 0). Use the offset suggested in a previous truncated result to read more.",
            },
          },
          required: ["url"],
        },
      },
      {
        name: "web_search",
        description:
          "Search the web and get back the top results with their readable " +
          "content. Use this FIRST when you need to find information, products, " +
          "reviews, news, or any page whose URL you don't already know.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "The search query." },
          },
          required: ["query"],
        },
      },
      {
        name: "check_app_available",
        description:
          "Check whether an installed app can handle a URL or scheme on this device " +
          "(e.g. 'whatsapp://', 'spotify:', 'https://wa.me/'). Use this to discover " +
          "what apps/handoffs are possible before acting.",
        parameters: {
          type: "object",
          properties: { url: { type: "string", description: "A URL or app scheme to test." } },
          required: ["url"],
        },
      },
      {
        name: "open_link",
        description:
          "Open a URL or app deep link on the device — handing off to the right app. " +
          "Examples: 'https://wa.me/447700900000?text=Hi' (WhatsApp), 'tel:+44…', " +
          "'mailto:a@b.com?subject=…&body=…', 'geo:0,0?q=address', 'spotify:track:…'. " +
          "You generally know each app's deep-link format; format it yourself.",
        parameters: {
          type: "object",
          properties: { url: { type: "string", description: "The URL / deep link to open." } },
          required: ["url"],
        },
      },
      {
        name: "share_content",
        description: "Share text to another app via the system share sheet (the user picks the target app).",
        parameters: {
          type: "object",
          properties: { text: { type: "string", description: "The text to share." } },
          required: ["text"],
        },
      },
      {
        name: "clipboard_get",
        description: "Read the device clipboard — use to ingest whatever the user copied from another app.",
        parameters: { type: "object", properties: {} },
      },
      {
        name: "clipboard_set",
        description: "Write text to the device clipboard so the user can paste it into any other app.",
        parameters: {
          type: "object",
          properties: { text: { type: "string", description: "Text to put on the clipboard." } },
          required: ["text"],
        },
      },
      {
        name: "send_android_intent",
        description:
          "Advanced Android handoff: fire an intent to another app. Use when a deep " +
          "link isn't enough — e.g. action 'android.intent.action.SEND' with mimeType " +
          "'text/plain', package 'com.whatsapp', and text to share to a specific app.",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", description: "Intent action, e.g. android.intent.action.SEND or VIEW." },
            data: { type: "string", description: "Optional data URI." },
            mimeType: { type: "string", description: "Optional MIME type, e.g. text/plain." },
            package: { type: "string", description: "Optional target package, e.g. com.whatsapp." },
            text: { type: "string", description: "Optional text (sent as EXTRA_TEXT)." },
          },
          required: ["action"],
        },
      },
      {
        name: "grant_folder",
        description:
          "Ask the user to grant access to a folder (e.g. Downloads) via the system " +
          "picker. Needed once before you can list/read that folder's files. Returns " +
          "the folder uri to use with list_files.",
        parameters: { type: "object", properties: {} },
      },
      {
        name: "list_files",
        description:
          "List files. With no folderUri, returns the folders the user has already " +
          "granted. With a granted folderUri, returns the files inside it (name + uri).",
        parameters: {
          type: "object",
          properties: { folderUri: { type: "string", description: "A previously-granted folder uri (optional)." } },
        },
      },
      {
        name: "read_file",
        description: "Read a text file's content by uri (from a granted folder or a picked file).",
        parameters: {
          type: "object",
          properties: { uri: { type: "string", description: "The file uri to read." } },
          required: ["uri"],
        },
      },
      {
        name: "pick_file",
        description: "Ask the user to pick a single file to hand to you (returns its name + uri).",
        parameters: { type: "object", properties: {} },
      },
      {
        name: "write_file",
        description: "Overwrite an existing text file's content by uri (from a granted folder or picked file).",
        parameters: {
          type: "object",
          properties: {
            uri: { type: "string", description: "The file uri to overwrite." },
            content: { type: "string", description: "The new full text content." },
          },
          required: ["uri", "content"],
        },
      },
      {
        name: "create_file",
        description: "Create a new text file inside a granted folder.",
        parameters: {
          type: "object",
          properties: {
            folderUri: { type: "string", description: "A granted folder uri." },
            name: { type: "string", description: "New file name, e.g. notes.txt." },
            content: { type: "string", description: "The file's text content." },
            mimeType: { type: "string", description: "Optional MIME type (default text/plain)." },
          },
          required: ["folderUri", "name", "content"],
        },
      },
      {
        name: "update_user_notes",
        description:
          "Save/update your durable notes about THIS user — their chat preferences, " +
          "style, recurring context, things to remember across chats. You are given the " +
          "current notes each turn; pass the FULL updated markdown (you curate it: merge, " +
          "dedupe, keep it concise). Use when you learn a lasting preference.",
        parameters: {
          type: "object",
          properties: { notes: { type: "string", description: "The full updated notes (markdown)." } },
          required: ["notes"],
        },
      },
      {
        name: "schedule_reminder",
        description:
          "Schedule a reminder that pops a notification at a future time. Give the reminder text and EITHER " +
          "'at' (an ISO 8601 datetime — compute it from the current local time given in your instructions) OR " +
          "'inMinutes'. Use for 'remind me…', alarms, nudges, a morning prompt, etc.",
        parameters: {
          type: "object",
          properties: {
            text: { type: "string", description: "What to remind the user." },
            at: { type: "string", description: "ISO 8601 datetime, e.g. 2026-06-29T07:00:00." },
            inMinutes: { type: "number", description: "Alternatively, fire this many minutes from now." },
          },
          required: ["text"],
        },
      },
      {
        name: "list_reminders",
        description: "List the user's scheduled reminders (id + text).",
        parameters: { type: "object", properties: {} },
      },
      {
        name: "cancel_reminder",
        description: "Cancel a scheduled reminder by its id (from list_reminders).",
        parameters: {
          type: "object",
          properties: { id: { type: "string", description: "Reminder id to cancel." } },
          required: ["id"],
        },
      },
      {
        name: "memory_save",
        description:
          "Save a durable fact / item / list-entry / task to your long-term memory so you can recall it in ANY " +
          "future chat (e.g. 'car reg is AB12 CDE', 'reading list += Dune', 'Acme deadline Fri 5pm', 'wife's " +
          "birthday 3 Mar'). For discrete facts/items — tone & style preferences go in update_user_notes instead.",
        parameters: {
          type: "object",
          properties: {
            text: { type: "string", description: "The thing to remember." },
            tags: { type: "array", description: "Optional keywords to find it later.", items: { type: "string" } },
          },
          required: ["text"],
        },
      },
      {
        name: "memory_search",
        description:
          "Search your long-term memory for saved facts/items (keyword match). Use whenever the user refers to " +
          "something you may have stored, or to pull context from past chats.",
        parameters: {
          type: "object",
          properties: { query: { type: "string", description: "Keywords to search for." } },
          required: ["query"],
        },
      },
      {
        name: "memory_list",
        description: "List everything in your long-term memory (most recent first).",
        parameters: { type: "object", properties: {} },
      },
      {
        name: "memory_delete",
        description: "Delete a memory entry by its id (ids come from memory_search / memory_list).",
        parameters: {
          type: "object",
          properties: { id: { type: "string", description: "The memory entry id to remove." } },
          required: ["id"],
        },
      },
      {
        name: "save_secret",
        description:
          "Securely store an API key / token / credential the user gives you, in the on-device keystore under " +
          "a clear NAME (e.g. STRIPE_API_KEY). Use this whenever the user shares a credential they want kept. " +
          "After you store it, the raw value is PURGED from the conversation — reference it as {{NAME}} in " +
          "http_request from then on, and NEVER repeat the raw value in your replies.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Clear uppercase name, e.g. STRIPE_API_KEY." },
            value: { type: "string", description: "The secret value to store." },
          },
          required: ["name", "value"],
        },
      },
      {
        name: "update_setting",
        description:
          "Change one of the user's app settings (requires their confirmation). Allowed keys: " +
          "'model' (the model id for the current provider, e.g. gemini-2.5-flash), " +
          "'provider' (gemini | anthropic | openai — only switch to one whose key is already set), " +
          "'background' (on | off — keep a task running when the app is backgrounded), " +
          "'write_mode' (pr | branch | main — how your GitHub changes land). " +
          "You CANNOT set API keys or secret values, and you must NOT change your own agent " +
          "instructions here — for tone/behaviour/standing preferences use update_user_notes instead. " +
          "Use this only when the user explicitly asks to change one of these settings.",
        parameters: {
          type: "object",
          properties: {
            key: { type: "string", description: "One of: model, provider, background, write_mode." },
            value: { type: "string", description: "The new value for that setting." },
          },
          required: ["key", "value"],
        },
      },
      {
        name: "github_list_path",
        description:
          "List a directory in a GitHub repo (or report a path is a file) to navigate a codebase. repo is 'owner/name'.",
        parameters: {
          type: "object",
          properties: {
            repo: { type: "string", description: "owner/name" },
            path: { type: "string", description: "Directory path (default: repo root)." },
            ref: { type: "string", description: "Optional branch/tag/sha." },
          },
          required: ["repo"],
        },
      },
      {
        name: "github_get_file",
        description: "Read a file's text content from a GitHub repo.",
        parameters: {
          type: "object",
          properties: {
            repo: { type: "string", description: "owner/name" },
            path: { type: "string", description: "File path in the repo." },
            ref: { type: "string", description: "Optional branch/tag/sha." },
          },
          required: ["repo", "path"],
        },
      },
      {
        name: "github_search_code",
        description: "Search code on GitHub. Optionally scope to one repo (owner/name).",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query." },
            repo: { type: "string", description: "Optional owner/name to scope the search." },
          },
          required: ["query"],
        },
      },
      {
        name: "github_commit",
        description:
          "Commit code changes to a GitHub repo (one commit, multiple files). Provide the FULL new content " +
          "of each changed/created file — blobs replace the whole file. Honours the user's write mode " +
          "(branch+PR / branch / main) and requires their confirmation. Read the files first so you don't " +
          "lose existing content.",
        parameters: {
          type: "object",
          properties: {
            repo: { type: "string", description: "owner/name" },
            message: { type: "string", description: "Commit message (first line = title)." },
            files: {
              type: "array",
              description: "Files to write, each with full new content.",
              items: {
                type: "object",
                properties: {
                  path: { type: "string", description: "Path in the repo." },
                  content: { type: "string", description: "Full new file content." },
                },
                required: ["path", "content"],
              },
            },
            branch: { type: "string", description: "Optional branch name (used in branch mode)." },
          },
          required: ["repo", "message", "files"],
        },
      },
      {
        name: "github_apply_patch",
        description:
          "Make a SURGICAL edit to a GitHub repo by applying a unified git diff — preferred over github_commit " +
          "for edits (no whole-file rewrite, works for everyone, no Termux). Provide a standard multi-file diff " +
          "(diff --git a/… b/…, --- a/…, +++ b/…, @@ hunks). Fraude fetches each file, applies the hunks in-app, " +
          "and commits per the user's write mode. If a hunk doesn't apply you'll get the failing files back — " +
          "re-read them with github_get_file and regenerate the diff against their exact current contents. " +
          "ALWAYS show the user the diff in a ```diff block when you do this. Needs confirmation.",
        parameters: {
          type: "object",
          properties: {
            repo: { type: "string", description: "owner/name" },
            message: { type: "string", description: "Commit message (first line = title)." },
            diff: { type: "string", description: "Unified git diff to apply (one or more files)." },
            branch: { type: "string", description: "Optional branch name (used in branch mode)." },
          },
          required: ["repo", "message", "diff"],
        },
      },
    ],
  },
];

// Shell execution is advanced + dangerous, so its declaration is only offered
// to the model when the user has enabled it (added to the turn's tool set then).
const SHELL_TOOL: FunctionDeclaration = {
  name: "run_shell",
  description:
    "Run a shell command ON THE DEVICE and get back stdout, stderr and the exit code. The privilege is " +
    "fixed by the user's chosen Execution mode (stated in your instructions): app = the app's sandbox uid " +
    "(toybox coreutils only); shizuku = ADB/shell-uid (pm, cmd, settings, input/am automation, read " +
    "anything); root = full root. Use it to inspect the device, run scripts, automate other apps " +
    "(shizuku/root), and run quick commands. Each command needs the user's confirmation.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command line to run." },
    },
    required: ["command"],
  },
};

// Run a command inside Termux (real toolchains), capturing output. Offered only
// when shell execution is enabled.
const TERMUX_TOOL: FunctionDeclaration = {
  name: "run_termux",
  description:
    "Run a command inside Termux — the real local toolchain (python, node, clang, git, make, etc., " +
    "whatever the user has `pkg install`ed). Use this (NOT run_shell) to build, run and TEST actual code: " +
    "e.g. 'cd ~/proj && npm test', 'python main.py', 'gcc a.c -o a && ./a', 'git clone … && cd … && git " +
    "checkout -b fix'. Requires the user to have Termux installed with allow-external-apps=true; output is " +
    "captured and returned (reading it back needs Shizuku or root). Needs the user's confirmation.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command line to run inside Termux (bash -c)." },
    },
    required: ["command"],
  },
};

// Accessibility-based UI automation tools — offered only when the user has
// enabled Fraude's accessibility service. App-agnostic: act by on-screen
// text/id, not coordinates. This is the no-root way to drive other apps.
const UI_TOOLS: FunctionDeclaration[] = [
  {
    name: "ui_screen",
    description:
      "Read the CURRENT screen via accessibility — returns the on-screen elements (their text, " +
      "content-description, resource-id, whether they're clickable/editable, and centre coordinates). " +
      "Call this to see what's on screen before tapping/typing, and again after each action to confirm the " +
      "new state. Works on whatever app is in the foreground.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "ui_tap",
    description:
      "Tap an on-screen element found by its visible text OR its resource-id (from ui_screen). Robust across " +
      "apps/screen sizes — no coordinates. Provide one of text or id.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "Visible text / label of the element to tap." },
        id: { type: "string", description: "resource-id of the element to tap (alternative to text)." },
      },
    },
  },
  {
    name: "ui_type",
    description: "Type text into the currently focused input field (tap the field first with ui_tap).",
    parameters: {
      type: "object",
      properties: { text: { type: "string", description: "The text to enter." } },
      required: ["text"],
    },
  },
  {
    name: "ui_global",
    description: "Press a global navigation button: 'back', 'home', 'recents', or 'notifications'.",
    parameters: {
      type: "object",
      properties: { action: { type: "string", description: "back | home | recents | notifications" } },
      required: ["action"],
    },
  },
];

const READ_LOG_TOOL: FunctionDeclaration = {
  name: "read_log",
  description:
    "Read the full output of the last run_termux/apply_patch command (un-truncated). The first view shows " +
    "the start plus the end (where errors usually are); pass offset (from a previous readMoreOffset) to read " +
    "the middle. Use this when output was truncated or a command was still running.",
  parameters: {
    type: "object",
    properties: { offset: { type: "integer", description: "Character offset to read from (default 0)." } },
  },
};

const APPLY_PATCH_TOOL: FunctionDeclaration = {
  name: "apply_patch",
  description:
    "Apply a unified git diff to files in the current Termux session directory (surgical edit — far better " +
    "than rewriting whole files). Provide a standard `git diff` (--- a/… / +++ b/… / @@ hunks). Runs `git " +
    "apply` and returns success or the rejected-hunk errors so you can correct the diff. cd to the repo first " +
    "with run_termux. Needs the user's confirmation.",
  parameters: {
    type: "object",
    properties: { diff: { type: "string", description: "Unified diff text to apply." } },
    required: ["diff"],
  },
};

// The tools actually sent to Gemini for the current turn = built-in TOOLS plus
// any connected MCP servers' tools (recomputed at the start of each turn).
let activeTools: Tool[] = TOOLS;

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

// ---- Persistent Termux coding session ----
// Each run_termux is a fresh `bash -c`, so we emulate a persistent session by
// saving/restoring the working dir + exported env in a shared dir on each call
// (cd, venv activation, exports all persist). Output goes to a full log file we
// read back (Shizuku/root, or app-uid with All-files access) and page — no
// bridge truncation; the error-bearing tail is always shown.
const CODE_DIR = "/sdcard/fraude";
const SESSION_LOG = `${CODE_DIR}/last.log`;
const SESSION_CWD = `${CODE_DIR}/.cwd`;
const SESSION_ENV = `${CODE_DIR}/.env`;
const DONE_RE = /__FRAUDE_DONE_(-?\d+)__/;
const MAX_LOG_VIEW = 12000;
const LOG_TAIL = 3000;

function sessionWrap(command: string): string {
  return [
    `mkdir -p ${CODE_DIR}`,
    `cd "$(cat ${SESSION_CWD} 2>/dev/null || echo "$HOME")" 2>/dev/null || cd "$HOME"`,
    `[ -f ${SESSION_ENV} ] && . ${SESSION_ENV} 2>/dev/null`,
    `{ ${command} ; } > ${SESSION_LOG} 2>&1; __ec=$?`,
    `pwd > ${SESSION_CWD} 2>/dev/null`,
    `export -p > ${SESSION_ENV} 2>/dev/null`,
    `echo "__FRAUDE_DONE_\${__ec}__" >> ${SESSION_LOG}`,
  ].join("; ");
}

// Read a file via the best available privilege.
async function readFileBest(path: string): Promise<string> {
  if ((await Shell.shizukuStatus()).granted)
    return (await Shell.execShizuku(`cat ${path} 2>/dev/null`, 8000)).stdout || "";
  if (Shell.hasAllFilesAccess()) return (await Shell.exec(`cat ${path} 2>/dev/null`, false, 8000)).stdout || "";
  return (await Shell.exec(`cat ${path} 2>/dev/null`, true, 8000)).stdout || ""; // su fallback
}

function canReadShared(): boolean {
  return Shell.hasAllFilesAccess();
}

// Poll the session log until the done-marker appears; return exit code + body.
async function awaitSession(signal?: AbortSignal): Promise<{ exitCode: number | null; content: string }> {
  for (let i = 0; i < 20; i++) {
    if (signal?.aborted) throw new AbortedError();
    await sleep(1500, signal);
    const raw = await readFileBest(SESSION_LOG);
    const m = raw.match(DONE_RE);
    if (m) return { exitCode: parseInt(m[1], 10), content: raw.replace(DONE_RE, "").replace(/\s+$/, "") };
  }
  return { exitCode: null, content: (await readFileBest(SESSION_LOG)).replace(DONE_RE, "") };
}

// Page a big log: full if small; else head + always-included tail, with an offset
// to read the middle. Mirrors fetch_webpage paging.
function pageLog(content: string, offset = 0): { view: string; total: number; nextOffset: number | null } {
  const total = content.length;
  if (total <= MAX_LOG_VIEW) return { view: content, total, nextOffset: null };
  if (offset > 0) {
    const slice = content.slice(offset, offset + MAX_LOG_VIEW);
    return { view: slice, total, nextOffset: offset + MAX_LOG_VIEW < total ? offset + MAX_LOG_VIEW : null };
  }
  const head = content.slice(0, MAX_LOG_VIEW - LOG_TAIL);
  const tail = content.slice(total - LOG_TAIL);
  const omitted = total - (MAX_LOG_VIEW - LOG_TAIL) - LOG_TAIL;
  return {
    view: `${head}\n...[${omitted} chars omitted — call read_log with offset ${MAX_LOG_VIEW - LOG_TAIL} for the middle]...\n${tail}`,
    total,
    nextOffset: MAX_LOG_VIEW - LOG_TAIL,
  };
}

type ToolExecutor = (
  args: Record<string, unknown>,
  signal?: AbortSignal
) => Promise<Record<string, unknown>>;

const TOOL_EXECUTORS: Record<string, ToolExecutor> = {
  http_request: executeHttpRequest,
  fetch_webpage: executeFetchWebpage,
  web_search: executeWebSearch,
  check_app_available: (args) => Device.checkApp(String(args.url ?? "")),
  open_link: (args) => Device.openLink(String(args.url ?? "")),
  share_content: (args) => Device.shareContent(String(args.text ?? "")),
  clipboard_get: async () => ({ ok: true, text: await Device.clipboardGet() }),
  clipboard_set: async (args) => {
    await Device.clipboardSet(String(args.text ?? ""));
    return { ok: true };
  },
  send_android_intent: (args) =>
    Device.sendIntent({
      action: String(args.action ?? ""),
      data: typeof args.data === "string" ? args.data : undefined,
      type: typeof args.mimeType === "string" ? args.mimeType : undefined,
      packageName: typeof args.package === "string" ? args.package : undefined,
      text: typeof args.text === "string" ? args.text : undefined,
    }),
  grant_folder: () => Files.grantFolder(),
  list_files: (args) => Files.listFiles(typeof args.folderUri === "string" ? args.folderUri : undefined),
  read_file: (args) => Files.readFile(String(args.uri ?? "")),
  pick_file: () => Files.pickFile(),
  write_file: (args) => Files.writeFile(String(args.uri ?? ""), String(args.content ?? "")),
  create_file: (args) =>
    Files.createFile(
      String(args.folderUri ?? ""),
      String(args.name ?? ""),
      String(args.content ?? ""),
      typeof args.mimeType === "string" ? args.mimeType : undefined
    ),
  update_user_notes: async (args) => {
    await saveUserNotes(String(args.notes ?? ""));
    return { ok: true };
  },
  run_shell: async (args) => {
    const mode = await getExecMode();
    if (mode === "off")
      return { ok: false, error: "Execution is off. The user can pick an Execution mode in Settings → Developer settings." };
    const command = String(args.command ?? "");
    if (!command.trim()) return { ok: false, error: "Missing command." };
    try {
      // The active mode fixes the privilege — no ambiguity for the model.
      const r =
        mode === "shizuku"
          ? await Shell.execShizuku(command, 120000)
          : await Shell.exec(command, mode === "root", 120000); // app/termux → sandbox sh
      return {
        ok: r.exitCode === 0 && !r.timedOut,
        exitCode: r.exitCode,
        timedOut: r.timedOut,
        stdout: r.stdout,
        stderr: r.stderr,
      };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  },
  run_termux: async (args, signal) => {
    if ((await getExecMode()) === "off")
      return { ok: false, error: "Execution is off. The user can pick an Execution mode in Settings → Developer settings." };
    const command = String(args.command ?? "");
    if (!command.trim()) return { ok: false, error: "Missing command." };
    const fired = await Shell.runTermux(sessionWrap(command));
    if (!fired.ok)
      return {
        ok: false,
        error:
          (fired.error ? fired.error + ". " : "") +
          "Couldn't start Termux. Ensure Termux is installed and ~/.termux/termux.properties has allow-external-apps=true.",
      };
    const { exitCode, content } = await awaitSession(signal);
    if (exitCode === null) {
      const canRead = (await Shell.shizukuStatus()).granted || canReadShared();
      return {
        ok: false,
        timedOut: true,
        note: canRead
          ? "Still running — call read_log to check progress/output."
          : "Couldn't read Termux output. For no-root coding, enable All files access in Settings → Developer settings (or use Shizuku/root).",
      };
    }
    const { view, total, nextOffset } = pageLog(content);
    return {
      ok: exitCode === 0,
      exitCode,
      stdout: view,
      totalChars: total,
      ...(nextOffset != null ? { readMoreOffset: nextOffset } : {}),
    };
  },
  read_log: async (args) => {
    const offset = typeof args.offset === "number" && args.offset > 0 ? Math.floor(args.offset) : 0;
    const content = (await readFileBest(SESSION_LOG)).replace(DONE_RE, "");
    if (!content) return { ok: true, stdout: "(no output captured yet)" };
    const { view, total, nextOffset } = pageLog(content, offset);
    return { ok: true, stdout: view, totalChars: total, ...(nextOffset != null ? { readMoreOffset: nextOffset } : {}) };
  },
  apply_patch: async (args, signal) => {
    if ((await getExecMode()) === "off")
      return { ok: false, error: "Execution is off. The user can pick an Execution mode in Settings → Developer settings." };
    const diff = String(args.diff ?? "");
    if (!diff.trim()) return { ok: false, error: "Missing diff (provide a unified git diff)." };
    const eof = "FRAUDE_PATCH_EOF";
    // Write the diff via a heredoc (no arg-escaping issues), then git apply it in
    // the session's current directory.
    const inner = [
      `cat > ${CODE_DIR}/patch.diff <<'${eof}'`,
      diff,
      eof,
      `git apply --whitespace=nowarn ${CODE_DIR}/patch.diff && echo "PATCH_APPLIED" || git apply --3way --whitespace=nowarn ${CODE_DIR}/patch.diff`,
    ].join("\n");
    const fired = await Shell.runTermux(sessionWrap(inner));
    if (!fired.ok) return { ok: false, error: fired.error || "Couldn't start Termux." };
    const { exitCode, content } = await awaitSession(signal);
    if (exitCode === null) return { ok: false, timedOut: true, note: "Couldn't read result; check read_log." };
    return {
      ok: exitCode === 0,
      exitCode,
      stdout: content.slice(0, MAX_LOG_VIEW) || (exitCode === 0 ? "Patch applied." : "git apply failed — check the diff against current files."),
    };
  },
  ui_screen: async () => {
    if (!Shell.a11yEnabled()) return { ok: false, error: "Accessibility automation is off. The user can enable it in Settings → Developer settings." };
    return { ok: true, screen: await Shell.a11yDump() };
  },
  ui_tap: async (args) => {
    if (!Shell.a11yEnabled()) return { ok: false, error: "Accessibility automation is off." };
    const text = typeof args.text === "string" ? args.text : "";
    const id = typeof args.id === "string" ? args.id : "";
    if (!text && !id) return { ok: false, error: "Provide text or id to tap." };
    const tapped = text ? await Shell.a11yTapText(text) : await Shell.a11yTapId(id);
    return tapped ? { ok: true } : { ok: false, error: `Couldn't find/tap ${text || id}. Call ui_screen to see what's there.` };
  },
  ui_type: async (args) => {
    if (!Shell.a11yEnabled()) return { ok: false, error: "Accessibility automation is off." };
    const ok = await Shell.a11ySetText(String(args.text ?? ""));
    return ok ? { ok: true } : { ok: false, error: "No focused input field — tap one first with ui_tap." };
  },
  ui_global: async (args) => {
    if (!Shell.a11yEnabled()) return { ok: false, error: "Accessibility automation is off." };
    const ok = await Shell.a11yGlobal(String(args.action ?? ""));
    return ok ? { ok: true } : { ok: false, error: "action must be back, home, recents, or notifications." };
  },
  schedule_reminder: async (args) => {
    const text = String(args.text ?? "").trim();
    if (!text) return { ok: false, error: "Missing reminder text." };
    let whenMs: number;
    if (typeof args.inMinutes === "number" && args.inMinutes > 0) {
      whenMs = Date.now() + args.inMinutes * 60000;
    } else if (typeof args.at === "string" && args.at.trim()) {
      const t = Date.parse(args.at);
      if (Number.isNaN(t)) return { ok: false, error: "Couldn't parse 'at' — use ISO 8601 (or pass inMinutes)." };
      whenMs = t;
    } else {
      return { ok: false, error: "Provide 'at' (ISO datetime) or 'inMinutes'." };
    }
    if (whenMs <= Date.now() + 1000) return { ok: false, error: "That time is in the past." };
    const id = await Background.scheduleReminder(text, whenMs);
    return id
      ? { ok: true, id, at: new Date(whenMs).toString() }
      : { ok: false, error: "Couldn't schedule — the user may need to allow notifications." };
  },
  list_reminders: async () => {
    const r = await Background.listReminders();
    return { ok: true, count: r.length, reminders: r };
  },
  cancel_reminder: async (args) => {
    const ok = await Background.cancelReminder(String(args.id ?? ""));
    return ok ? { ok: true } : { ok: false, error: "Couldn't cancel / no such id." };
  },
  memory_save: async (args) => {
    const tags = Array.isArray(args.tags) ? (args.tags as unknown[]).map(String) : [];
    const e = await Memory.addMemory(String(args.text ?? ""), tags, Date.now());
    return { ok: true, id: e.id };
  },
  memory_search: async (args) => {
    const r = await Memory.searchMemory(String(args.query ?? ""));
    return { ok: true, count: r.length, results: r.map((e) => ({ id: e.id, text: e.text, tags: e.tags })) };
  },
  memory_list: async () => {
    const r = await Memory.listMemory();
    return { ok: true, count: r.length, results: r.map((e) => ({ id: e.id, text: e.text, tags: e.tags })) };
  },
  memory_delete: async (args) => {
    const ok = await Memory.deleteMemory(String(args.id ?? ""));
    return ok ? { ok: true } : { ok: false, error: "No such memory id." };
  },
  save_secret: async (args) => {
    const name = normalizeSecretName(String(args.name ?? ""));
    const value = String(args.value ?? "");
    if (!name) return { ok: false, error: "Provide a clear NAME (e.g. STRIPE_API_KEY)." };
    if (!value) return { ok: false, error: "No value provided." };
    await saveSecret(name, value);
    return { ok: true, name, note: `Stored securely. Reference it as {{${name}}} — don't repeat the raw value.` };
  },
  update_setting: async (args) => {
    const key = String(args.key ?? "").trim().toLowerCase();
    const value = String(args.value ?? "").trim();
    switch (key) {
      case "model":
        if (!value) return { ok: false, error: "Provide a model id." };
        await saveModel(value);
        return { ok: true, key, value, note: "Applies to your next message." };
      case "provider": {
        const p = value.toLowerCase();
        if (p !== "gemini" && p !== "anthropic" && p !== "openai")
          return { ok: false, error: "provider must be gemini, anthropic, or openai." };
        await saveProvider(p as AiProvider);
        return { ok: true, key, value: p, note: "Only works if that provider's key is set in Settings." };
      }
      case "background": {
        const on = /^(on|true|1|yes|enable|enabled)$/.test(value.toLowerCase());
        await saveBackgroundRun(on);
        return { ok: true, key, value: on ? "on" : "off", note: "Background toggle fully applies next time you open the app." };
      }
      case "write_mode": {
        const m = value.toLowerCase();
        if (m !== "pr" && m !== "branch" && m !== "main")
          return { ok: false, error: "write_mode must be pr, branch, or main." };
        await saveWriteMode(m as GitWriteMode);
        return { ok: true, key, value: m };
      }
      default:
        return { ok: false, error: "Unknown setting. Allowed: model, provider, background, write_mode." };
    }
  },
  github_list_path: (args) =>
    Github.listPath(String(args.repo ?? ""), typeof args.path === "string" ? args.path : "", typeof args.ref === "string" ? args.ref : undefined),
  github_get_file: (args) =>
    Github.getFile(String(args.repo ?? ""), String(args.path ?? ""), typeof args.ref === "string" ? args.ref : undefined),
  github_search_code: (args) =>
    Github.searchCode(String(args.query ?? ""), typeof args.repo === "string" ? args.repo : undefined),
  github_apply_patch: (args) =>
    Github.applyPatchAndCommit(
      String(args.repo ?? ""),
      String(args.message ?? ""),
      String(args.diff ?? ""),
      { branch: typeof args.branch === "string" ? args.branch : undefined }
    ),
  github_commit: (args) =>
    Github.commitChangeset(
      String(args.repo ?? ""),
      String(args.message ?? ""),
      Array.isArray(args.files)
        ? (args.files as any[]).map((f) => ({ path: String(f?.path ?? ""), content: String(f?.content ?? "") }))
        : [],
      { branch: typeof args.branch === "string" ? args.branch : undefined }
    ),
};

// Stored secret values, used to scrub anything echoed back into the model/logs.
async function collectSecretValues(): Promise<string[]> {
  const names = await listSecretNames();
  const vals = await Promise.all(names.map(getSecretValue));
  const gh = await getGithubToken();
  return [...vals, gh].filter((v): v is string => !!v && v.length >= 4);
}

function redactString(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join("[REDACTED]");
  return out;
}

// Redact secret values from the string fields a tool returns to the model.
function redactResult(result: Record<string, unknown>, secrets: string[]): Record<string, unknown> {
  if (!secrets.length) return result;
  const out: Record<string, unknown> = { ...result };
  for (const k of ["body", "content", "results", "error", "stdout", "stderr"]) {
    if (typeof out[k] === "string") out[k] = redactString(out[k] as string, secrets);
  }
  return out;
}

async function executeHttpRequest(
  args: Record<string, unknown>,
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  const method = String(args.method ?? "GET").toUpperCase();
  const rawUrl = typeof args.url === "string" ? args.url : "";
  if (!rawUrl) return { ok: false, error: "Missing url." };
  const url = await substituteSecrets(rawUrl);

  // Default to browser-like headers; any header the model set takes precedence.
  const headers: Record<string, string> = { ...BROWSER_HEADERS };
  if (typeof args.headers === "string" && args.headers.trim()) {
    try {
      const parsed = JSON.parse(await substituteSecrets(args.headers));
      for (const [k, v] of Object.entries(parsed)) headers[k] = String(v);
    } catch {
      return { ok: false, error: "headers must be a valid JSON object string." };
    }
  }

  const init: RequestInit = { method, headers, signal };
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

// Read a page in the hidden WebView (JavaScript renders), with offset paging so
// the model can read past the truncation point.
async function executeFetchWebpage(
  args: Record<string, unknown>,
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  const url = typeof args.url === "string" ? args.url : "";
  if (!url) return { ok: false, error: "Missing url." };
  if (signal?.aborted) throw new AbortedError();
  const offset = typeof args.offset === "number" && args.offset > 0 ? Math.floor(args.offset) : 0;
  const page = (t: string) => {
    const slice = t.slice(offset, offset + MAX_PAGE_CHARS);
    const more = t.length > offset + MAX_PAGE_CHARS;
    return more ? slice + `\n...[more — call again with offset ${offset + MAX_PAGE_CHARS}]` : slice;
  };

  const r = await BrowserEngine.fetchPage(url, { signal });
  if (signal?.aborted) throw new AbortedError();
  if (!r.ok) return { ok: false, url, error: r.error ?? "Could not load page." };
  return { ok: true, url, title: r.title, content: page(r.text ?? "") };
}

// Search the web via the hidden WebView loading DuckDuckGo, returning structured
// results (title / url / snippet).
async function executeWebSearch(
  args: Record<string, unknown>,
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) return { ok: false, error: "Missing query." };
  if (signal?.aborted) throw new AbortedError();

  const r = await BrowserEngine.search(query, { signal });
  if (signal?.aborted) throw new AbortedError();
  if (!r.ok) return { ok: false, query, error: r.error ?? "Search failed." };
  const results = (r.results ?? [])
    .map((x, i) => `${i + 1}. ${x.title}\n${x.url}\n${x.snippet}`)
    .join("\n\n");
  return { ok: true, query, results: results || "No results found." };
}

// ---- Gemini call ----

interface GeminiResponse {
  candidates?: { content?: Content }[];
  error?: { message?: string };
  promptFeedback?: { blockReason?: string };
}

async function buildSystemInstruction(memo?: string): Promise<Content> {
  const custom = await getSystemPrompt();
  const base = custom.trim() || DEFAULT_SYSTEM_PROMPT;

  const names = await listSecretNames();
  const secretsLine =
    names.length > 0
      ? `\n\nStored secrets you can reference as {{NAME}} (values hidden from you): ${names.join(", ")}.`
      : `\n\nNo secret credentials are stored yet; if a request needs one, tell the user to add it in Settings.`;

  const memoBlock =
    memo && memo.trim()
      ? `\n\nDense memory of earlier conversation (your own notes, may be terse):\n${memo.trim()}`
      : "";

  const execMode = await getExecMode().catch(() => "off" as const);
  let shizuku: { running: boolean; granted: boolean } = { running: false, granted: false };
  try {
    shizuku = await Shell.shizukuStatus();
  } catch {
    // unavailable
  }
  const shizukuState = shizuku.granted
    ? "connected & granted"
    : shizuku.running
      ? "running but NOT granted (tell the user to grant it in Settings → Developer settings)"
      : "NOT running (tell the user to install/start the Shizuku app, then grant it in Settings → Developer settings)";

  let shellLine = "";
  if (execMode === "off") {
    shellLine =
      "\n\nExecution mode is OFF — you have no on-device shell/Termux tools. If the user asks you to run, build or test code, or operate the device, do NOT just refuse: tell them to pick an Execution mode in Settings → Developer settings (Termux for coding without root, Shizuku for device control, Root if rooted), then retry.";
  } else {
    let avail = `\n\nExecution mode: ${execMode.toUpperCase()}. `;
    if (execMode === "app")
      avail += "run_shell(command) runs in the app's own sandbox — toybox coreutils only (ls/grep/cat/ps/getprop…); no compilers, can't see other apps. For real coding, the user should switch to Termux mode.";
    else if (execMode === "termux")
      avail +=
        "run_shell(command) = quick sandbox shell; run_termux(command) = the REAL toolchain (python/node/clang/git/make) for building & testing code.";
    else if (execMode === "shizuku")
      avail += `run_shell(command) runs at ADB/shell-uid (pm grant/appops, settings, input/am app automation, screencap, dumpsys, read any file); run_termux(command) = real toolchain. Shizuku is ${shizukuState}.`;
    else if (execMode === "root")
      avail += "run_shell(command) runs as ROOT (full system access); run_termux(command) = real toolchain.";

    if (execMode === "termux" || execMode === "shizuku" || execMode === "root") {
      avail +=
        " CODING: use run_termux for compilers — it's a PERSISTENT session (cd + env, incl. activated venvs, carry over between calls). Output is captured in FULL (shows start+end; call read_log(offset) for more). Prefer apply_patch(diff) (surgical git apply) over rewriting whole files. Loop like a CLI agent: cd repo → apply_patch/edit → run_termux test → read output → fix → repeat. Use real git in Termux (branch/diff/commit/push).";
      if (execMode === "termux")
        avail += " NOTE: in this no-root mode, reading Termux output needs All files access — if output can't be read, tell the user to grant it in Settings → Developer settings.";
    }
    if (execMode === "shizuku" || execMode === "root") {
      avail +=
        " DEVICE AUTOMATION: to drive another app's UI via shell, don't guess coordinates — run_shell('uiautomator dump /sdcard/v.xml && cat /sdcard/v.xml'), find the node by text/resource-id, tap its bounds centre with run_shell('input tap <cx> <cy>'), re-dump after each step. Grant yourself permissions with 'pm grant <pkg> <perm>'. These run with elevated privilege and ALWAYS ask the user to confirm (even in Auto mode).";
    } else {
      // Non-privileged modes: still let the AI guide the user toward Shizuku.
      avail += ` (Shizuku is ${shizukuState} — if the user wants device control/automation or no-root output, Shizuku mode needs it.)`;
    }
    shellLine = avail;
  }

  const a11yLine = Shell.a11yEnabled()
    ? "\n\nSCREEN AUTOMATION is ENABLED (accessibility): ui_screen (read the current screen's elements), ui_tap({text|id}), ui_type({text}), ui_global({back|home|recents|notifications}) — drive ANY app by element text/id, not coordinates." +
      " CHOOSING HOW TO ACT (pick the simplest that fully works, in this order): (1) a real API via http_request — most reliable and fully background; use it if the service has one and a key is stored. (2) A deep link / intent (open_link / send_android_intent) that completes the task in one shot — e.g. 'sms:'/'mailto:' with a body, 'tel:', a maps/spotify link. (3) Screen automation when there's no API/deep link, or to finish what a deep link only set up. MANY app actions are 'deep link to pre-fill + accessibility to finish': e.g. WhatsApp — open_link 'https://wa.me/<number>?text=<urlencoded>' (this opens the chat with the message typed), then ui_screen, ui_tap the 'Send' control by its text/description, then ui_global('home') to return to Fraude. Always ui_screen before tapping and again after, and verify the expected element exists before acting. tap/type ask the user to confirm unless Auto mode is on."
    : "\n\nScreen automation is OFF. If the user asks you to operate or automate another app's UI (tap/type/press buttons inside it — e.g. send a WhatsApp/Telegram message through the app), do NOT just refuse — tell them to enable it in Settings → Screen automation first, then retry. (You can still use direct deep links and APIs without it.)";

  const mcp = McpClient.connectedSummary();
  const mcpLine = mcp
    ? `\n\nConnected MCP integrations — their tools are available to you (named mcp__<server>__<tool>); USE them whenever the request relates to that service: ${mcp}.`
    : "";

  const notes = (await getUserNotes()).trim();
  const notesBlock = notes
    ? `\n\nWhat you know about this user (their notes/preferences — honour them; update via update_user_notes when you learn something durable):\n${notes}`
    : `\n\nYou have no saved notes about this user yet. When you learn a durable preference, save it with update_user_notes.`;

  const memCount = await Memory.memoryCount().catch(() => 0);
  const memoryBlock = `\n\nLong-term memory: ${memCount} saved item(s). Use memory_save to remember discrete facts/items/lists/tasks for future chats, and memory_search to recall them when the user refers to something you might have stored. (This is for facts/items; tone/style preferences go in update_user_notes.)`;

  const timeBlock = `\n\nCurrent local time: ${new Date().toString()}. Use this for any date/time reasoning. To set reminders/alarms/nudges, use schedule_reminder (compute the ISO 'at' from this time, or pass inMinutes).`;

  return {
    role: "user",
    parts: [{ text: base + timeBlock + secretsLine + shellLine + a11yLine + mcpLine + notesBlock + memoryBlock + memoBlock }],
  };
}

// Single attempt — NO auto-retry. Retrying burns more of the same quota; the UI
// offers a manual retry instead. Honours abort.
async function callGemini(
  contents: Content[],
  systemInstruction: Content,
  signal?: AbortSignal,
  withTools = true
): Promise<Content> {
  if (signal?.aborted) throw new AbortedError();
  const apiKey = await getGeminiKey();
  if (!apiKey) throw new Error("No Gemini API key. Add it in Settings.");
  const url = `${await genEndpoint()}?key=${encodeURIComponent(apiKey)}`;
  const payload: Record<string, unknown> = { contents, systemInstruction };
  if (withTools) payload.tools = activeTools;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (e) {
    if (signal?.aborted) throw new AbortedError();
    throw new Error(`Network error: ${String(e)}`);
  }
  const data = (await res.json().catch(() => ({}))) as GeminiResponse;
  if (!res.ok) throw new Error(data.error?.message ?? `Gemini request failed (${res.status}).`);
  if (data.promptFeedback?.blockReason)
    throw new Error(`Request blocked by Gemini: ${data.promptFeedback.blockReason}.`);
  const content = data.candidates?.[0]?.content;
  if (!content) throw new Error("Gemini returned no content.");
  return content;
}

// Stream a model turn token-by-token via SSE (expo/fetch). Emits text deltas to
// onToken and returns the full Content (text + any functionCalls). Throws to let
// the caller fall back to the non-streaming path if streaming isn't usable.
async function streamModelTurn(
  contents: Content[],
  systemInstruction: Content,
  signal: AbortSignal | undefined,
  onToken?: (full: string) => void
): Promise<Content> {
  if (typeof TextDecoder === "undefined") throw new Error("STREAM_UNSUPPORTED");
  const apiKey = await getGeminiKey();
  if (!apiKey) throw new Error("No Gemini API key. Add it in Settings.");
  const model = (await getModel()) || DEFAULT_MODEL;
  const url = `${GEMINI_BASE}${model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;
  const body = JSON.stringify({ contents, tools: activeTools, systemInstruction });

  const res = await expoFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Stream failed (${res.status}). ${t.slice(0, 200)}`);
  }
  const reader = res.body?.getReader?.();
  if (!reader) throw new Error("STREAM_UNSUPPORTED");

  const decoder = new TextDecoder();
  let buf = "";
  let textAcc = "";
  let chunks = 0;
  const calls: Part[] = [];

  const consume = (jsonStr: string) => {
    let data: GeminiResponse;
    try {
      data = JSON.parse(jsonStr);
    } catch {
      return;
    }
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    for (const p of parts) {
      if (typeof p.text === "string") {
        chunks += 1;
        textAcc += p.text;
        onToken?.(textAcc);
      }
      if (p.functionCall) calls.push({ functionCall: p.functionCall });
    }
  };

  while (true) {
    if (signal?.aborted) {
      try {
        await reader.cancel();
      } catch {
        // ignore
      }
      throw new AbortedError();
    }
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line.startsWith("data:")) consume(line.slice(5).trim());
    }
  }

  void chunks;
  const finalParts: Part[] = [];
  if (textAcc) finalParts.push({ text: textAcc });
  finalParts.push(...calls);
  return { role: "model", parts: finalParts.length ? finalParts : [{ text: "" }] };
}

// ============================================================================
// Provider adapters — keep the app AI-agnostic. The agent loop speaks one
// internal shape (Gemini-style Content[] with text / functionCall /
// functionResponse / inlineData parts); these translate to/from each backend.
// ============================================================================

// Popular OpenAI-compatible backends, to prefill the base URL in Settings. We
// POST to {baseUrl}/chat/completions. Claude is reachable here via OpenRouter.
export const OPENAI_PRESETS: { id: string; label: string; baseUrl: string; sampleModel: string }[] = [
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", sampleModel: "gpt-4o-mini" },
  { id: "openrouter", label: "OpenRouter — incl. Claude", baseUrl: "https://openrouter.ai/api/v1", sampleModel: "anthropic/claude-3.7-sonnet" },
  { id: "groq", label: "Groq — fast", baseUrl: "https://api.groq.com/openai/v1", sampleModel: "llama-3.3-70b-versatile" },
  { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com", sampleModel: "deepseek-chat" },
  { id: "mistral", label: "Mistral", baseUrl: "https://api.mistral.ai/v1", sampleModel: "mistral-large-latest" },
  { id: "xai", label: "xAI — Grok", baseUrl: "https://api.x.ai/v1", sampleModel: "grok-2-latest" },
  { id: "together", label: "Together AI", baseUrl: "https://api.together.xyz/v1", sampleModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo" },
];

// Claude model presets (native Anthropic).
export const ANTHROPIC_DEFAULT_MODEL = "claude-3-7-sonnet-latest";
export const ANTHROPIC_PRESETS: { id: string; label: string }[] = [
  { id: "claude-3-7-sonnet-latest", label: "Claude 3.7 Sonnet · balanced" },
  { id: "claude-3-5-haiku-latest", label: "Claude 3.5 Haiku · fastest" },
  { id: "claude-opus-4-1", label: "Claude Opus 4.1 · most capable" },
];

function flattenDecls(): FunctionDeclaration[] {
  return activeTools.flatMap((t) => t.functionDeclarations);
}

function systemTextOf(systemInstruction: Content): string {
  return (systemInstruction.parts ?? [])
    .map((p) => p.text)
    .filter((t): t is string => typeof t === "string")
    .join("\n");
}

function imagePartsOf(parts: Part[]): { mimeType: string; data: string }[] {
  return parts
    .map((p) => p.inlineData)
    .filter((x): x is { mimeType: string; data: string } => !!x);
}

// ---- OpenAI-compatible (/chat/completions) ----

function toOpenAiTools(): unknown[] {
  return flattenDecls().map((d) => ({
    type: "function",
    function: { name: d.name, description: d.description, parameters: d.parameters ?? { type: "object", properties: {} } },
  }));
}

// Gemini function responses carry no call id, but OpenAI tool messages need a
// tool_call_id matching the preceding assistant tool_calls. Our loop always
// pairs a model turn's calls with the immediately-following responses (in order),
// so we mint deterministic ids and hand the same batch to the next tool results.
function toOpenAiMessages(systemText: string, contents: Content[]): unknown[] {
  const messages: any[] = [];
  if (systemText) messages.push({ role: "system", content: systemText });
  let pendingIds: string[] = [];
  let pendingIdx = 0;
  contents.forEach((c, i) => {
    const parts = c.parts ?? [];
    if (c.role === "model") {
      const calls = parts.map((p) => p.functionCall).filter((x): x is FunctionCall => !!x);
      const text = parts.map((p) => p.text).filter((t): t is string => typeof t === "string").join("");
      const msg: any = { role: "assistant", content: text || "" };
      if (calls.length) {
        pendingIds = calls.map((_, k) => `call_${i}_${k}`);
        pendingIdx = 0;
        msg.tool_calls = calls.map((fc, k) => ({
          id: pendingIds[k],
          type: "function",
          function: { name: fc.name, arguments: JSON.stringify(fc.args ?? {}) },
        }));
        if (!text) msg.content = null;
      }
      messages.push(msg);
    } else {
      const responses = parts
        .map((p) => p.functionResponse)
        .filter((x): x is { name: string; response: Record<string, unknown> } => !!x);
      for (const r of responses) {
        const id = pendingIds[pendingIdx++] ?? `call_${i}_${pendingIdx}`;
        messages.push({ role: "tool", tool_call_id: id, content: JSON.stringify(r.response).slice(0, 16000) });
      }
      const textParts = parts.map((p) => p.text).filter((t): t is string => typeof t === "string" && t.length > 0);
      const images = imagePartsOf(parts);
      if (textParts.length || images.length) {
        if (images.length) {
          const content: any[] = [];
          if (textParts.length) content.push({ type: "text", text: textParts.join("\n") });
          for (const img of images)
            content.push({ type: "image_url", image_url: { url: `data:${img.mimeType};base64,${img.data}` } });
          messages.push({ role: "user", content });
        } else {
          messages.push({ role: "user", content: textParts.join("\n") });
        }
      }
    }
  });
  return messages;
}

async function callOpenAi(
  contents: Content[],
  systemInstruction: Content,
  signal?: AbortSignal,
  withTools = true,
  onToken?: (full: string) => void
): Promise<Content> {
  if (signal?.aborted) throw new AbortedError();
  const cfg = await getOpenAiConfig();
  if (!cfg.baseUrl || !cfg.apiKey) throw new Error("No AI backend configured. Add a base URL + API key in Settings.");
  const body: Record<string, unknown> = {
    model: cfg.model || "gpt-4o-mini",
    messages: toOpenAiMessages(systemTextOf(systemInstruction), contents),
  };
  if (withTools) {
    const tools = toOpenAiTools();
    if (tools.length) body.tools = tools;
  }
  const base = cfg.baseUrl.replace(/\/+$/, "");
  let res: Response;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (signal?.aborted) throw new AbortedError();
    throw new Error(`Network error: ${String(e)}`);
  }
  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new Error(data?.error?.message ?? `AI request failed (${res.status}).`);
  const message = data?.choices?.[0]?.message;
  if (!message) throw new Error("AI returned no content.");
  const parts: Part[] = [];
  const textOut = typeof message.content === "string" ? message.content : "";
  if (textOut) {
    parts.push({ text: textOut });
    onToken?.(textOut);
  }
  for (const tc of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    const name = tc?.function?.name;
    if (!name) continue;
    let parsedArgs: Record<string, unknown> = {};
    try {
      parsedArgs = JSON.parse(tc.function.arguments || "{}");
    } catch {
      parsedArgs = {};
    }
    parts.push({ functionCall: { name, args: parsedArgs } });
  }
  return { role: "model", parts: parts.length ? parts : [{ text: "" }] };
}

// ---- Native Anthropic (Claude Messages API) ----

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

function toAnthropicTools(): unknown[] {
  return flattenDecls().map((d) => ({
    name: d.name,
    description: d.description,
    input_schema: d.parameters ?? { type: "object", properties: {} },
  }));
}

// Claude carries tool_use ids on the assistant turn and tool_result references
// them — same id-minting trick as OpenAI to bridge our id-less history.
function toAnthropicMessages(contents: Content[]): unknown[] {
  const messages: any[] = [];
  let pendingIds: string[] = [];
  let pendingIdx = 0;
  contents.forEach((c, i) => {
    const parts = c.parts ?? [];
    if (c.role === "model") {
      const calls = parts.map((p) => p.functionCall).filter((x): x is FunctionCall => !!x);
      const text = parts.map((p) => p.text).filter((t): t is string => typeof t === "string").join("");
      const blocks: any[] = [];
      if (text) blocks.push({ type: "text", text });
      if (calls.length) {
        pendingIds = calls.map((_, k) => `toolu_${i}_${k}`);
        pendingIdx = 0;
        for (let k = 0; k < calls.length; k++)
          blocks.push({ type: "tool_use", id: pendingIds[k], name: calls[k].name, input: calls[k].args ?? {} });
      }
      messages.push({ role: "assistant", content: blocks.length ? blocks : [{ type: "text", text: "" }] });
    } else {
      const responses = parts
        .map((p) => p.functionResponse)
        .filter((x): x is { name: string; response: Record<string, unknown> } => !!x);
      const blocks: any[] = [];
      for (const r of responses) {
        const id = pendingIds[pendingIdx++] ?? `toolu_${i}_${pendingIdx}`;
        blocks.push({ type: "tool_result", tool_use_id: id, content: JSON.stringify(r.response).slice(0, 16000) });
      }
      const textParts = parts.map((p) => p.text).filter((t): t is string => typeof t === "string" && t.length > 0);
      for (const t of textParts) blocks.push({ type: "text", text: t });
      for (const img of imagePartsOf(parts))
        blocks.push({ type: "image", source: { type: "base64", media_type: img.mimeType, data: img.data } });
      if (blocks.length) messages.push({ role: "user", content: blocks });
    }
  });
  return messages;
}

async function callAnthropic(
  contents: Content[],
  systemInstruction: Content,
  signal?: AbortSignal,
  withTools = true,
  onToken?: (full: string) => void
): Promise<Content> {
  if (signal?.aborted) throw new AbortedError();
  const cfg = await getAnthropicConfig();
  if (!cfg.apiKey) throw new Error("No Anthropic API key. Add it in Settings.");
  const body: Record<string, unknown> = {
    model: cfg.model || ANTHROPIC_DEFAULT_MODEL,
    max_tokens: 4096,
    system: systemTextOf(systemInstruction),
    messages: toAnthropicMessages(contents),
  };
  if (withTools) {
    const tools = toAnthropicTools();
    if (tools.length) body.tools = tools;
  }
  let res: Response;
  try {
    res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": cfg.apiKey,
        "anthropic-version": "2023-06-01",
        // Allow the call from a non-browser app context without a CORS preflight.
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (signal?.aborted) throw new AbortedError();
    throw new Error(`Network error: ${String(e)}`);
  }
  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new Error(data?.error?.message ?? `Claude request failed (${res.status}).`);
  const blocks = Array.isArray(data?.content) ? data.content : [];
  const parts: Part[] = [];
  let textAcc = "";
  for (const b of blocks) {
    if (b?.type === "text" && typeof b.text === "string") {
      textAcc += b.text;
      parts.push({ text: b.text });
      onToken?.(textAcc);
    } else if (b?.type === "tool_use" && b.name) {
      parts.push({ functionCall: { name: b.name, args: (b.input ?? {}) as Record<string, unknown> } });
    }
  }
  return { role: "model", parts: parts.length ? parts : [{ text: "" }] };
}

// Provider dispatcher: one model turn in our internal shape, routed to the
// configured backend. Gemini streams (token-by-token) with a non-streaming
// fallback; the others are single-shot (text emitted once via onToken).
async function callModel(
  contents: Content[],
  systemInstruction: Content,
  signal?: AbortSignal,
  onToken?: (full: string) => void,
  withTools = true
): Promise<Content> {
  const provider = await getProvider();
  if (provider === "openai") return callOpenAi(contents, systemInstruction, signal, withTools, onToken);
  if (provider === "anthropic") return callAnthropic(contents, systemInstruction, signal, withTools, onToken);
  // Gemini.
  if (!withTools) return callGemini(contents, systemInstruction, signal, false);
  try {
    return await streamModelTurn(contents, systemInstruction, signal, onToken);
  } catch (err) {
    if (err instanceof AbortedError) throw err;
    // Don't fire a 2nd request for rate-limit/quota errors — it wastes more quota.
    if (/\b429\b|quota|RESOURCE_EXHAUSTED|rate.?limit/i.test(String(err))) throw err;
    return await callGemini(contents, systemInstruction, signal);
  }
}

// Provider-neutral single text completion (no tools) — for compaction & titles.
async function generateText(prompt: string): Promise<string> {
  const sys: Content = { role: "user", parts: [{ text: "You are a helpful assistant." }] };
  const turn = await callModel([{ role: "user", parts: [{ text: prompt }] }], sys, undefined, undefined, false);
  return textIn(turn);
}

// After the AI stores a credential with save_secret, purge the raw value from
// the conversation (the user's pasted text + the tool-call args) so it isn't
// persisted in the saved transcript or re-sent on later turns — replaced with
// the {{NAME}} reference it's now stored under.
function scrubFromHistory(history: Content[], value: string, name: string): void {
  if (!value || value.length < 4) return;
  const ref = `{{${name}}}`;
  for (const c of history) {
    for (const p of c.parts ?? []) {
      if (typeof p.text === "string" && p.text.includes(value)) p.text = p.text.split(value).join(ref);
      const args = p.functionCall?.args;
      if (args) {
        for (const k of Object.keys(args)) {
          const v = args[k];
          if (typeof v === "string" && v.includes(value)) args[k] = v.split(value).join(ref);
        }
      }
    }
  }
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
  // Live token stream of the model's text for the current turn (full text so far).
  onToken?: (fullText: string) => void;
  // Abort the whole turn (Stop button).
  signal?: AbortSignal;
  // Ask the user before a state-changing API call (POST/PUT/PATCH/DELETE).
  // Resolve false to decline (the model is told and can adapt).
  confirmWrite?: (req: { method: string; url: string }) => Promise<boolean>;
}

export class AbortedError extends Error {
  constructor() {
    super("Stopped.");
    this.name = "AbortedError";
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new AbortedError());
    });
  });
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
  if (call.name === "fetch_webpage") return `Reading web page: ${url}`;
  if (call.name === "web_search") return `Searching the web: ${String(call.args?.query ?? "")}`;
  if (call.name === "http_request") return `Calling API: ${String(call.args?.method ?? "")} ${url}`.trim();
  if (call.name === "open_link") return `Opening: ${url}`;
  if (call.name === "check_app_available") return `Checking app: ${url}`;
  if (call.name === "share_content") return "Opening share sheet...";
  if (call.name === "clipboard_get") return "Reading clipboard...";
  if (call.name === "clipboard_set") return "Copying to clipboard...";
  if (call.name === "send_android_intent") return `Handing off to app: ${String(call.args?.package ?? call.args?.action ?? "")}`;
  if (call.name === "grant_folder") return "Requesting folder access...";
  if (call.name === "list_files") return "Listing files...";
  if (call.name === "read_file") return "Reading file...";
  if (call.name === "pick_file") return "Waiting for file pick...";
  if (call.name === "write_file" || call.name === "create_file") return "Writing file...";
  if (call.name === "update_user_notes") return "Updating your notes...";
  if (call.name === "save_secret") return "Saving credential securely...";
  if (call.name === "schedule_reminder") return "Setting a reminder...";
  if (call.name === "list_reminders") return "Checking reminders...";
  if (call.name === "cancel_reminder") return "Cancelling reminder...";
  if (call.name === "memory_save") return "Saving to memory...";
  if (call.name === "memory_search") return "Recalling from memory...";
  if (call.name === "memory_list") return "Reading memory...";
  if (call.name === "memory_delete") return "Forgetting...";
  if (call.name === "update_setting") return `Updating setting: ${String(call.args?.key ?? "")}`;
  if (call.name === "run_shell") return `Running command: ${String(call.args?.command ?? "")}`;
  if (call.name === "run_termux") return `Running in Termux: ${String(call.args?.command ?? "")}`;
  if (call.name === "read_log") return "Reading output...";
  if (call.name === "apply_patch") return "Applying patch...";
  if (call.name === "ui_screen") return "Reading the screen...";
  if (call.name === "ui_tap") return `Tapping: ${String(call.args?.text ?? call.args?.id ?? "")}`;
  if (call.name === "ui_type") return "Typing...";
  if (call.name === "ui_global") return `Pressing: ${String(call.args?.action ?? "")}`;
  if (call.name === "github_list_path" || call.name === "github_get_file") return `Reading repo: ${String(call.args?.repo ?? "")}`;
  if (call.name === "github_search_code") return "Searching code...";
  if (call.name === "github_commit") return `Committing to ${String(call.args?.repo ?? "")}...`;
  if (call.name === "github_apply_patch") return `Applying patch to ${String(call.args?.repo ?? "")}...`;
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
  const signal = callbacks.signal;
  // Merge connected MCP servers' tools into this turn's tool set (before building
  // the prompt, so it can name the live integrations).
  const execMode = await getExecMode().catch(() => "off" as const);
  const builtins = [...TOOLS[0].functionDeclarations];
  if (execMode !== "off") builtins.push(SHELL_TOOL);
  // Termux toolchain tools only in modes that can use it.
  if (execMode === "termux" || execMode === "shizuku" || execMode === "root")
    builtins.push(TERMUX_TOOL, READ_LOG_TOOL, APPLY_PATCH_TOOL);
  if (Shell.a11yEnabled()) builtins.push(...UI_TOOLS);
  try {
    await McpClient.ensureConnections();
    const mcp = McpClient.getMcpToolDeclarations();
    activeTools = [{ functionDeclarations: [...builtins, ...mcp] }];
  } catch {
    activeTools = [{ functionDeclarations: builtins }];
  }
  const systemInstruction = await buildSystemInstruction(memo);
  const secrets = await collectSecretValues();
  const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (signal?.aborted) throw new AbortedError();
    setStatus("Thinking...");
    // Route to the configured backend (Gemini streams; others are single-shot).
    const turn = await callModel(history, systemInstruction, signal, callbacks.onToken);
    history.push(turn);

    const calls = functionCallsIn(turn);
    if (calls.length === 0) {
      setStatus(null);
      return { contents: history, reply: textIn(turn) || "(no response)" };
    }

    const responseParts: Part[] = [];
    for (const call of calls) {
      if (signal?.aborted) throw new AbortedError();
      setStatus(statusFor(call));
      const executor = TOOL_EXECUTORS[call.name];
      let result: Record<string, unknown>;
      if (McpClient.isMcpTool(call.name)) {
        try {
          result = await McpClient.callMcpTool(call.name, call.args ?? {});
        } catch (err) {
          result = { ok: false, error: String(err) };
        }
      } else if (!executor) {
        result = { ok: false, error: `Unknown tool: ${call.name}` };
      } else {
        // Confirm EVERY state-changing / outward action before executing it.
        const method = String(call.args?.method ?? "GET").toUpperCase();
        const a = call.args ?? {};
        let needsConfirm = false;
        let confirmMethod = method;
        let confirmUrl = typeof a.url === "string" ? (a.url as string) : "";
        if (call.name === "http_request" && WRITE_METHODS.has(method)) {
          needsConfirm = true;
        } else if (call.name === "open_link") {
          needsConfirm = true;
          confirmMethod = "OPEN";
        } else if (call.name === "send_android_intent") {
          needsConfirm = true;
          confirmMethod = "INTENT";
          confirmUrl = `${String(a.action ?? "")} ${String(a.package ?? "")}`.trim();
        } else if (call.name === "write_file" || call.name === "create_file") {
          needsConfirm = true;
          confirmMethod = "FILE";
          confirmUrl = String(a.uri ?? a.name ?? "a file");
        } else if (call.name === "run_shell") {
          needsConfirm = true;
          confirmMethod = "SHELL";
          const tag = execMode === "root" ? "[root] " : execMode === "shizuku" ? "[shizuku] " : "";
          confirmUrl = `${tag}${String(a.command ?? "")}`;
        } else if (call.name === "run_termux") {
          needsConfirm = true;
          confirmMethod = "SHELL";
          confirmUrl = `[termux] ${String(a.command ?? "")}`;
        } else if (call.name === "apply_patch") {
          needsConfirm = true;
          confirmMethod = "FILE";
          confirmUrl = "apply a git patch in the Termux session";
        } else if (call.name === "ui_tap") {
          needsConfirm = true;
          confirmMethod = "UI";
          confirmUrl = `tap ${String(a.text ?? a.id ?? "")}`;
        } else if (call.name === "ui_type") {
          needsConfirm = true;
          confirmMethod = "UI";
          confirmUrl = `type "${String(a.text ?? "")}"`;
        } else if (call.name === "update_setting") {
          needsConfirm = true;
          confirmMethod = "SETTING";
          confirmUrl = `${String(a.key ?? "")} → ${String(a.value ?? "")}`;
        } else if (call.name === "github_commit") {
          needsConfirm = true;
          confirmMethod = "COMMIT";
          const n = Array.isArray(a.files) ? (a.files as unknown[]).length : 0;
          confirmUrl = `${String(a.repo ?? "")} · ${n} file(s)`;
        } else if (call.name === "github_apply_patch") {
          needsConfirm = true;
          confirmMethod = "COMMIT";
          confirmUrl = `${String(a.repo ?? "")} · patch`;
        }
        if (needsConfirm && callbacks.confirmWrite && !(await callbacks.confirmWrite({ method: confirmMethod, url: confirmUrl }))) {
          result = { ok: false, error: "The user declined this request. Do not retry it; ask them what to do instead." };
        } else {
          try {
            result = await executor(call.args ?? {}, signal);
          } catch (err) {
            if (signal?.aborted) throw new AbortedError();
            result = { ok: false, error: String(err) };
          }
        }
      }
      result = redactResult(result, secrets);
      // A credential was just stored → purge its raw value from the transcript.
      if (call.name === "save_secret" && result.ok) {
        const v = String(call.args?.value ?? "");
        scrubFromHistory(history, v, String(result.name ?? "SECRET"));
        if (v.length >= 4) secrets.push(v); // also scrub it from later tool output this turn
      }
      await maybeLogFailure(call, result, ctx);
      responseParts.push({ functionResponse: { name: call.name, response: result } });
    }

    history.push({ role: "user", parts: responseParts });
  }

  // Hit the tool-use ceiling: instead of crashing, ask for a best-effort answer
  // with tools disabled so the user still gets a useful, honest summary.
  if (signal?.aborted) throw new AbortedError();
  setStatus("Wrapping up...");
  const nudge: Content[] = [
    ...history,
    {
      role: "user",
      parts: [
        {
          text:
            "You've reached the tool-use limit for this turn. Stop calling tools and give your best answer now using what you've gathered, clearly noting anything you couldn't complete.",
        },
      ],
    },
  ];
  const summary = await callModel(nudge, systemInstruction, signal, undefined, false);
  setStatus(null);
  return { contents: history, reply: textIn(summary) || "(stopped after reaching the tool limit)" };
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
  const prompt =
    "You maintain a dense, token-efficient MEMORY LOG of a conversation, for your " +
    "own future reference only (never shown to a human, so do not optimise for " +
    "readability). Merge the PRIOR MEMORY and the NEW EXCHANGES into one updated " +
    "memory. Preserve: durable facts, user preferences, decisions, task state, " +
    "useful tool results/URLs, and open threads. Drop pleasantries and redundancy. " +
    "Use terse bullet shorthand. Output ONLY the updated memory text.\n\n" +
    `PRIOR MEMORY:\n${memo || "(none)"}\n\nNEW EXCHANGES:\n${renderTurns(turnsToFold)}`;
  try {
    const text = await generateText(prompt);
    return text || memo;
  } catch {
    return memo;
  }
}

// A short title for a new thread, derived from the first user message.
export async function suggestTitle(firstMessage: string): Promise<string> {
  try {
    const t = await generateText(`Give a 3-5 word title (no quotes) for a chat that starts: "${firstMessage}"`);
    return (t || firstMessage).replace(/^["']|["']$/g, "").slice(0, 48) || "New chat";
  } catch {
    return firstMessage.slice(0, 40) || "New chat";
  }
}
