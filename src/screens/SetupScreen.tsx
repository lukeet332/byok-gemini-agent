// First-run setup. The main app is gated behind this until a Gemini key is
// entered. The Jina key is optional (with a one-line explainer). Both are saved
// to the secure keystore.

import React, { useState } from "react";
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

import { saveGeminiKey } from "../storage/SecureStorage";
import { theme } from "../theme";

export default function SetupScreen({ onDone }: { onDone: () => void }) {
  const [geminiKey, setGeminiKey] = useState("");
  const [saving, setSaving] = useState(false);

  const canContinue = geminiKey.trim().length > 0 && !saving;

  async function onContinue() {
    if (!canContinue) return;
    setSaving(true);
    await saveGeminiKey(geminiKey);
    onDone();
  }

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Fraude</Text>
        <Text style={styles.subtitle}>
          A private, on-device AI agent with real web + API access. Bring your own keys — they're stored only
          on this device.
        </Text>

        <Text style={styles.label}>Gemini API key</Text>
        <Text style={styles.hint}>Required. Free from Google AI Studio.</Text>
        <TextInput
          style={styles.input}
          value={geminiKey}
          onChangeText={setGeminiKey}
          placeholder="paste your Gemini key"
          placeholderTextColor={theme.textDim}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
        />
        <TouchableOpacity onPress={() => Linking.openURL("https://aistudio.google.com/apikey")}>
          <Text style={styles.link}>Get a free Gemini key →</Text>
        </TouchableOpacity>

        <Text style={styles.note}>
          Web search & page reading work out of the box — no extra keys needed.
        </Text>

        <TouchableOpacity
          style={[styles.continueBtn, !canContinue && styles.disabled]}
          onPress={onContinue}
          disabled={!canContinue}
        >
          {saving ? <ActivityIndicator color={theme.bg} /> : <Text style={styles.continueText}>Continue</Text>}
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.bg },
  content: { padding: 24, paddingTop: 48, flexGrow: 1, justifyContent: "center" },
  title: { color: theme.text, fontSize: 30, fontWeight: "800" },
  subtitle: { color: theme.textDim, fontSize: 14, marginTop: 8, marginBottom: 28, lineHeight: 20 },
  label: { color: theme.text, fontSize: 16, fontWeight: "700" },
  spaced: { marginTop: 22 },
  hint: { color: theme.textDim, fontSize: 12, marginTop: 3, marginBottom: 8, lineHeight: 17 },
  input: {
    color: theme.text,
    fontSize: 15,
    padding: 14,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 12,
  },
  link: { color: theme.accent, fontSize: 13, fontWeight: "600", marginTop: 8 },
  note: { color: theme.textDim, fontSize: 13, marginTop: 22, lineHeight: 19 },
  continueBtn: { backgroundColor: theme.accent, borderRadius: 12, paddingVertical: 16, alignItems: "center", marginTop: 34 },
  disabled: { opacity: 0.4 },
  continueText: { color: theme.bg, fontSize: 16, fontWeight: "700" },
});
