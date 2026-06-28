// Request the runtime (dialog-based) permissions the app uses, once on first
// open. Special-access grants that aren't runtime dialogs — accessibility,
// notification listener, all-files, Shizuku — are intentionally NOT here; they
// live behind their Settings buttons (forcing users to system screens on launch
// would be hostile). Each request is best-effort; a denial doesn't block the app.

import * as Calendar from "expo-calendar";
import * as Contacts from "expo-contacts";
import * as ImagePicker from "expo-image-picker";
import * as Location from "expo-location";
import * as Notifications from "expo-notifications";
import { ExpoSpeechRecognitionModule } from "expo-speech-recognition";

export async function requestStartupPermissions(): Promise<void> {
  const steps: { label: string; run: () => Promise<unknown> }[] = [
    { label: "notifications", run: () => Notifications.requestPermissionsAsync() },
    { label: "microphone", run: () => ExpoSpeechRecognitionModule.requestPermissionsAsync() },
    { label: "photos", run: () => ImagePicker.requestMediaLibraryPermissionsAsync() },
    { label: "contacts", run: () => Contacts.requestPermissionsAsync() },
    { label: "calendar", run: () => Calendar.requestCalendarPermissionsAsync() },
    { label: "location", run: () => Location.requestForegroundPermissionsAsync() },
  ];
  // Sequentially, so the system dialogs don't overlap.
  for (const step of steps) {
    try {
      await step.run();
    } catch {
      // a failed/denied request must not block the rest
    }
  }
}
