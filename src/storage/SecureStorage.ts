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
// GitHub PAT for the coding backend (a first-class function key).
const GITHUB_KEY = "GITHUB_TOKEN";
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

// ---- GitHub PAT (coding backend) ----

export async function getGithubToken(): Promise<string> {
  return (await SecureStore.getItemAsync(GITHUB_KEY)) ?? "";
}

export async function saveGithubToken(value: string): Promise<void> {
  const v = value.trim();
  if (v) await SecureStore.setItemAsync(GITHUB_KEY, v);
  else await SecureStore.deleteItemAsync(GITHUB_KEY);
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
