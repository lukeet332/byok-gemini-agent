// App shell: a tiny navigator over three views — the thread list, an open chat,
// and settings. No navigation library; the app is small enough to switch views
// with state. The bottom bar toggles Chats vs. Settings; opening/creating a
// thread pushes the chat view (with a back button to the list).

import React, { useEffect, useState } from "react";
import { ActivityIndicator, AppState, BackHandler, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { getShareIntent } from "./modules/shell-exec";

import AnimatedSplash from "./src/screens/AnimatedSplash";
import HiddenBrowser from "./src/browser/HiddenBrowser";
import ChatScreen from "./src/screens/ChatScreen";
import SettingsScreen from "./src/screens/SettingsScreen";
import SetupScreen from "./src/screens/SetupScreen";
import ThreadListScreen from "./src/screens/ThreadListScreen";
import { getStartupPermsDone, hasModelAccess, setStartupPermsDone } from "./src/storage/SecureStorage";
import { requestStartupPermissions } from "./src/device/Permissions";
import { theme } from "./src/theme";

type View_ = "list" | "chat" | "settings";

let threadSeq = 0;
const newThreadId = () => `${Date.now()}-${++threadSeq}`;

export default function App() {
  const [view, setView] = useState<View_>("list");
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  // Bumped whenever a thread changes so the list reloads when shown again.
  const [, setListVersion] = useState(0);
  // null = still checking; false = needs setup; true = ready.
  const [ready, setReady] = useState<boolean | null>(null);
  const [splashDone, setSplashDone] = useState(false);
  // Text shared into Fraude from another app (via "Share → Fraude").
  const [sharedText, setSharedText] = useState<string | null>(null);
  // A saved-routine prompt to auto-send in a fresh chat.
  const [routinePrompt, setRoutinePrompt] = useState<string | null>(null);

  useEffect(() => {
    hasModelAccess().then(setReady);
  }, []);

  // On first open (after the splash), request the runtime permissions the app
  // uses — once. Special-access grants stay behind their Settings buttons.
  useEffect(() => {
    if (!splashDone) return;
    (async () => {
      if (await getStartupPermsDone()) return;
      await requestStartupPermissions();
      await setStartupPermsDone();
    })();
  }, [splashDone]);

  // Android back / back-swipe: navigate WITHIN the app (chat or settings → the
  // list) instead of exiting. Only on the list do we let Android close the app.
  // ChatScreen registers its own handler too (it mounts after this, so it runs
  // first): it blocks back while a task is running, otherwise returns false and
  // this handler takes over to pop to the list.
  useEffect(() => {
    const onBack = () => {
      if (view === "chat" || view === "settings") {
        setView("list");
        return true;
      }
      return false; // already on the list — allow the OS to background/exit
    };
    const sub = BackHandler.addEventListener("hardwareBackPress", onBack);
    return () => sub.remove();
  }, [view]);

  function openThread(id: string) {
    setActiveThreadId(id);
    setView("chat");
  }
  function newChat() {
    openThread(newThreadId());
  }
  function runRoutine(prompt: string) {
    setRoutinePrompt(prompt);
    openThread(newThreadId());
  }

  // If launched/resumed via a share, open a fresh chat pre-filled with the text.
  useEffect(() => {
    if (!ready) return;
    const handle = () => {
      const s = getShareIntent();
      if (s && s.text) {
        setSharedText(s.subject ? `${s.subject}\n${s.text}` : s.text);
        openThread(newThreadId());
      }
    };
    handle();
    const sub = AppState.addEventListener("change", (st) => {
      if (st === "active") handle();
    });
    return () => sub.remove();
  }, [ready]);

  const onChats = view === "list" || view === "chat";

  let body: React.ReactNode;
  if (ready === null) {
    body = (
      <View style={[styles.root, styles.center]}>
        <ActivityIndicator color={theme.accent} />
      </View>
    );
  } else if (!ready) {
    body = (
      <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
        <SetupScreen onDone={() => setReady(true)} />
      </SafeAreaView>
    );
  } else {
    body = (
      <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
        {view === "chat" ? (
          <View style={styles.chatHeader}>
            <TouchableOpacity onPress={() => setView("list")} style={styles.back} hitSlop={8}>
              <Ionicons name="chevron-back" size={22} color={theme.accent} style={styles.backIcon} />
              <Text style={styles.backText}>Chats</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        <View style={styles.screen}>
          {view === "list" ? (
            <ThreadListScreen onOpen={openThread} onNew={newChat} onRunRoutine={runRoutine} />
          ) : view === "chat" && activeThreadId ? (
            <ChatScreen
              threadId={activeThreadId}
              onThreadChanged={() => setListVersion((v) => v + 1)}
              onOpenSettings={() => setView("settings")}
              onBack={() => setView("list")}
              initialText={sharedText ?? undefined}
              onShareConsumed={() => setSharedText(null)}
              initialSend={routinePrompt ?? undefined}
              onSendConsumed={() => setRoutinePrompt(null)}
            />
          ) : (
            <SettingsScreen />
          )}
        </View>

        <View style={styles.tabBar}>
          <TabButton label="Chats" active={onChats} onPress={() => setView("list")} />
          <TabButton label="Settings" active={view === "settings"} onPress={() => setView("settings")} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      {body}
      {/* Mount the hidden browser engine only AFTER the splash, so cold-start
          WebView init doesn't block first paint (it would flash white). */}
      {splashDone ? <HiddenBrowser /> : null}
      {!splashDone ? <AnimatedSplash onFinish={() => setSplashDone(true)} /> : null}
    </SafeAreaProvider>
  );
}

function TabButton({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity style={styles.tab} onPress={onPress}>
      <Text style={[styles.tabText, active && styles.tabTextActive]}>{label}</Text>
      {active ? <View style={styles.tabIndicator} /> : null}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  center: { alignItems: "center", justifyContent: "center" },
  screen: { flex: 1 },
  chatHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
  },
  back: { flexDirection: "row", alignItems: "center", paddingVertical: 4, paddingHorizontal: 4 },
  backIcon: { marginRight: 1, marginTop: 1 }, // optical alignment with the text
  backText: { color: theme.accent, fontSize: 16, fontWeight: "600" },
  tabBar: { flexDirection: "row", borderTopWidth: 1, borderTopColor: theme.border, backgroundColor: theme.surface },
  tab: { flex: 1, alignItems: "center", paddingVertical: 12 },
  tabText: { color: theme.textDim, fontSize: 14, fontWeight: "600" },
  tabTextActive: { color: theme.accent },
  tabIndicator: { marginTop: 6, width: 28, height: 3, borderRadius: 2, backgroundColor: theme.accent },
});
