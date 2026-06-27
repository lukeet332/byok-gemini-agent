// Thread list: every locally-saved conversation. Tap to open, swipe-free delete
// button per row, and a prominent "New chat" action.

import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  ListRenderItemInfo,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

import { deleteThread, listThreads } from "../storage/ThreadStore";
import { ThreadMeta } from "../types";
import { theme } from "../theme";

function ago(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

interface Props {
  onOpen: (id: string) => void;
  onNew: () => void;
}

export default function ThreadListScreen({ onOpen, onNew }: Props) {
  const [threads, setThreads] = useState<ThreadMeta[] | null>(null);

  async function reload() {
    setThreads(await listThreads());
  }

  useEffect(() => {
    reload();
  }, []);

  async function onDelete(id: string) {
    await deleteThread(id);
    reload();
  }

  function renderItem({ item }: ListRenderItemInfo<ThreadMeta>) {
    return (
      <View style={styles.row}>
        <TouchableOpacity style={styles.rowMain} onPress={() => onOpen(item.id)}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {item.title}
          </Text>
          <Text style={styles.rowTime}>{ago(item.updatedAt)}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => onDelete(item.id)} style={styles.del}>
          <Text style={styles.delText}>Delete</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Chats</Text>
        <TouchableOpacity style={styles.newBtn} onPress={onNew}>
          <Text style={styles.newText}>+ New chat</Text>
        </TouchableOpacity>
      </View>

      {threads === null ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.accent} />
        </View>
      ) : (
        <FlatList
          data={threads}
          keyExtractor={(t) => t.id}
          renderItem={renderItem}
          contentContainerStyle={styles.list}
          ListEmptyComponent={
            <View style={styles.center}>
              <Text style={styles.empty}>No chats yet.</Text>
              <Text style={styles.emptyHint}>Tap “+ New chat” to start.</Text>
            </View>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.bg },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 10,
  },
  title: { color: theme.text, fontSize: 28, fontWeight: "700" },
  newBtn: { backgroundColor: theme.accent, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 9 },
  newText: { color: theme.bg, fontWeight: "700", fontSize: 14 },
  list: { paddingHorizontal: 16, paddingBottom: 24, flexGrow: 1 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 12,
    marginVertical: 5,
  },
  rowMain: { flex: 1, paddingVertical: 14, paddingHorizontal: 14 },
  rowTitle: { color: theme.text, fontSize: 16, fontWeight: "600" },
  rowTime: { color: theme.textDim, fontSize: 12, marginTop: 3 },
  del: { paddingHorizontal: 14, paddingVertical: 14 },
  delText: { color: theme.danger, fontSize: 13, fontWeight: "600" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  empty: { color: theme.text, fontSize: 16, fontWeight: "600" },
  emptyHint: { color: theme.textDim, fontSize: 14, marginTop: 6 },
});
