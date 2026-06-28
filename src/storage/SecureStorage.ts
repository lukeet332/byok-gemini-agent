// Thin, typed wrapper around expo-secure-store. Everything secret lives here and
// ONLY here: the Gemini key plus an arbitrary, user-defined set of named API
// credentials. All are written to the device's hardware-backed keystore
// (Android Keystore / iOS Keychain) — never hardcoded, logged, or sent to any
// backend of ours. The agent references these by NAME and the raw values are
// substituted in locally, so they never reach the Gemini model either.

import * as SecureStore from "expo-secure-store";

// Fixed key for the Gemini API key (needed to call the model itself).
const GEMINI_KEY = "GEMINI_API_KEY";
// Optional Jina key — powers web search + the JS-rendering reader. The app works
// keyless; a free key just raises rate limits. A first-class "function" key,
// like the Gemini one (not a user-defined secret).
const JINA_KEY = "JINA_API_KEY";
// Optional user override of the agent's system prompt (persona / behaviour).
const SYSTEM_PROMPT_KEY = "SYSTEM_PROMPT";
// Selected Gemini model id ("" means: use the built-in default).
const MODEL_KEY = "GEMINI_MODEL";
// Which AI backend the agent talks to. Keeps the app AI-agnostic:
//   "gemini"    — native Google Gemini (default).
//   "anthropic" — native Claude (Messages API) with an Anthropic key.
//   "openai"    — any OpenAI-compatible /chat/completions server (OpenAI,
//                 OpenRouter [incl. Claude], Groq, Mistral, DeepSeek, xAI, local…).
const PROVIDER_KEY = "AI_PROVIDER";
export type AiProvider = "gemini" | "anthropic" | "openai";
// OpenAI-compatible backend config (only used when provider === "openai").
const OPENAI_BASE_KEY = "OPENAI_BASE_URL"; // e.g. https://api.openai.com/v1
const OPENAI_TOKEN_KEY = "OPENAI_API_KEY";
const OPENAI_MODEL_KEY = "OPENAI_MODEL";
// Native Anthropic (Claude) config.
const ANTHROPIC_TOKEN_KEY = "ANTHROPIC_API_KEY";
const ANTHROPIC_MODEL_KEY = "ANTHROPIC_MODEL";
// GitHub PAT for the coding backend (a first-class function key).
const GITHUB_KEY = "GITHUB_TOKEN";
// Keep an agent turn running when the app is backgrounded (Android foreground
// service; iOS best-effort grace period). "" / "1" = on (default), "0" = off.
const BACKGROUND_KEY = "BACKGROUND_RUN";
// Single execution backend the AI uses for running code/commands (so it's never
// ambiguous which to use). Default "off" (GitHub-only, no on-device execution).
//   off     — no shell/termux tools; edit via GitHub.
//   app     — run_shell in Fraude's own sandbox (toybox; no compilers).
//   termux  — run_termux real toolchains (python/node/clang/git) + sandbox shell.
//   shizuku — run_shell at ADB/shell-uid (device control + commands) + termux.
//   root    — run_shell as root + termux.
const EXEC_MODE_KEY = "EXEC_MODE";
export type ExecMode = "off" | "app" | "termux" | "shizuku" | "root";
// Always confirm system-level actions (Shizuku/root shell) even in Auto mode.
// "" / "1" = on (default), "0" = off. Safety rail for elevated commands.
const CONFIRM_SYSTEM_KEY = "CONFIRM_SYSTEM";
// How the AI's code changes land: "pr" (branch+PR), "branch", or "main".
const WRITE_MODE_KEY = "GIT_WRITE_MODE";
export type GitWriteMode = "pr" | "branch" | "main";
// Index of the user's custom secret names (JSON array of strings).
const SECRET_INDEX = "SECRET_NAMES";
// Each custom secret value is stored under this prefix + its name.
const SECRET_PREFIX = "secret__";

// A user-defined credential, e.g. { name: "NOTION_KEY", value: "ntn_..." }.
export interface NamedSecret {
  name: string;
  value: string;
}

function valueKey(name: string): string {
  return SECRET_PREFIX + name;
}

// Secret names are referenced as {{NAME}} by the model, so constrain them to a
// safe, predictable token shape.
export function normalizeSecretName(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_")
    .replace(/^_+|_+$/g, "");
}

// ---- Gemini key ----

export async function getGeminiKey(): Promise<string> {
  return (await SecureStore.getItemAsync(GEMINI_KEY)) ?? "";
}

