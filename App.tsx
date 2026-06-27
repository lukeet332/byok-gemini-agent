// App shell: a tiny navigator over three views — the thread list, an open chat,
// and settings. No navigation library; the app is small enough to switch views
// with state. The bottom bar toggles Chats vs. Settings; opening/creating a
// thread pushes the chat view (with a back button to the list).

import React, { useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";

import ChatScreen from "./src/screens/ChatScreen";
import SettingsScreen from "./src/screens/SettingsScreen";
import ThreadListScreen from "./src/screens/ThreadListScreen";
import { theme } from "./src/theme";

type View_ = "list" | "chat" | "settings";

let threadSeq = 0;
const newThreadId = () => `${Date.now()}-${++threadSeq}`;

export default function App() {
  const [view, setView] = useState<View_>("list");
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  // Bumped whenever a thread changes so the list reloads when shown again.
  const [, setListVersion] = useState(0);

  function openThread(id: string) {
    setActiveThreadId(id);
    setView("chat");
  }
  function newChat() {
    openThread(newThreadId());
  }

  const onChats = view === "list" || view === "chat";

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
        {view === "chat" ? (
          <View style={styles.chatHeader}>
            <TouchableOpacity onPress={() => setView("list")} style={styles.back}>
              <Text style={styles.backText}>‹ Chats</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        <View style={styles.screen}>
          {view === "list" ? (
            <ThreadListScreen onOpen={openThread} onNew={newChat} />
          ) : view === "chat" && activeThreadId ? (
            <ChatScreen threadId={activeThreadId} onThreadChanged={() => setListVersion((v) => v + 1)} />
          ) : (
            <SettingsScreen />
          )}
        </View>

        <View style={styles.tabBar}>
          <TabButton label="Chats" active={onChats} onPress={() => setView("list")} />
          <TabButton label="Settings" active={view === "settings"} onPress={() => setView("settings")} />
        </View>
      </SafeAreaView>
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
  screen: { flex: 1 },
  chatHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
  },
  back: { paddingVertical: 4, paddingHorizontal: 6 },
  backText: { color: theme.accent, fontSize: 16, fontWeight: "600" },
  tabBar: { flexDirection: "row", borderTopWidth: 1, borderTopColor: theme.border, backgroundColor: theme.surface },
  tab: { flex: 1, alignItems: "center", paddingVertical: 12 },
  tabText: { color: theme.textDim, fontSize: 14, fontWeight: "600" },
  tabTextActive: { color: theme.accent },
  tabIndicator: { marginTop: 6, width: 28, height: 3, borderRadius: 2, backgroundColor: theme.accent },
});
