// Saved routines — named, reusable prompts the user can run with one tap
// ("Morning brief", "Process my inbox", "Plan my day"). Stored on-device.

import * as FileSystem from "expo-file-system";

const FILE = FileSystem.documentDirectory + "routines.json";

export interface Routine {
  id: string;
  name: string;
  prompt: string;
}

let cache: Routine[] | null = null;

async function load(): Promise<Routine[]> {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(await FileSystem.readAsStringAsync(FILE));
    cache = Array.isArray(parsed) ? parsed : [];
  } catch {
    cache = [];
  }
  return cache;
}

async function persist(items: Routine[]): Promise<void> {
  cache = items;
  await FileSystem.writeAsStringAsync(FILE, JSON.stringify(items));
}

export async function listRoutines(): Promise<Routine[]> {
  return load();
}

export async function addRoutine(name: string, prompt: string): Promise<Routine> {
  const items = await load();
  const r: Routine = { id: `${items.length}-${name.slice(0, 8)}-${items.length + 1}`, name: name.trim(), prompt: prompt.trim() };
  await persist([...items, r]);
  return r;
}

export async function deleteRoutine(id: string): Promise<void> {
  const items = await load();
  await persist(items.filter((r) => r.id !== id));
}
