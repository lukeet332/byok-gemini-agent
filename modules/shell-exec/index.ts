// JS interface to the native ShellExec module (Android only). Runs a shell
// command and returns its stdout/stderr/exit code. iOS sandboxes forbid this,
// so there we return a clear "unsupported" result instead of throwing.

import { Platform } from "react-native";

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

let native: { exec: (command: string, useSu: boolean, timeoutMs: number) => Promise<ShellResult> } | null = null;
if (Platform.OS === "android") {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    native = require("expo-modules-core").requireNativeModule("ShellExec");
  } catch {
    native = null;
  }
}

export function isShellAvailable(): boolean {
  return native !== null;
}

export async function exec(command: string, useSu = false, timeoutMs = 120000): Promise<ShellResult> {
  if (!native) {
    return { stdout: "", stderr: "Shell execution is only available on Android.", exitCode: -1, timedOut: false };
  }
  return native.exec(command, useSu, timeoutMs);
}
