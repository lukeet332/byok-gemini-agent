// JS interface to the native ShellExec module (Android only). Runs shell
// commands at three privilege levels — app sandbox (`sh`), root (`su`), or
// Shizuku (ADB/shell-uid, no root). iOS sandboxes forbid this, so there we
// return a clear "unsupported" result instead of throwing.

import { Platform } from "react-native";

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

export interface ShizukuStatus {
  running: boolean;
  granted: boolean;
}

interface NativeShell {
  exec: (command: string, useSu: boolean, timeoutMs: number) => Promise<ShellResult>;
  execShizuku: (command: string, timeoutMs: number) => Promise<ShellResult>;
  shizukuStatus: () => Promise<ShizukuStatus>;
  requestShizukuPermission: () => Promise<boolean>;
  runTermux: (commandLine: string) => Promise<{ ok: boolean; error?: string }>;
  a11yEnabled: () => boolean;
  openA11ySettings: () => boolean;
  a11yDump: () => Promise<string>;
  a11yTapText: (text: string) => Promise<boolean>;
  a11yTapId: (id: string) => Promise<boolean>;
  a11ySetText: (text: string) => Promise<boolean>;
  a11yGlobal: (action: string) => Promise<boolean>;
}

let native: NativeShell | null = null;
if (Platform.OS === "android") {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    native = require("expo-modules-core").requireNativeModule("ShellExec");
  } catch {
    native = null;
  }
}

const unsupported: ShellResult = {
  stdout: "",
  stderr: "Shell execution is only available on Android.",
  exitCode: -1,
  timedOut: false,
};

export function isShellAvailable(): boolean {
  return native !== null;
}

export async function exec(command: string, useSu = false, timeoutMs = 120000): Promise<ShellResult> {
  return native ? native.exec(command, useSu, timeoutMs) : unsupported;
}

export async function execShizuku(command: string, timeoutMs = 120000): Promise<ShellResult> {
  return native ? native.execShizuku(command, timeoutMs) : unsupported;
}

export async function shizukuStatus(): Promise<ShizukuStatus> {
  if (!native) return { running: false, granted: false };
  try {
    return await native.shizukuStatus();
  } catch {
    return { running: false, granted: false };
  }
}

export async function requestShizukuPermission(): Promise<boolean> {
  if (!native) return false;
  try {
    return await native.requestShizukuPermission();
  } catch {
    return false;
  }
}

// Fire a command into Termux (where installed toolchains live). Fire-and-forget;
// redirect output to a file and read it back via exec/execShizuku.
export async function runTermux(commandLine: string): Promise<{ ok: boolean; error?: string }> {
  if (!native) return { ok: false, error: "Only available on Android." };
  try {
    return await native.runTermux(commandLine);
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ---- Accessibility UI automation ----

export function a11yEnabled(): boolean {
  try {
    return native ? native.a11yEnabled() : false;
  } catch {
    return false;
  }
}

export function openA11ySettings(): void {
  try {
    native?.openA11ySettings();
  } catch {
    // ignore
  }
}

export async function a11yDump(): Promise<string> {
  return native ? native.a11yDump() : "Only available on Android.";
}

export async function a11yTapText(text: string): Promise<boolean> {
  return native ? native.a11yTapText(text) : false;
}

export async function a11yTapId(id: string): Promise<boolean> {
  return native ? native.a11yTapId(id) : false;
}

export async function a11ySetText(text: string): Promise<boolean> {
  return native ? native.a11ySetText(text) : false;
}

export async function a11yGlobal(action: string): Promise<boolean> {
  return native ? native.a11yGlobal(action) : false;
}
