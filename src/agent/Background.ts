// Background execution helpers.
//
// True OS-level "keep running forever in the background" needs a native
// foreground service. The only Expo module for that (expo-foreground-actions)
// is abandoned and incompatible with SDK 52, so we take the reliable route:
//   - we stop KILLING the turn the moment the app is backgrounded (the old
//     behaviour); the JS turn keeps running under the OS's normal background
//     grace (usually long enough to finish a request — Android gives more than
//     iOS, which caps at ~30s);
//   - when a turn finishes while the app is backgrounded we fire a local
//     notification so the user knows their reply is ready;
//   - if the OS does suspend/kill us mid-turn, persist/resume in ChatScreen
//     offers a "Continue" button on reopen, so nothing is ever lost.

import * as Notifications from "expo-notifications";

let notifReady = false;

async function ensureNotifications(): Promise<void> {
  if (notifReady) return;
  notifReady = true;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
  try {
    await Notifications.requestPermissionsAsync();
  } catch {
    // best-effort
  }
}

// Ask for notification permission up front (when the user enables background).
export async function requestNotificationPermission(): Promise<void> {
  await ensureNotifications();
}

// Notify the user a reply landed (used when the turn finished while backgrounded).
export async function notifyTurnDone(title: string, reply: string): Promise<void> {
  await ensureNotifications();
  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: title?.trim() || "Fraude",
        body: (reply || "Your reply is ready.").replace(/\s+/g, " ").trim().slice(0, 160),
      },
      trigger: null,
    });
  } catch {
    // best-effort
  }
}
