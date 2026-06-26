// Settings: lets the user paste their own API keys. Values are read from and
// written to expo-secure-store via SecureStorage — they never leave the device
// except as Authorization headers on the user's own direct API calls.

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

import { loadSecrets, saveSecrets, StoredSecrets } from "../storage/SecureStorage";
import { theme } from "../theme";

interface FieldProps {
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  secure?: boolean;
}

function Field({ label, hint, value, onChange, secure }: FieldProps) {
  const [hidden, setHidden] = useState(true);
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.hint}>{hint}</Text>
      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          value={value}
          onChangeText={onChange}
          placeholder="not set"
          placeholderTextColor={theme.textDim}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry={secure ? hidden : false}
        />
        {secure ? (
          <TouchableOpacity onPress={() => setHidden((h) => !h)} style={styles.reveal}>
            <Text style={styles.revealText}>{hidden ? "Show" : "Hide"}</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
}

export default function SettingsScreen() {
  const [secrets, setSecrets] = useState<StoredSecrets>({
    GEMINI_API_KEY: "",
    NOTION_API_KEY: "",
    NOTION_DATABASE_ID: "",
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  useEffect(() => {
    loadSecrets()
      .then(setSecrets)
      .finally(() => setLoading(false));
  }, []);

  const update = (key: keyof StoredSecrets) => (value: string) =>
    setSecrets((prev) => ({ ...prev, [key]: value }));

  async function onSave() {
    setSaving(true);
    setSavedAt(null);
    try {
      await saveSecrets(secrets);
      setSavedAt("Saved securely on this device.");
    } catch (err) {
      setSavedAt(`Save failed: ${String(err)}`);
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
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Settings</Text>
        <Text style={styles.subtitle}>
          Bring your own keys. They are stored only in this device's secure keystore.
        </Text>

        <Field
          label="Gemini API key"
          hint="From Google AI Studio. Used to call gemini-2.5-flash directly."
          value={secrets.GEMINI_API_KEY}
          onChange={update("GEMINI_API_KEY")}
          secure
        />
        <Field
          label="Notion API key"
          hint="An internal integration secret (starts with ntn_ / secret_)."
          value={secrets.NOTION_API_KEY}
          onChange={update("NOTION_API_KEY")}
          secure
        />
        <Field
          label="Notion database ID"
          hint="The database where tasks are created. Its title property must be named 'Name'."
          value={secrets.NOTION_DATABASE_ID}
          onChange={update("NOTION_DATABASE_ID")}
        />

        <TouchableOpacity
          style={[styles.saveBtn, saving && styles.saveBtnDisabled]}
          onPress={onSave}
          disabled={saving}
        >
          {saving ? (
            <ActivityIndicator color={theme.bg} />
          ) : (
            <Text style={styles.saveText}>Save keys</Text>
          )}
        </TouchableOpacity>

        {savedAt ? <Text style={styles.saved}>{savedAt}</Text> : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.bg },
  center: { alignItems: "center", justifyContent: "center" },
  content: { padding: 20, paddingBottom: 48 },
  title: { color: theme.text, fontSize: 28, fontWeight: "700" },
  subtitle: { color: theme.textDim, fontSize: 14, marginTop: 6, marginBottom: 20 },
  field: { marginBottom: 18 },
  label: { color: theme.text, fontSize: 15, fontWeight: "600" },
  hint: { color: theme.textDim, fontSize: 12, marginTop: 2, marginBottom: 8 },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 12,
  },
  input: { flex: 1, color: theme.text, fontSize: 15, padding: 14 },
  reveal: { paddingHorizontal: 14 },
  revealText: { color: theme.accent, fontSize: 13, fontWeight: "600" },
  saveBtn: {
    backgroundColor: theme.accent,
    borderRadius: 12,
    paddingVertical: 15,
    alignItems: "center",
    marginTop: 8,
  },
  saveBtnDisabled: { opacity: 0.6 },
  saveText: { color: theme.bg, fontSize: 16, fontWeight: "700" },
  saved: { color: theme.accent, fontSize: 13, marginTop: 14, textAlign: "center" },
});
