// A personal markdown file about the user (chat preferences, style, recurring
// context). The AI reads it every turn and can rewrite it via the update_user_notes
// tool; the user can also edit it in Settings. Stored on-device only.

import * as FileSystem from "expo-file-system";

const FILE = FileSystem.documentDirectory + "user-notes.md";
let cache: string | null = null;

export async function getUserNotes(): Promise<string> {
  if (cache !== null) return cache;
  try {
    cache = await FileSystem.readAsStringAsync(FILE);
  } catch {
    cache = "";
  }
  return cache;
}

export async function saveUserNotes(text: string): Promise<void> {
  cache = text;
  await FileSystem.writeAsStringAsync(FILE, text);
}
