// First-run setup. The main app is gated behind this until a model backend is
// configured. The app is AI-agnostic: pick Gemini (default), Claude, or any
// OpenAI-compatible backend. Keys are saved to the secure keystore only.

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

import { OPENAI_PRESETS } from "../agent/GeminiAgent";
import {
  AiProvider,
  saveAnthropicConfig,
  saveGeminiKey,
  saveOpenAiConfig,
  saveProvider,
} from "../storage/SecureStorage";
import { theme } from "../theme";

const PROVIDERS: { id: AiProvider; label: string }[] = [
  { id: "gemini", label: "Gemini" },
  { id: "anthropic", label: "Claude" },
  { id: "openai", label: "Other" },
];

export default function SetupScreen({ onDone }: { onDone: () => void }) {
  const [provider, setProvider] = useState<AiProvider>("gemini");
  const [geminiKey, setGeminiKey] = useState("");
  const [anthropicKey, setAnthropicKey] = useState("");
  const [openaiBase, setOpenaiBase] = useState("");
  const [openaiKey, setOpenaiKey] = useState("");
  const [openaiModel, setOpenaiModel] = useState("");
  const [saving, setSaving] = useState(false);

  const canContinue =
    !saving &&
    (provider === "gemini"
      ? geminiKey.trim().length > 0
      : provider === "anthropic"
      ? anthropicKey.trim().length > 0
      : openaiBase.trim().length > 0 && openaiKey.trim().length > 0);

  async function onContinue() {
    if (!canContinue) return;
    setSaving(true);
    await saveProvider(provider);
    if (provider === "gemini") await saveGeminiKey(geminiKey);
    else if (provider === "anthropic") await saveAnthropicConfig({ apiKey: anthropicKey, model: "" });
    else await saveOpenAiConfig({ baseUrl: openaiBase, apiKey: openaiKey, model: openaiModel });
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

        <Text style={styles.label}>AI provider</Text>
        <Text style={styles.hint}>Gemini is the easy default (generous free tier). You can change this later.</Text>
        <View style={styles.segment}>
          {PROVIDERS.map((p) => (
            <TouchableOpacity
              key={p.id}
              style={[styles.segItem, provider === p.id && styles.segItemOn]}
              onPress={() => setProvider(p.id)}
            >
              <Text style={[styles.segText, provider === p.id && styles.segTextOn]}>{p.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {provider === "gemini" ? (
          <View style={styles.block}>
            <Text style={styles.label}>Gemini API key</Text>
            <Text style={styles.hint}>Free from Google AI Studio.</Text>
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
          </View>
        ) : provider === "anthropic" ? (
          <View style={styles.block}>
            <Text style={styles.label}>Anthropic API key</Text>
            <Text style={styles.hint}>Runs Claude directly. Pick a Claude model later in Settings.</Text>
            <TextInput
              style={styles.input}
              value={anthropicKey}
              onChangeText={setAnthropicKey}
              placeholder="sk-ant-…"
              placeholderTextColor={theme.textDim}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
            />
            <TouchableOpacity onPress={() => Linking.openURL("https://console.anthropic.com/settings/keys")}>
              <Text style={styles.link}>Get an Anthropic key →</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.block}>
            <Text style={styles.label}>OpenAI-compatible backend</Text>
            <Text style={styles.hint}>
              Any /chat/completions server — OpenAI, OpenRouter (incl. Claude), Groq, Mistral, DeepSeek, a local
              LLM… Tap a preset or paste a base URL.
            </Text>
            <View style={styles.chips}>
              {OPENAI_PRESETS.map((p) => (
                <TouchableOpacity
                  key={p.id}
                  style={styles.chip}
                  onPress={() => {
                    setOpenaiBase(p.baseUrl);
                    if (!openaiModel) setOpenaiModel(p.sampleModel);
                  }}
                >
                  <Text style={styles.chipText}>{p.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <TextInput
              style={styles.input}
              value={openaiBase}
              onChangeText={setOpenaiBase}
              placeholder="base URL, e.g. https://api.openai.com/v1"
              placeholderTextColor={theme.textDim}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <TextInput
              style={[styles.input, { marginTop: 8 }]}
              value={openaiKey}
              onChangeText={setOpenaiKey}
              placeholder="API key"
              placeholderTextColor={theme.textDim}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
            />
            <TextInput
              style={[styles.input, { marginTop: 8 }]}
              value={openaiModel}
              onChangeText={setOpenaiModel}
              placeholder="model id, e.g. gpt-4o-mini"
              placeholderTextColor={theme.textDim}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>
        )}

        <Text style={styles.note}>Web search & page reading work out of the box — no extra keys needed.</Text>

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
  hint: { color: theme.textDim, fontSize: 12, marginTop: 3, marginBottom: 8, lineHeight: 17 },
  block: { marginTop: 18 },
  input: {
    color: theme.text,
    fontSize: 15,
    padding: 14,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 12,
  },
  segment: {
    flexDirection: "row",
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 12,
    padding: 4,
    gap: 4,
  },
  segItem: { flex: 1, paddingVertical: 10, borderRadius: 9, alignItems: "center" },
  segItemOn: { backgroundColor: theme.accent },
  segText: { color: theme.textDim, fontSize: 14, fontWeight: "700" },
  segTextOn: { color: theme.bg },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 10 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.surface,
  },
  chipText: { color: theme.text, fontSize: 12, fontWeight: "600" },
  link: { color: theme.accent, fontSize: 13, fontWeight: "600", marginTop: 8 },
  note: { color: theme.textDim, fontSize: 13, marginTop: 22, lineHeight: 19 },
  continueBtn: { backgroundColor: theme.accent, borderRadius: 12, paddingVertical: 16, alignItems: "center", marginTop: 34 },
  disabled: { opacity: 0.4 },
  continueText: { color: theme.bg, fontSize: 16, fontWeight: "700" },
});
