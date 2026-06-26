// Chat: the messaging UI plus the place that owns the conversation `contents`
// array. Sending a message delegates the whole multi-turn tool loop to
// runAgentTurn and renders the result.

import React, { useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  ListRenderItemInfo,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

import { runAgentTurn } from "../agent/GeminiAgent";
import { ChatMessage, Content } from "../types";
import { theme } from "../theme";

let messageSeq = 0;
function nextId(): string {
  messageSeq += 1;
  return `${Date.now()}-${messageSeq}`;
}

export default function ChatScreen() {
  // UI-facing list of bubbles.
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // The full wire-format history sent to Gemini (text + tool turns).
  const [contents, setContents] = useState<Content[]>([]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const listRef = useRef<FlatList<ChatMessage>>(null);

  function pushMessage(role: ChatMessage["role"], text: string) {
    setMessages((prev) => [...prev, { id: nextId(), role, text }]);
    // Defer scroll until after the new row is laid out.
    requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
  }

  async function handleSendMessage(userPrompt: string) {
    const prompt = userPrompt.trim();
    if (!prompt || busy) return;

    setInput("");
    setBusy(true);
    pushMessage("user", prompt);

    // Append the user's text to the wire history.
    const nextContents: Content[] = [
      ...contents,
      { role: "user", parts: [{ text: prompt }] },
    ];

    try {
      const result = await runAgentTurn(nextContents, { onStatus: setStatus });
      setContents(result.contents);
      pushMessage("model", result.reply);
    } catch (err) {
      pushMessage("model", `Error: ${String(err instanceof Error ? err.message : err)}`);
      // Keep the user turn in history so a retry has context.
      setContents(nextContents);
    } finally {
      setStatus(null);
      setBusy(false);
    }
  }

  function renderItem({ item }: ListRenderItemInfo<ChatMessage>) {
    const isUser = item.role === "user";
    return (
      <View
        style={[
          styles.bubble,
          isUser ? styles.userBubble : styles.modelBubble,
          isUser ? styles.alignRight : styles.alignLeft,
        ]}
      >
        <Text style={isUser ? styles.userText : styles.modelText}>{item.text}</Text>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={Platform.OS === "ios" ? 8 : 0}
    >
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(m) => m.id}
        renderItem={renderItem}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>BYOK Gemini Agent</Text>
            <Text style={styles.emptyHint}>
              Ask anything. Try: "Add a task to buy milk to my Notion."
            </Text>
          </View>
        }
      />

      {status ? (
        <View style={styles.statusRow}>
          <ActivityIndicator size="small" color={theme.accent} />
          <Text style={styles.statusText}>{status}</Text>
        </View>
      ) : null}

      <View style={styles.inputBar}>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder="Message"
          placeholderTextColor={theme.textDim}
          multiline
          onSubmitEditing={() => handleSendMessage(input)}
          editable={!busy}
        />
        <TouchableOpacity
          style={[styles.sendBtn, (busy || !input.trim()) && styles.sendBtnDisabled]}
          onPress={() => handleSendMessage(input)}
          disabled={busy || !input.trim()}
        >
          <Text style={styles.sendText}>Send</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.bg },
  listContent: { padding: 14, paddingBottom: 8, flexGrow: 1 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  emptyTitle: { color: theme.text, fontSize: 20, fontWeight: "700", marginBottom: 8 },
  emptyHint: { color: theme.textDim, fontSize: 14, textAlign: "center" },
  bubble: {
    maxWidth: "82%",
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginVertical: 5,
  },
  alignRight: { alignSelf: "flex-end", borderBottomRightRadius: 4 },
  alignLeft: { alignSelf: "flex-start", borderBottomLeftRadius: 4 },
  userBubble: { backgroundColor: theme.userBubble },
  modelBubble: {
    backgroundColor: theme.modelBubble,
    borderWidth: 1,
    borderColor: theme.border,
  },
  userText: { color: "#ffffff", fontSize: 15, lineHeight: 21 },
  modelText: { color: theme.text, fontSize: 15, lineHeight: 21 },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 6,
    gap: 8,
  },
  statusText: { color: theme.textDim, fontSize: 13, fontStyle: "italic" },
  inputBar: {
    flexDirection: "row",
    alignItems: "flex-end",
    padding: 10,
    gap: 8,
    borderTopWidth: 1,
    borderTopColor: theme.border,
    backgroundColor: theme.surface,
  },
  input: {
    flex: 1,
    color: theme.text,
    fontSize: 15,
    maxHeight: 120,
    backgroundColor: theme.surfaceAlt,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: Platform.OS === "ios" ? 10 : 6,
  },
  sendBtn: {
    backgroundColor: theme.accent,
    borderRadius: 20,
    paddingHorizontal: 18,
    paddingVertical: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  sendBtnDisabled: { opacity: 0.45 },
  sendText: { color: theme.bg, fontWeight: "700", fontSize: 15 },
});
