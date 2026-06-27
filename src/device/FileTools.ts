// File access via the Storage Access Framework (Android). The user grants a
// folder once (e.g. Downloads); we persist the grant so the agent can list and
// read its files in future sessions. No global storage permission needed.

import * as FileSystem from "expo-file-system";
import * as DocumentPicker from "expo-document-picker";
import { Platform } from "react-native";

const SAF = FileSystem.StorageAccessFramework;
const GRANTS_FILE = FileSystem.documentDirectory + "granted-folders.json";

interface Grant {
  uri: string;
  name: string;
}

// Best-effort human name from a SAF tree/document URI (…primary%3ADownload).
function nameFromUri(uri: string): string {
  try {
    const decoded = decodeURIComponent(uri);
    const tail = decoded.split(/[:/]/).pop() || decoded;
    return tail || uri;
  } catch {
    return uri;
  }
}

async function readGrants(): Promise<Grant[]> {
  try {
    const raw = await FileSystem.readAsStringAsync(GRANTS_FILE);
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeGrants(grants: Grant[]): Promise<void> {
  await FileSystem.writeAsStringAsync(GRANTS_FILE, JSON.stringify(grants));
}

// Prompt the user to grant a folder (one-time SAF picker); persist the grant.
export async function grantFolder(): Promise<Record<string, unknown>> {
  if (Platform.OS !== "android") return { ok: false, error: "Folder access is Android-only." };
  try {
    const perm = await SAF.requestDirectoryPermissionsAsync();
    if (!perm.granted) return { ok: false, error: "User did not grant a folder." };
    const grant: Grant = { uri: perm.directoryUri, name: nameFromUri(perm.directoryUri) };
    const grants = await readGrants();
    if (!grants.some((g) => g.uri === grant.uri)) await writeGrants([...grants, grant]);
    return { ok: true, folder: grant.name, uri: grant.uri };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function listGrantedFolders(): Promise<Record<string, unknown>> {
  const grants = await readGrants();
  return { ok: true, folders: grants };
}

// List files in a granted folder (or, with no arg, the granted folders themselves).
export async function listFiles(folderUri?: string): Promise<Record<string, unknown>> {
  if (Platform.OS !== "android") return { ok: false, error: "Folder access is Android-only." };
  const grants = await readGrants();
  if (!folderUri) {
    if (!grants.length) return { ok: true, folders: [], note: "No folders granted yet. Call grant_folder first." };
    return { ok: true, folders: grants };
  }
  if (!grants.some((g) => g.uri === folderUri))
    return { ok: false, error: "That folder isn't granted. Call grant_folder first." };
  try {
    const uris = await SAF.readDirectoryAsync(folderUri);
    const files = uris.map((u) => ({ name: nameFromUri(u), uri: u }));
    return { ok: true, count: files.length, files };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// Read a file's text content (within a granted folder, or a picked file URI).
export async function readFile(uri: string): Promise<Record<string, unknown>> {
  if (!uri) return { ok: false, error: "Missing uri." };
  try {
    const text = await FileSystem.readAsStringAsync(uri);
    const max = 16000;
    const truncated = text.length > max;
    return { ok: true, uri, content: truncated ? text.slice(0, max) + "\n...[truncated]" : text };
  } catch (e) {
    return { ok: false, error: `Could not read file (it may be binary, e.g. a PDF/image): ${String(e)}` };
  }
}

// Overwrite an existing file's text content (e.g. update a granted-folder file).
export async function writeFile(uri: string, content: string): Promise<Record<string, unknown>> {
  if (!uri) return { ok: false, error: "Missing uri." };
  try {
    await FileSystem.writeAsStringAsync(uri, content);
    return { ok: true, uri, bytes: content.length };
  } catch (e) {
    return { ok: false, error: `Could not write file: ${String(e)}` };
  }
}

// Create a new text file inside a granted folder.
export async function createFile(
  folderUri: string,
  name: string,
  content: string,
  mimeType?: string
): Promise<Record<string, unknown>> {
  if (Platform.OS !== "android") return { ok: false, error: "File creation is Android-only here." };
  if (!folderUri || !name) return { ok: false, error: "Missing folderUri or name." };
  const grants = await readGrants();
  if (!grants.some((g) => g.uri === folderUri))
    return { ok: false, error: "That folder isn't granted. Call grant_folder first." };
  try {
    const fileUri = await SAF.createFileAsync(folderUri, name, mimeType || "text/plain");
    await FileSystem.writeAsStringAsync(fileUri, content);
    return { ok: true, uri: fileUri, name };
  } catch (e) {
    return { ok: false, error: `Could not create file: ${String(e)}` };
  }
}

// Let the user pick a single file to hand to the agent.
export async function pickFile(): Promise<Record<string, unknown>> {
  try {
    const res = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
    if (res.canceled || !res.assets?.length) return { ok: false, error: "No file picked." };
    const a = res.assets[0];
    return { ok: true, name: a.name, uri: a.uri, size: a.size, mimeType: a.mimeType };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
