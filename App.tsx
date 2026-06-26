// App shell: a minimal two-tab switcher (Chat / Settings). We avoid a navigation
// library to keep the dependency surface small — the app is just two screens.

import React, { useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";

import ChatScreen from "./src/screens/ChatScreen";
import SettingsScreen from "./src/screens/SettingsScreen";
import { theme } from "./src/theme";

type Tab = "chat" | "settings";

export default function App() {
  const [tab, setTab] = useState<Tab>("chat");

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
        <View style={styles.screen}>
          {tab === "chat" ? <ChatScreen /> : <SettingsScreen />}
        </View>

        <View style={styles.tabBar}>
          <TabButton label="Chat" active={tab === "chat"} onPress={() => setTab("chat")} />
          <TabButton
            label="Settings"
            active={tab === "settings"}
            onPress={() => setTab("settings")}
          />
        </View>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function TabButton({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
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
  tabBar: {
    flexDirection: "row",
    borderTopWidth: 1,
    borderTopColor: theme.border,
    backgroundColor: theme.surface,
  },
  tab: { flex: 1, alignItems: "center", paddingVertical: 12 },
  tabText: { color: theme.textDim, fontSize: 14, fontWeight: "600" },
  tabTextActive: { color: theme.accent },
  tabIndicator: {
    marginTop: 6,
    width: 28,
    height: 3,
    borderRadius: 2,
    backgroundColor: theme.accent,
  },
});
