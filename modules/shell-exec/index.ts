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
