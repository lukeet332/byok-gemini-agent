// Settings: the user's Gemini key plus an arbitrary set of named API
// credentials. Everything is read from / written to expo-secure-store via
// SecureStorage and never leaves the device except as the user's own direct
// API calls. The agent references these secrets by NAME ({{NAME}}), so the raw
// values are never sent to Gemini.

import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

import {
  getGeminiKey,
  getGithubToken,
  getModel,
  getSystemPrompt,
  getWriteMode,
  loadSecrets,
  normalizeSecretName,
  saveAll,
  saveGithubToken,
  saveModel,
  saveSystemPrompt,
  saveWriteMode,
  GitWriteMode,
  NamedSecret,
} from "../storage/SecureStorage";
import { clearErrors, listErrorsByThread, ErrorGroup } from "../storage/ErrorLogStore";
import { getUserNotes, saveUserNotes } from "../storage/UserNotes";
import { DEFAULT_MODEL, DEFAULT_SYSTEM_PROMPT, MODEL_PRESETS, listModels } from "../agent/GeminiAgent";
import McpServersModal from "./McpServersModal";
import { theme } from "../theme";

function Link({ label, url }: { label: string; url: string }) {
  return (
    <TouchableOpacity onPress={() => Linking.openURL(url)}>
      <Text style={styles.link}>{label}</Text>
    </TouchableOpacity>
  );
}

function when(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString();
}

