// On-device persistence for chat threads. Each thread is a JSON file in the
// app's document directory; a small index file lists them for the thread picker.
// Conversation history lives only on the device — nothing is uploaded anywhere
// except the user's own Gemini/API calls.

import * as FileSystem from "expo-file-system";

import { Content, Thread, ThreadMeta } from "../types";

const DIR = FileSystem.documentDirectory + "threads/";
const INDEX = DIR + "index.json";

// When the kept verbatim history exceeds this (chars of JSON ~ 4x tokens), fold
// the oldest turns into the dense memo and keep only the most recent ones.
export const COMPACT_THRESHOLD_CHARS = 24000;
export const KEEP_RECENT_TURNS = 6;

async function ensureDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(DIR);
  if (!info.exists) await FileSystem.makeDirectoryAsync(DIR, { intermediates: true });
}

function fileFor(id: string): string {
  return `${DIR}thread-${id}.json`;
}

async function readIndex(): Promise<ThreadMeta[]> {
  try {
    const raw = await FileSystem.readAsStringAsync(INDEX);
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeIndex(metas: ThreadMeta[]): Promise<void> {
  await ensureDir();
  const sorted = [...metas].sort((a, b) => b.updatedAt - a.updatedAt);
  await FileSystem.writeAsStringAsync(INDEX, JSON.stringify(sorted));
}

export async function listThreads(): Promise<ThreadMeta[]> {
  return readIndex();
}

export async function loadThread(id: string): Promise<Thread | null> {
  try {
    const raw = await FileSystem.readAsStringAsync(fileFor(id));
    return JSON.parse(raw) as Thread;
  } catch {
    return null;
  }
}

export async function saveThread(thread: Thread): Promise<void> {
  await ensureDir();
  await FileSystem.writeAsStringAsync(fileFor(thread.id), JSON.stringify(thread));
  const metas = await readIndex();
  const meta: ThreadMeta = { id: thread.id, title: thread.title, updatedAt: thread.updatedAt };
  await writeIndex([meta, ...metas.filter((m) => m.id !== thread.id)]);
}

export async function deleteThread(id: string): Promise<void> {
  try {
    await FileSystem.deleteAsync(fileFor(id), { idempotent: true });
  } catch {
    // ignore
  }
  await writeIndex((await readIndex()).filter((m) => m.id !== id));
}

// Create a fresh, empty thread (not yet persisted until first save).
export function newThread(now: number, id: string): Thread {
  return { id, title: "New chat", createdAt: now, updatedAt: now, memo: "", contents: [] };
}

// Rough size of the verbatim history, to decide when to compact.
export function historySize(contents: Content[]): number {
  return JSON.stringify(contents).length;
}
