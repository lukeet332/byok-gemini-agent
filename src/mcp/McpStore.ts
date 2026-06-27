// Persisted MCP connection state: per-server auth token (Bearer) + any custom
// servers the user added. Tokens are secrets → kept in expo-secure-store.

import * as SecureStore from "expo-secure-store";

import { McpCatalogEntry, MCP_CATALOG } from "./catalog";

const STATE_KEY = "MCP_STATE";

interface PersistedState {
  // serverId -> bearer token ("" allowed for auth:"none" servers that are enabled)
  tokens: Record<string, string>;
  // user-added custom servers
  custom: McpCatalogEntry[];
}

let cache: PersistedState | null = null;

async function load(): Promise<PersistedState> {
  if (cache) return cache;
  try {
    const raw = await SecureStore.getItemAsync(STATE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    cache = { tokens: parsed.tokens ?? {}, custom: Array.isArray(parsed.custom) ? parsed.custom : [] };
  } catch {
    cache = { tokens: {}, custom: [] };
  }
  return cache;
}

async function persist(): Promise<void> {
  if (cache) await SecureStore.setItemAsync(STATE_KEY, JSON.stringify(cache));
}

// All servers (catalog + custom).
export async function allServers(): Promise<McpCatalogEntry[]> {
  const s = await load();
  return [...MCP_CATALOG, ...s.custom];
}

// Connected = we have an entry (token present, or an empty string marker for
// no-auth servers the user enabled).
export async function isConnected(id: string): Promise<boolean> {
  const s = await load();
  return id in s.tokens;
}

export async function getToken(id: string): Promise<string | undefined> {
  const s = await load();
  return s.tokens[id];
}

export async function connectedIds(): Promise<string[]> {
  const s = await load();
  return Object.keys(s.tokens);
}

export async function setConnection(id: string, token: string): Promise<void> {
  const s = await load();
  s.tokens[id] = token;
  await persist();
}

export async function disconnect(id: string): Promise<void> {
  const s = await load();
  delete s.tokens[id];
  await persist();
}

export async function addCustom(server: McpCatalogEntry): Promise<void> {
  const s = await load();
  s.custom = [...s.custom.filter((c) => c.id !== server.id), server];
  await persist();
}

export async function removeCustom(id: string): Promise<void> {
  const s = await load();
  s.custom = s.custom.filter((c) => c.id !== id);
  delete s.tokens[id];
  await persist();
}
