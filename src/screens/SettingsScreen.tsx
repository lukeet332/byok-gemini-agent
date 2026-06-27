// Settings: the user's Gemini key plus an arbitrary set of named API
// credentials. Everything is read from / written to expo-secure-store via
// SecureStorage and never leaves the device except as the user's own direct
// API calls. The agent references these secrets by NAME ({{NAME}}), so the raw
// values are never sent to Gemini.

import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

import { getGeminiKey, loadSecrets, normalizeSecretName, saveAll, NamedSecret } from "../storage/SecureStorage";
import { clearErrors, listErrorsByThread, ErrorGroup } from "../storage/ErrorLogStore";
import { theme } from "../theme";

function when(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString();
}

export default function SettingsScreen() {
  const [geminiKey, setGeminiKey] = useState("");
  const [secrets, setSecrets] = useState<NamedSecret[]>([]);
  const [newName, setNewName] = useState("");
  const [newValue, setNewValue] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [errorGroups, setErrorGroups] = useState<ErrorGroup[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setGeminiKey(await getGeminiKey());
      setSecrets(await loadSecrets());
      setErrorGroups(await listErrorsByThread());
      setLoading(false);
    })();
  }, []);

  async function onClearLogs() {
    await clearErrors();
    setErrorGroups([]);
    setExpanded(null);
  }

  function addSecret() {
    const name = normalizeSecretName(newName);
    if (!name) return;
    setSecrets((prev) => {
      const without = prev.filter((s) => s.name !== name);
      return [...without, { name, value: newValue.trim() }].sort((a, b) => a.name.localeCompare(b.name));
    });
    setNewName("");
    setNewValue("");
  }

  function updateSecretValue(name: string, value: string) {
    setSecrets((prev) => prev.map((s) => (s.name === name ? { ...s, value } : s)));
  }

  function removeSecret(name: string) {
    setSecrets((prev) => prev.filter((s) => s.name !== name));
  }

  async function onSave() {
    setSaving(true);
    setStatus(null);
    try {
      await saveAll(geminiKey, secrets);
      setStatus("Saved securely on this device.");
    } catch (err) {
      setStatus(`Save failed: ${String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <View style={[styles.container, styles.center]}>
        <ActivityIndicator color={theme.accent} />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Settings</Text>
        <Text style={styles.subtitle}>
          Bring your own keys. Stored only in this device's secure keystore. The assistant uses your
          secrets by name — their values are never sent to the model.
        </Text>

        <Text style={styles.sectionLabel}>Gemini API key</Text>
        <Text style={styles.hint}>From Google AI Studio. Required to talk to the model.</Text>
        <TextInput
          style={styles.input}
          value={geminiKey}
          onChangeText={setGeminiKey}
          placeholder="not set"
          placeholderTextColor={theme.textDim}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
        />

        <Text style={styles.sectionLabel}>Your API secrets</Text>
        <Text style={styles.hint}>
          Add any API key/token. Reference it in chat as {"{{NAME}}"} (e.g. {"{{OPENAI_KEY}}"}) and the
          AI can call that service for you.
        </Text>

        {secrets.length === 0 ? (
          <Text style={styles.empty}>No secrets yet.</Text>
        ) : (
          secrets.map((s) => (
            <View key={s.name} style={styles.secretRow}>
              <View style={styles.secretCol}>
                <Text style={styles.secretName}>{`{{${s.name}}}`}</Text>
                <TextInput
                  style={styles.secretInput}
                  value={s.value}
                  onChangeText={(v) => updateSecretValue(s.name, v)}
                  placeholder="value"
                  placeholderTextColor={theme.textDim}
                  autoCapitalize="none"
                  autoCorrect={false}
                  secureTextEntry
                />
              </View>
              <TouchableOpacity onPress={() => removeSecret(s.name)} style={styles.removeBtn}>
                <Text style={styles.removeText}>Remove</Text>
              </TouchableOpacity>
            </View>
          ))
        )}

        <View style={styles.addBox}>
          <TextInput
            style={[styles.input, styles.addName]}
            value={newName}
            onChangeText={setNewName}
            placeholder="NAME (e.g. NOTION_KEY)"
            placeholderTextColor={theme.textDim}
            autoCapitalize="characters"
            autoCorrect={false}
          />
          <TextInput
            style={styles.input}
            value={newValue}
            onChangeText={setNewValue}
            placeholder="secret value"
            placeholderTextColor={theme.textDim}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
          />
          <TouchableOpacity style={styles.addBtn} onPress={addSecret}>
            <Text style={styles.addText}>+ Add secret</Text>
          </TouchableOpacity>
        </View>

        <TouchableOpacity style={[styles.saveBtn, saving && styles.disabled]} onPress={onSave} disabled={saving}>
          {saving ? <ActivityIndicator color={theme.bg} /> : <Text style={styles.saveText}>Save</Text>}
        </TouchableOpacity>
        {status ? <Text style={styles.saved}>{status}</Text> : null}

        <View style={styles.logHeader}>
          <Text style={styles.sectionLabel}>Error logs</Text>
          {errorGroups.length > 0 ? (
            <TouchableOpacity onPress={onClearLogs}>
              <Text style={styles.clearText}>Clear all</Text>
            </TouchableOpacity>
          ) : null}
        </View>
        <Text style={styles.hint}>Failed API/web calls, grouped by chat. Tap a chat to see details.</Text>

        {errorGroups.length === 0 ? (
          <Text style={styles.empty}>No errors logged.</Text>
        ) : (
          errorGroups.map((g) => {
            const open = expanded === g.threadId;
            return (
              <View key={g.threadId} style={styles.logGroup}>
                <TouchableOpacity
                  style={styles.logGroupHead}
                  onPress={() => setExpanded(open ? null : g.threadId)}
                >
                  <Text style={styles.logGroupTitle} numberOfLines={1}>
                    {g.threadTitle || "Untitled chat"}
                  </Text>
                  <Text style={styles.logCount}>
                    {g.entries.length} {open ? "▾" : "▸"}
                  </Text>
                </TouchableOpacity>
                {open
                  ? g.entries.map((e) => (
                      <View key={e.id} style={styles.logEntry}>
                        <Text style={styles.logLine}>
                          <Text style={styles.logTool}>{e.tool}</Text>
                          {e.status ? <Text style={styles.logStatus}>{`  ${e.status}`}</Text> : null}
                          <Text style={styles.logTime}>{`  ${when(e.time)}`}</Text>
                        </Text>
                        {e.url ? (
                          <Text style={styles.logUrl} numberOfLines={2}>
                            {(e.method ? e.method + " " : "") + e.url}
                          </Text>
                        ) : null}
                        <Text style={styles.logMsg}>{e.message}</Text>
                        {e.detail ? (
                          <Text style={styles.logDetail} numberOfLines={6}>
                            {e.detail}
                          </Text>
                        ) : null}
                      </View>
                    ))
                  : null}
              </View>
            );
          })
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.bg },
  center: { alignItems: "center", justifyContent: "center" },
  content: { padding: 20, paddingBottom: 48 },
  title: { color: theme.text, fontSize: 28, fontWeight: "700" },
  subtitle: { color: theme.textDim, fontSize: 13, marginTop: 6, marginBottom: 18, lineHeight: 18 },
  sectionLabel: { color: theme.text, fontSize: 16, fontWeight: "700", marginTop: 14 },
  hint: { color: theme.textDim, fontSize: 12, marginTop: 2, marginBottom: 8, lineHeight: 17 },
  input: {
    color: theme.text,
    fontSize: 15,
    padding: 14,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 12,
    marginBottom: 8,
  },
  empty: { color: theme.textDim, fontStyle: "italic", marginVertical: 8 },
  secretRow: { flexDirection: "row", alignItems: "flex-start", marginBottom: 10, gap: 8 },
  secretCol: { flex: 1 },
  secretName: { color: theme.accent, fontSize: 13, fontWeight: "700", marginBottom: 4, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
  secretInput: {
    color: theme.text,
    fontSize: 15,
    padding: 12,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 10,
  },
  removeBtn: { paddingTop: 22, paddingHorizontal: 6 },
  removeText: { color: theme.danger, fontSize: 13, fontWeight: "600" },
  addBox: {
    marginTop: 6,
    padding: 12,
    borderWidth: 1,
    borderColor: theme.border,
    borderStyle: "dashed",
    borderRadius: 12,
  },
  addName: { marginBottom: 8 },
  addBtn: { backgroundColor: theme.surfaceAlt, borderRadius: 10, paddingVertical: 11, alignItems: "center" },
  addText: { color: theme.accent, fontWeight: "700", fontSize: 14 },
  saveBtn: { backgroundColor: theme.accent, borderRadius: 12, paddingVertical: 15, alignItems: "center", marginTop: 18 },
  disabled: { opacity: 0.6 },
  saveText: { color: theme.bg, fontSize: 16, fontWeight: "700" },
  saved: { color: theme.accent, fontSize: 13, marginTop: 14, textAlign: "center" },
  logHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 26 },
  clearText: { color: theme.danger, fontSize: 13, fontWeight: "600" },
  logGroup: { borderWidth: 1, borderColor: theme.border, borderRadius: 12, marginBottom: 8, overflow: "hidden" },
  logGroupHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 13,
    backgroundColor: theme.surface,
  },
  logGroupTitle: { color: theme.text, fontSize: 15, fontWeight: "600", flex: 1 },
  logCount: { color: theme.textDim, fontSize: 13, marginLeft: 8 },
  logEntry: { paddingHorizontal: 13, paddingVertical: 10, borderTopWidth: 1, borderTopColor: theme.border, backgroundColor: theme.bg },
  logLine: { fontSize: 13 },
  logTool: { color: theme.accent, fontWeight: "700" },
  logStatus: { color: theme.danger, fontWeight: "700" },
  logTime: { color: theme.textDim },
  logUrl: { color: theme.textDim, fontSize: 12, marginTop: 3, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
  logMsg: { color: theme.text, fontSize: 13, marginTop: 4 },
  logDetail: {
    color: theme.textDim,
    fontSize: 11,
    marginTop: 4,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  },
});