export async function saveGeminiKey(value: string): Promise<void> {
  const v = value.trim();
  if (v) await SecureStore.setItemAsync(GEMINI_KEY, v);
  else await SecureStore.deleteItemAsync(GEMINI_KEY);
}

// ---- Jina key (optional function key) ----

export async function getJinaKey(): Promise<string> {
  return (await SecureStore.getItemAsync(JINA_KEY)) ?? "";
}

export async function saveJinaKey(value: string): Promise<void> {
  const v = value.trim();
  if (v) await SecureStore.setItemAsync(JINA_KEY, v);
  else await SecureStore.deleteItemAsync(JINA_KEY);
}

// ---- System prompt override ("" means: use the built-in default) ----

export async function getSystemPrompt(): Promise<string> {
  return (await SecureStore.getItemAsync(SYSTEM_PROMPT_KEY)) ?? "";
}

export async function saveSystemPrompt(value: string): Promise<void> {
  const v = value.trim();
  if (v) await SecureStore.setItemAsync(SYSTEM_PROMPT_KEY, v);
  else await SecureStore.deleteItemAsync(SYSTEM_PROMPT_KEY);
}

// ---- Selected Gemini model ("" means: use the built-in default) ----

export async function getModel(): Promise<string> {
  return (await SecureStore.getItemAsync(MODEL_KEY)) ?? "";
}

export async function saveModel(value: string): Promise<void> {
  const v = value.trim();
  if (v) await SecureStore.setItemAsync(MODEL_KEY, v);
  else await SecureStore.deleteItemAsync(MODEL_KEY);
}

// ---- AI provider selection (default: native Gemini) ----

export async function getProvider(): Promise<AiProvider> {
  const v = (await SecureStore.getItemAsync(PROVIDER_KEY)) as AiProvider | null;
  return v === "openai" || v === "anthropic" ? v : "gemini";
}

export async function saveProvider(p: AiProvider): Promise<void> {
  await SecureStore.setItemAsync(PROVIDER_KEY, p);
}

// ---- OpenAI-compatible backend config ----

export interface OpenAiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export async function getOpenAiConfig(): Promise<OpenAiConfig> {
  return {
    baseUrl: (await SecureStore.getItemAsync(OPENAI_BASE_KEY)) ?? "",
    apiKey: (await SecureStore.getItemAsync(OPENAI_TOKEN_KEY)) ?? "",
    model: (await SecureStore.getItemAsync(OPENAI_MODEL_KEY)) ?? "",
  };
}

export async function saveOpenAiConfig(c: OpenAiConfig): Promise<void> {
  const set = async (k: string, v: string) => {
    const t = v.trim();
    if (t) await SecureStore.setItemAsync(k, t);
    else await SecureStore.deleteItemAsync(k);
  };
  await set(OPENAI_BASE_KEY, c.baseUrl);
  await set(OPENAI_TOKEN_KEY, c.apiKey);
  await set(OPENAI_MODEL_KEY, c.model);
}

// ---- Native Anthropic (Claude) config ----

export interface AnthropicConfig {
  apiKey: string;
  model: string;
}

export async function getAnthropicConfig(): Promise<AnthropicConfig> {
  return {
    apiKey: (await SecureStore.getItemAsync(ANTHROPIC_TOKEN_KEY)) ?? "",
    model: (await SecureStore.getItemAsync(ANTHROPIC_MODEL_KEY)) ?? "",
  };
}

export async function saveAnthropicConfig(c: AnthropicConfig): Promise<void> {
  const set = async (k: string, v: string) => {
    const t = v.trim();
    if (t) await SecureStore.setItemAsync(k, t);
    else await SecureStore.deleteItemAsync(k);
  };
  await set(ANTHROPIC_TOKEN_KEY, c.apiKey);
  await set(ANTHROPIC_MODEL_KEY, c.model);
}

// Whether a usable model backend is configured (gates first-run setup): native
// Gemini needs its key; Claude needs an Anthropic key; an OpenAI-compatible
// backend needs a base URL + key.
export async function hasModelAccess(): Promise<boolean> {
  const provider = await getProvider();
  if (provider === "openai") {
    const c = await getOpenAiConfig();
    return !!(c.baseUrl && c.apiKey);
  }
  if (provider === "anthropic") {
    return !!(await getAnthropicConfig()).apiKey;
  }
  return !!(await getGeminiKey());
}

// ---- GitHub PAT (coding backend) ----

