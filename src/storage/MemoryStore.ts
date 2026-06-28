// A durable, queryable memory store for the assistant — facts, lists, items,
// tasks, anything worth remembering across chats. Distinct from UserNotes (which
// holds prose preferences): this is structured, searchable entries the AI curates
// via tools. Stored on-device only (documentDirectory/memory.json).

import * as FileSystem from "expo-file-system";

const FILE = FileSystem.documentDirectory + "memory.json";

export interface MemoryEntry {
  id: string;
  text: string;
  tags: string[];
  created: number;
}

let cache: MemoryEntry[] | null = null;
let idSeq = 0;

async function load(): Promise<MemoryEntry[]> {
  if (cache) return cache;
  try {
    const raw = await FileSystem.readAsStringAsync(FILE);
    const parsed = JSON.parse(raw);
    cache = Array.isArray(parsed) ? parsed : [];
  } catch {
    cache = [];
  }
  return cache;
}

async function persist(entries: MemoryEntry[]): Promise<void> {
  cache = entries;
  await FileSystem.writeAsStringAsync(FILE, JSON.stringify(entries));
}

// `now` is passed in (Date.now() isn't available everywhere) for the timestamp.
export async function addMemory(text: string, tags: string[], now: number): Promise<MemoryEntry> {
  const entries = await load();
  const entry: MemoryEntry = {
    id: `${now}-${++idSeq}`,
    text: text.trim(),
    tags: tags.map((t) => t.trim().toLowerCase()).filter(Boolean),
    created: now,
  };
  await persist([entry, ...entries]);
  return entry;
}

// Substring/keyword match over text + tags; most recent first. Empty query = all.
export async function searchMemory(query: string, limit = 30): Promise<MemoryEntry[]> {
  const entries = await load();
  const q = query.trim().toLowerCase();
  if (!q) return entries.slice(0, limit);
  const terms = q.split(/\s+/);
  return entries
    .filter((e) => {
      const hay = (e.text + " " + e.tags.join(" ")).toLowerCase();
      return terms.every((t) => hay.includes(t));
    })
    .slice(0, limit);
}

export async function listMemory(): Promise<MemoryEntry[]> {
  return load();
}

export async function deleteMemory(id: string): Promise<boolean> {
  const entries = await load();
  const next = entries.filter((e) => e.id !== id);
  if (next.length === entries.length) return false;
  await persist(next);
  return true;
}

export async function memoryCount(): Promise<number> {
  return (await load()).length;
}