export default function SettingsScreen() {
  const [geminiKey, setGeminiKey] = useState("");
  const [model, setModel] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [githubToken, setGithubToken] = useState("");
  const [writeMode, setWriteMode] = useState<GitWriteMode>("pr");
  const [secrets, setSecrets] = useState<NamedSecret[]>([]);
  const [newName, setNewName] = useState("");
  const [newValue, setNewValue] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [errorGroups, setErrorGroups] = useState<ErrorGroup[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [mcpVisible, setMcpVisible] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [userNotes, setUserNotes] = useState("");
  // Live model list from Google (null = loading/failed -> use presets).
  const [models, setModels] = useState<string[] | null>(null);

  useEffect(() => {
    (async () => {
      setGeminiKey(await getGeminiKey());
      setModel(await getModel());
      setGithubToken(await getGithubToken());
      setWriteMode(await getWriteMode());
      setSystemPrompt(await getSystemPrompt());
      setUserNotes(await getUserNotes());
      setSecrets(await loadSecrets());
      setErrorGroups(await listErrorsByThread());
      setLoading(false);
      // Best-effort: pull the live model list from Google (needs the key).
      setModels(await listModels());
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
      await saveModel(model);
      await saveGithubToken(githubToken);
      await saveWriteMode(writeMode);
      await saveSystemPrompt(systemPrompt);
      await saveUserNotes(userNotes);
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
        <Text style={styles.hint}>Required to talk to the model.</Text>
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
        <Link label="Get a free Gemini key →" url="https://aistudio.google.com/apikey" />

        <Text style={styles.sectionLabel}>Model</Text>
        <Text style={styles.hint}>
          {models === null
            ? "Loading available models from Google…"
            : models.length
            ? "Live list from your Google account. Tap one, or type a custom id."
            : "Couldn't fetch the live list — showing common models. Save a valid Gemini key to load the rest."}
        </Text>
        <View style={styles.chips}>
          {(models && models.length ? models : MODEL_PRESETS).map((m) => {
            const active = (model || DEFAULT_MODEL) === m;
            return (
              <TouchableOpacity
                key={m}
                style={[styles.chip, active && styles.chipActive]}
                onPress={() => setModel(m)}
              >
                <Text style={[styles.chipText, active && styles.chipTextActive]}>{m}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
        <TextInput
          style={styles.input}
          value={model}
          onChangeText={setModel}
          placeholder={`custom model id (default ${DEFAULT_MODEL})`}
          placeholderTextColor={theme.textDim}
          autoCapitalize="none"
          autoCorrect={false}
        />

        <Text style={styles.sectionLabel}>GitHub (coding)</Text>
        <Text style={styles.hint}>
          A Personal Access Token lets the assistant read repos and commit changes. Fine-grained, scoped to
          your repos, is safest.
        </Text>
        <TextInput
          style={styles.input}
          value={githubToken}
          onChangeText={setGithubToken}
          placeholder="not set"
          placeholderTextColor={theme.textDim}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
        />
        <Link label="Create a GitHub token →" url="https://github.com/settings/tokens" />

        <Text style={styles.smallLabel}>How code changes are committed</Text>
        <View style={styles.chips}>
          {([
            ["pr", "Branch + PR"],
            ["branch", "Branch only"],
            ["main", "Direct to main"],
          ] as [GitWriteMode, string][]).map(([m, label]) => (
            <TouchableOpacity
              key={m}
              style={[styles.chip, writeMode === m && styles.chipActive]}
              onPress={() => setWriteMode(m)}
            >
              <Text style={[styles.chipText, writeMode === m && styles.chipTextActive]}>{label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <Text style={styles.sectionLabel}>MCP servers</Text>
        <Text style={styles.hint}>
          Connect remote MCP servers to give the assistant more tools. (Also available via /mcp in chat.)
        </Text>
        <TouchableOpacity style={styles.mcpBtn} onPress={() => setMcpVisible(true)}>
          <Text style={styles.mcpBtnText}>Manage MCP servers</Text>
        </TouchableOpacity>

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

        <TouchableOpacity style={styles.accordionHead} onPress={() => setPromptOpen((o) => !o)}>
          <Text style={styles.sectionLabel}>Agent instructions</Text>
          <Text style={styles.accordionChevron}>{promptOpen ? "▾" : "▸"}</Text>
        </TouchableOpacity>
        {promptOpen ? (
          <>
            <Text style={styles.hint}>
              The system prompt that governs how the assistant behaves. Blank = the built-in default
              (shown greyed below). Edit to customise.
            </Text>
            <TextInput
              style={[styles.input, styles.promptInput]}
              value={systemPrompt}
              onChangeText={setSystemPrompt}
              placeholder={DEFAULT_SYSTEM_PROMPT}
              placeholderTextColor={theme.textDim}
              multiline
              autoCorrect={false}
            />
            <View style={styles.promptActions}>
              <TouchableOpacity onPress={() => setSystemPrompt(DEFAULT_SYSTEM_PROMPT)}>
                <Text style={styles.promptAction}>Load default to edit</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setSystemPrompt("")} disabled={!systemPrompt}>
                <Text style={[styles.promptAction, !systemPrompt && styles.promptActionOff]}>Reset to default</Text>
              </TouchableOpacity>
            </View>
          </>
        ) : null}

        <TouchableOpacity style={styles.accordionHead} onPress={() => setNotesOpen((o) => !o)}>
          <Text style={styles.sectionLabel}>Your preferences (AI memory)</Text>
          <Text style={styles.accordionChevron}>{notesOpen ? "▾" : "▸"}</Text>
        </TouchableOpacity>
        {notesOpen ? (
          <>
            <Text style={styles.hint}>
              A personal notes file the assistant reads every chat and updates as it learns your
              preferences. You can edit it directly here.
            </Text>
            <TextInput
              style={[styles.input, styles.promptInput]}
              value={userNotes}
              onChangeText={setUserNotes}
              placeholder="e.g. Prefers concise answers. Based in the UK. Codes in TypeScript."
              placeholderTextColor={theme.textDim}
              multiline
              autoCorrect={false}
            />
            <View style={styles.promptActions}>
              <TouchableOpacity onPress={() => setUserNotes("")} disabled={!userNotes}>
                <Text style={[styles.promptAction, !userNotes && styles.promptActionOff]}>Clear</Text>
              </TouchableOpacity>
            </View>
          </>
        ) : null}

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
      <McpServersModal visible={mcpVisible} onClose={() => setMcpVisible(false)} />
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
  smallLabel: { color: theme.textDim, fontSize: 13, fontWeight: "600", marginTop: 12, marginBottom: 6 },
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
  link: { color: theme.accent, fontSize: 13, fontWeight: "600", marginTop: 2, marginBottom: 4 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 8 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.surface,
  },
  chipActive: { borderColor: theme.accent, backgroundColor: theme.surfaceAlt },
  chipText: { color: theme.textDim, fontSize: 13 },
  chipTextActive: { color: theme.accent, fontWeight: "700" },
  promptInput: { minHeight: 120, textAlignVertical: "top" },
  accordionHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 14 },
  accordionChevron: { color: theme.textDim, fontSize: 16, marginTop: 14 },
  promptActions: { flexDirection: "row", justifyContent: "flex-end", gap: 20, marginTop: 8 },
  promptAction: { color: theme.accent, fontWeight: "700", fontSize: 13 },
  promptActionOff: { opacity: 0.4 },
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
  mcpBtn: { borderWidth: 1, borderColor: theme.accent, borderRadius: 12, paddingVertical: 13, alignItems: "center", marginTop: 4 },
  mcpBtnText: { color: theme.accent, fontWeight: "700", fontSize: 14 },
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
