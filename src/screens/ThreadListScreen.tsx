// Thread list: every locally-saved conversation. Tap to open, swipe-free delete
// button per row, and a prominent "New chat" action.

import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  ListRenderItemInfo,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

import { deleteThread, listThreads } from "../storage/ThreadStore";
import { addRoutine, deleteRoutine, listRoutines, Routine } from "../storage/RoutinesStore";
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
  onRunRoutine: (prompt: string) => void;
}

export default function ThreadListScreen({ onOpen, onNew, onRunRoutine }: Props) {
  const [threads, setThreads] = useState<ThreadMeta[] | null>(null);
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPrompt, setNewPrompt] = useState("");

  async function reload() {
    setThreads(await listThreads());
    setRoutines(await listRoutines());
  }

  useEffect(() => {
    reload();
  }, []);

  async function saveRoutine() {
    if (!newName.trim() || !newPrompt.trim()) return;
    await addRoutine(newName, newPrompt);
    setNewName("");
    setNewPrompt("");
    setAddOpen(false);
    setRoutines(await listRoutines());
  }

  function confirmDeleteRoutine(r: Routine) {
    Alert.alert("Delete routine", `Remove “${r.name}”?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          await deleteRoutine(r.id);
          setRoutines(await listRoutines());
        },
      },
    ]);
  }

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

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.routines}
        keyboardShouldPersistTaps="handled"
      >
        {routines.map((r) => (
          <TouchableOpacity
            key={r.id}
            style={styles.routineChip}
            onPress={() => onRunRoutine(r.prompt)}
            onLongPress={() => confirmDeleteRoutine(r)}
          >
            <Text style={styles.routineText}>{r.name}</Text>
          </TouchableOpacity>
        ))}
        <TouchableOpacity style={[styles.routineChip, styles.routineAdd]} onPress={() => setAddOpen(true)}>
          <Text style={styles.routineAddText}>+ Routine</Text>
        </TouchableOpacity>
      </ScrollView>

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

      <Modal visible={addOpen} transparent animationType="fade" onRequestClose={() => setAddOpen(false)}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setAddOpen(false)}>
          <View style={styles.modalCard} onStartShouldSetResponder={() => true}>
            <Text style={styles.modalTitle}>New routine</Text>
            <Text style={styles.modalHint}>A saved prompt you can run with one tap. Long-press a chip to delete.</Text>
            <TextInput
              style={styles.modalInput}
              value={newName}
              onChangeText={setNewName}
              placeholder="Name, e.g. Morning brief"
              placeholderTextColor={theme.textDim}
            />
            <TextInput
              style={[styles.modalInput, styles.modalPrompt]}
              value={newPrompt}
              onChangeText={setNewPrompt}
              placeholder="Prompt, e.g. Summarise my calendar today and any missed notifications."
              placeholderTextColor={theme.textDim}
              multiline
            />
            <TouchableOpacity
              style={[styles.saveRoutine, (!newName.trim() || !newPrompt.trim()) && styles.disabled]}
              onPress={saveRoutine}
              disabled={!newName.trim() || !newPrompt.trim()}
            >
              <Text style={styles.saveRoutineText}>Save routine</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>
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
  routines: { paddingHorizontal: 16, paddingBottom: 8, gap: 8, alignItems: "center" },
  routineChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.surface,
  },
  routineText: { color: theme.text, fontSize: 13, fontWeight: "600" },
  routineAdd: { borderColor: theme.accent, borderStyle: "dashed" },
  routineAddText: { color: theme.accent, fontSize: 13, fontWeight: "700" },
  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "center", padding: 22 },
  modalCard: { backgroundColor: theme.surface, borderRadius: 16, borderWidth: 1, borderColor: theme.border, padding: 16 },
  modalTitle: { color: theme.text, fontSize: 18, fontWeight: "700" },
  modalHint: { color: theme.textDim, fontSize: 13, marginTop: 4, marginBottom: 12, lineHeight: 18 },
  modalInput: {
    color: theme.text,
    fontSize: 15,
    padding: 12,
    backgroundColor: theme.surfaceAlt,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.border,
    marginBottom: 10,
  },
  modalPrompt: { minHeight: 90, textAlignVertical: "top" },
  saveRoutine: { backgroundColor: theme.accent, borderRadius: 12, paddingVertical: 14, alignItems: "center", marginTop: 2 },
  saveRoutineText: { color: theme.bg, fontWeight: "700", fontSize: 15 },
  disabled: { opacity: 0.4 },
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