export async function getGithubToken(): Promise<string> {
  return (await SecureStore.getItemAsync(GITHUB_KEY)) ?? "";
}

export async function saveGithubToken(value: string): Promise<void> {
  const v = value.trim();
  if (v) await SecureStore.setItemAsync(GITHUB_KEY, v);
  else await SecureStore.deleteItemAsync(GITHUB_KEY);
}

// ---- Background execution (default: on) ----

export async function getBackgroundRun(): Promise<boolean> {
  return (await SecureStore.getItemAsync(BACKGROUND_KEY)) !== "0";
}

export async function saveBackgroundRun(on: boolean): Promise<void> {
  await SecureStore.setItemAsync(BACKGROUND_KEY, on ? "1" : "0");
}

// ---- Execution mode (advanced; default: off) ----

export async function getExecMode(): Promise<ExecMode> {
  const v = (await SecureStore.getItemAsync(EXEC_MODE_KEY)) as ExecMode | null;
  return v === "app" || v === "termux" || v === "shizuku" || v === "root" ? v : "off";
}

export async function saveExecMode(mode: ExecMode): Promise<void> {
  await SecureStore.setItemAsync(EXEC_MODE_KEY, mode);
}

// Convenience flags used around the app.
export async function isExecOn(): Promise<boolean> {
  return (await getExecMode()) !== "off";
}

// Always confirm Shizuku/root commands even in Auto mode (default: on).
export async function getConfirmSystemActions(): Promise<boolean> {
  return (await SecureStore.getItemAsync(CONFIRM_SYSTEM_KEY)) !== "0";
}

export async function saveConfirmSystemActions(on: boolean): Promise<void> {
  await SecureStore.setItemAsync(CONFIRM_SYSTEM_KEY, on ? "1" : "0");
}

// ---- Git write mode (default: branch + PR) ----

export async function getWriteMode(): Promise<GitWriteMode> {
  const v = (await SecureStore.getItemAsync(WRITE_MODE_KEY)) as GitWriteMode | null;
  return v === "branch" || v === "main" ? v : "pr";
}

export async function saveWriteMode(mode: GitWriteMode): Promise<void> {
  await SecureStore.setItemAsync(WRITE_MODE_KEY, mode);
}

// ---- Custom named secrets ----

async function readIndex(): Promise<string[]> {
  const raw = await SecureStore.getItemAsync(SECRET_INDEX);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((n) => typeof n === "string") : [];
  } catch {
    return [];
  }
}

async function writeIndex(names: string[]): Promise<void> {
  const unique = Array.from(new Set(names)).sort();
  await SecureStore.setItemAsync(SECRET_INDEX, JSON.stringify(unique));
}

// Just the names (for telling the model what's available, without values).
export async function listSecretNames(): Promise<string[]> {
  return readIndex();
}

// Names + values, for hydrating the Settings screen.
export async function loadSecrets(): Promise<NamedSecret[]> {
  const names = await readIndex();
  const entries = await Promise.all(
    names.map(async (name) => ({
      name,
      value: (await SecureStore.getItemAsync(valueKey(name))) ?? "",
    }))
  );
  return entries;
}

// Look up one secret's raw value (used during on-device substitution).
export async function getSecretValue(name: string): Promise<string | null> {
  return SecureStore.getItemAsync(valueKey(name));
}

export async function saveSecret(name: string, value: string): Promise<void> {
  const normalized = normalizeSecretName(name);
  if (!normalized) return;
  await SecureStore.setItemAsync(valueKey(normalized), value.trim());
  const names = await readIndex();
  if (!names.includes(normalized)) await writeIndex([...names, normalized]);
}

export async function deleteSecret(name: string): Promise<void> {
  await SecureStore.deleteItemAsync(valueKey(name));
  await writeIndex((await readIndex()).filter((n) => n !== name));
}

// Persist the whole Settings form at once: the Gemini key plus the full secret
// list (anything previously stored but absent here is removed).
export async function saveAll(geminiKey: string, secrets: NamedSecret[]): Promise<void> {
  await saveGeminiKey(geminiKey);

  const kept: string[] = [];
  for (const s of secrets) {
    const name = normalizeSecretName(s.name);
    if (!name) continue;
    await SecureStore.setItemAsync(valueKey(name), s.value.trim());
    kept.push(name);
  }

  // Drop secrets that were removed in the form.
  const previous = await readIndex();
  for (const old of previous) {
    if (!kept.includes(old)) await SecureStore.deleteItemAsync(valueKey(old));
  }
  await writeIndex(kept);
}
