// On-device / inter-app actions. These are the mobile-native equivalent of a CLI
// "touching the system": hand data to other apps, open deep links, read/write the
// clipboard, and (Android) fire arbitrary intents. The agent discovers what's
// possible at runtime (check_app_available) and formats the handoff itself.

import * as Clipboard from "expo-clipboard";
import * as IntentLauncher from "expo-intent-launcher";
import { Linking, Platform, Share } from "react-native";

export async function clipboardGet(): Promise<string> {
  return (await Clipboard.getStringAsync()) ?? "";
}

export async function clipboardSet(text: string): Promise<void> {
  await Clipboard.setStringAsync(text);
}

// Hand text to another app via the system share sheet (user picks the target).
export async function shareContent(text: string): Promise<Record<string, unknown>> {
  try {
    const r = await Share.share({ message: text });
    return { ok: r.action !== Share.dismissedAction, action: r.action };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// Is some app able to handle this URL/scheme? (Dynamic capability discovery.)
export async function checkApp(url: string): Promise<Record<string, unknown>> {
  try {
    return { ok: true, available: await Linking.canOpenURL(url) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// Open a URL or deep link (https://wa.me/..., whatsapp://, tel:, mailto:, geo:, etc.).
export async function openLink(url: string): Promise<Record<string, unknown>> {
  try {
    if (!(await Linking.canOpenURL(url))) return { ok: false, error: `No installed app can open: ${url}` };
    await Linking.openURL(url);
    return { ok: true, opened: url };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export interface IntentOpts {
  action: string;
  data?: string;
  type?: string;
  packageName?: string;
  text?: string; // convenience -> android.intent.extra.TEXT
  extras?: Record<string, unknown>;
}

// Fire an arbitrary Android intent (advanced app handoff). Android only.
export async function sendIntent(opts: IntentOpts): Promise<Record<string, unknown>> {
  if (Platform.OS !== "android") return { ok: false, error: "Android intents are not available on this platform." };
  try {
    const extra: Record<string, unknown> = { ...(opts.extras ?? {}) };
    if (opts.text) extra["android.intent.extra.TEXT"] = opts.text;
    await IntentLauncher.startActivityAsync(opts.action, {
      data: opts.data,
      type: opts.type,
      packageName: opts.packageName,
      extra: Object.keys(extra).length ? extra : undefined,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
