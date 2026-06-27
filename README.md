# BYOK Gemini Agent

A fully **serverless, client-side** AI agent for your phone, built with Expo
(TypeScript). It's like a command-line agent assistant — real internet access,
real tool use — but running entirely on-device on the **free Gemini model**
(`gemini-2.5-flash`), unlike the locked-down stock phone assistants.

**Bring Your Own Key (BYOK):** you paste your own Gemini key plus any other API
keys you want. Everything is stored only in the device's hardware-backed keystore
(`expo-secure-store`). The agent references your secrets **by name** (`{{NAME}}`)
and substitutes the real values on-device just before a request — so your keys
reach the target API but are **never sent to the Gemini model** and never to any
backend of ours.

## What it can do

- **Call any API** — a generic `http_request` tool lets the model hit any
  endpoint (GET/POST/…), authenticating with your stored secrets via `{{NAME}}`
  placeholders in the URL, headers, or body.
- **Read the web** — a `fetch_webpage` tool pulls a page and returns clean text
  (HTML stripped) for the model to read and digest as context.
- **Chain steps** — the agent loops (up to 12 rounds), so it can fetch a page →
  call an API with what it found → call another API with that result, etc.
- **Render richly** — model replies render as markdown with **inline images**.
- **Persist conversations** — every chat is saved on-device as its own thread.
- **Compact context** — when a thread's history grows large, older turns are
  folded by Gemini into a dense, AI-only "memo" (token-efficient, not formatted
  for humans), the same idea as context compaction.
- **Surface errors** — failed API/web calls are fed back to the model so it can
  self-correct, and logged on-device so you can browse them per chat in Settings.

## How the loop works (`src/agent/GeminiAgent.ts`)

1. Your message is appended to the thread's `contents` history.
2. A `fetch` POST hits
   `…/models/gemini-2.5-flash:generateContent?key=…` with the `contents`, the
   `tools`, and a `systemInstruction` (which lists your secret *names* + the
   dense memo of earlier turns).
3. If the model returns `functionCall`s, each tool runs on-device
   (`http_request` / `fetch_webpage`), `{{SECRET}}` placeholders are substituted,
   and the `model` turn + a `functionResponse` user turn are appended. Failures
   are logged and returned to the model. Then it loops to step 2.
4. On a plain text answer, the loop ends and the reply is rendered.

## Project layout

| File | Role |
| --- | --- |
| `src/storage/SecureStorage.ts` | Gemini key + arbitrary named secrets (keystore) |
| `src/storage/ThreadStore.ts` | Per-thread JSON persistence + compaction thresholds |
| `src/storage/ErrorLogStore.ts` | On-device log of failed tool calls |
| `src/agent/GeminiAgent.ts` | Tools, secret substitution, the loop, compaction |
| `src/screens/ChatScreen.tsx` | One thread; markdown + inline images |
| `src/screens/ThreadListScreen.tsx` | All chats (new / open / delete) |
| `src/screens/SettingsScreen.tsx` | Keys, secrets, and the error-log viewer |
| `App.tsx` | View switcher (list / chat / settings) |

## Setup

```bash
npm install
npm start          # press a / i, or scan the QR
```

In **Settings**, paste your **Gemini API key** (from
[Google AI Studio](https://aistudio.google.com/apikey)). Then add any other API
secrets you like (e.g. `NOTION_KEY`, `OPENAI_KEY`, `GITHUB_TOKEN`) — give each a
NAME and value. In chat, just ask; the model uses `{{NAME}}` to authenticate when
it calls that service.

## Adding a tool

1. Add a `FunctionDeclaration` to `TOOLS` in `GeminiAgent.ts`.
2. Register an async executor in `TOOL_EXECUTORS` keyed by the tool name.

The loop discovers and dispatches it automatically.

## Builds & releases (CI)

`.github/workflows/release.yml` runs on every push to `main`, **entirely on
GitHub-hosted runners** (no Expo/EAS servers): typecheck → `expo prebuild` +
Gradle `assembleRelease` → an installable Android **APK** attached to a GitHub
Release (`v1.0.<run-number>`). iOS is intentionally not built (needs Apple
signing).

## Security notes

- Keys live only in `expo-secure-store`; the model sees secret *names*, never
  values.
- A generic "call any API with my keys" agent is powerful — be aware that a
  malicious web page or prompt could try to misuse a tool. Only store keys you're
  comfortable giving the agent, and review the error log if something looks off.
- No analytics, no telemetry, no backend. Conversations are stored only on-device.
