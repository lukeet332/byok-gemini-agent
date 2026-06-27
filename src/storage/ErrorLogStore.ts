// On-device log of failed tool calls (HTTP/API/web), kept so the user can
// inspect what went wrong per chat. The same detail is also fed back to the
// model during a turn so it can debug and reform the request itself.

import * as FileSystem from "expo-file-system";

const FILE = FileSystem.documentDirectory + "error-log.json";
const MAX_ENTRIES = 300;

export interface ErrorLogEntry {
  id: string;
  threadId: string;
  threadTitle: string;
  time: number;
  tool: string;
  method?: string;
  url?: string;
  status?: number;
  message: string;
  detail?: string;
}

let seq = 0;
const nextId = () => `${Date.now()}-${++seq}`;

async function readAll(): Promise<ErrorLogEntry[]> {
  try {
    const raw = await FileSystem.readAsStringAsync(FILE);
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeAll(entries: ErrorLogEntry[]): Promise<void> {
  await FileSystem.writeAsStringAsync(FILE, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
}

export async function appendError(e: Omit<ErrorLogEntry, "id" | "time">): Promise<void> {
  const all = await readAll();
  all.unshift({ ...e, id: nextId(), time: Date.now() });
  await writeAll(all);
}

export async function listErrors(): Promise<ErrorLogEntry[]> {
  return readAll();
}

export interface ErrorGroup {
  threadId: string;
  threadTitle: string;
  entries: ErrorLogEntry[];
}

// Group log entries by chat thread, most-recent thread first.
export async function listErrorsByThread(): Promise<ErrorGroup[]> {
  const all = await readAll();
  const byId = new Map<string, ErrorGroup>();
  for (const e of all) {
    let g = byId.get(e.threadId);
    if (!g) {
      g = { threadId: e.threadId, threadTitle: e.threadTitle, entries: [] };
      byId.set(e.threadId, g);
    }
    g.entries.push(e);
  }
  return Array.from(byId.values());
}

export async function clearErrors(): Promise<void> {
  await writeAll([]);
}
