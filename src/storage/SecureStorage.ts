// Thin, typed wrapper around expo-secure-store. Every secret the app holds lives
// here and ONLY here: the user's private API keys are written to the device's
// hardware-backed keystore (Android Keystore / iOS Keychain) and are never
// hardcoded, logged, or transmitted to any backend we control.

import * as SecureStore from "expo-secure-store";

// Stable storage keys. Changing these strings orphans previously saved values.
export const StorageKeys = {
  GEMINI_API_KEY: "GEMINI_API_KEY",
  NOTION_API_KEY: "NOTION_API_KEY",
  NOTION_DATABASE_ID: "NOTION_DATABASE_ID",
} as const;

export type StorageKey = (typeof StorageKeys)[keyof typeof StorageKeys];

// All secrets, loaded together for the Settings form.
export interface StoredSecrets {
  GEMINI_API_KEY: string;
  NOTION_API_KEY: string;
  NOTION_DATABASE_ID: string;
}

async function get(key: StorageKey): Promise<string> {
  const value = await SecureStore.getItemAsync(key);
  return value ?? "";
}

async function set(key: StorageKey, value: string): Promise<void> {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    // Empty input clears the stored value rather than persisting whitespace.
    await SecureStore.deleteItemAsync(key);
    return;
  }
  await SecureStore.setItemAsync(key, trimmed);
}

// Read a single secret. Returns "" when unset.
export function getSecret(key: StorageKey): Promise<string> {
  return get(key);
}

// Load every secret at once (used to hydrate the Settings screen).
export async function loadSecrets(): Promise<StoredSecrets> {
  const [gemini, notionKey, notionDb] = await Promise.all([
    get(StorageKeys.GEMINI_API_KEY),
    get(StorageKeys.NOTION_API_KEY),
    get(StorageKeys.NOTION_DATABASE_ID),
  ]);
  return {
    GEMINI_API_KEY: gemini,
    NOTION_API_KEY: notionKey,
    NOTION_DATABASE_ID: notionDb,
  };
}

// Persist every secret at once (used by the Settings "Save" button).
export async function saveSecrets(secrets: StoredSecrets): Promise<void> {
  await Promise.all([
    set(StorageKeys.GEMINI_API_KEY, secrets.GEMINI_API_KEY),
    set(StorageKeys.NOTION_API_KEY, secrets.NOTION_API_KEY),
    set(StorageKeys.NOTION_DATABASE_ID, secrets.NOTION_DATABASE_ID),
  ]);
}
