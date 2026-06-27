// Chat: renders one persisted thread. It owns the wire-format `contents` history
// plus the dense `memo` (compacted older context), loads/saves them via
// ThreadStore, and folds old turns into the memo when the history grows large.
// Model replies render as markdown with inline images.

import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  KeyboardAvoidingView,
  ListRenderItemInfo,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import Markdown from "react-native-markdown-display";

import { compactConversation, runAgentTurn, suggestTitle } from "../agent/GeminiAgent";
import {
  COMPACT_THRESHOLD_CHARS,
  KEEP_RECENT_TURNS,
  historySize,
  loadThread,
  newThread,
  saveThread,
} from "../storage/ThreadStore";
import { ChatMessage, Content, Thread } from "../types";
import { theme } from "../theme";

let seq = 0;
const nextId = () => `${Date.now()}-${++seq}`;

// Does a turn carry user-visible text (vs. a pure tool call/result)?
function turnText(c: Content): string {
  return (c.parts ?? [])
    .map((p) => p.text)
    .filter((t): t is string => typeof t === "string")
    .join("")
    .trim();
}

// Build the visible bubble list from the structured history (skips tool turns).
function toMessages(contents: Content[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const c of contents) {
    const text = turnText(c);
    if (text) out.push({ id: nextId(), role: c.role, text });
  }
  return out;
}

// Wrap bare image URLs in markdown image syntax so they render as images.
function withInlineImages(text: string): string {
  return text.replace(
    /(^|[\s])(https?:\/\/[^\s)]+\.(?:png|jpe?g|gif|webp)(?:\?[^\s)]*)?)/gi,
    (_m, pre, url) => `${pre}\n![](${url})\n`
  );
}

// Keep the last KEEP_RECENT_TURNS user messages verbatim; everything before the
// start of that window is eligible to be folded into the memo. Splitting on a
// user-message boundary keeps tool call/response pairs intact for the API.
function safeSplit(contents: Content[]): number {
  const userIdxs = contents
    .map((c, i) => ({ i, isUser: c.role === "user" && !!turnText(c) }))
    .filter((x) => x.isUser)
    .map((x) => x.i);
  if (userIdxs.length <= KEEP_RECENT_TURNS) return 0;
  return userIdxs[userIdxs.length - KEEP_RECENT_TURNS];
}

interface Props {
  threadId: string;
  onThreadChanged: () => void; // tell the list to refresh (title/updatedAt)
}

export default function ChatScreen({ threadId, onThreadChanged }: Props) {
  const [thread, setThread] = useState<Thread | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const listRef = useRef<FlatList<ChatMessage>>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      const loaded = (await loadThread(threadId)) ?? newThread(Date.now(), threadId);
      if (!active) return;
      setThread(loaded);
      setMessages(toMessages(loaded.contents));
    })();
    return () => {
      active = false;
    };
  }, [threadId]);

  function scrollToEnd() {
    requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
  }

  function pushMessage(role: ChatMessage["role"], text: string) {
    setMessages((prev) => [...prev, { id: nextId(), role, text }]);
    scrollToEnd();
  }

  async function handleSendMessage(userPrompt: string) {
    const prompt = userPrompt.trim();
    if (!prompt || busy || !thread) return;

    setInput("");
    setBusy(true);
    pushMessage("user", prompt);

    const isFirst = thread.contents.length === 0;
    const nextContents: Content[] = [...thread.contents, { role: "user", parts: [{ text: prompt }] }];

    try {
      const result = await runAgentTurn(nextContents, { onStatus: setStatus }, thread.memo, {
        threadId: thread.id,
        threadTitle: thread.title,
      });

      let updated: Thread = {
        ...thread,
        contents: result.contents,
        updatedAt: Date.now(),
      };

      // Compact older turns into the dense memo if the history is getting big.
      if (historySize(updated.contents) > COMPACT_THRESHOLD_CHARS) {
        const split = safeSplit(updated.contents);
        if (split > 0) {
          setStatus("Compacting memory...");
          const memo = await compactConversation(updated.memo, updated.contents.slice(0, split));
          updated = { ...updated, memo, contents: updated.contents.slice(split) };
        }
      }

      // Auto-title a brand-new thread from its first message.
      if (isFirst) {
        updated.title = await suggestTitle(prompt);
      }

      setThread(updated);
      await saveThread(updated);
      onThreadChanged();
      pushMessage("model", result.reply);
    } catch (err) {
      pushMessage("model", `Error: ${String(err instanceof Error ? err.message : err)}`);
      const updated = { ...thread, contents: nextContents, updatedAt: Date.now() };
      setThread(updated);
      await saveThread(updated);
      onThreadChanged();
    } finally {
      setStatus(null);
      setBusy(false);
    }
  }

  function renderItem({ item }: ListRenderItemInfo<ChatMessage>) {
    const isUser = item.role === "user";
    if (isUser) {
      return (
        <View style={[styles.bubble, styles.userBubble, styles.alignRight]}>
          <Text style={styles.userText}>{item.text}</Text>
        </View>
      );
    }
    return (
      <View style={[styles.bubble, styles.modelBubble, styles.alignLeft]}>
        <Markdown style={mdStyles} rules={mdRules}>
          {withInlineImages(item.text)}
        </Markdown>
      </View>
    );
  }

  if (!thread) {
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
      keyboardVerticalOffset={Platform.OS === "ios" ? 8 : 0}
    >
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(m) => m.id}
        renderItem={renderItem}
        contentContainerStyle={styles.listContent}
        onContentSizeChange={scrollToEnd}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>{thread.title}</Text>
            <Text style={styles.emptyHint}>
              Ask anything. I can read web pages and call any API using your saved keys.
            </Text>
          </View>
        }
      />

      {status ? (
        <View style={styles.statusRow}>
          <ActivityIndicator size="small" color={theme.accent} />
          <Text style={styles.statusText} numberOfLines={1}>
            {status}
          </Text>
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

// Inline images inside model markdown.
const mdRules = {
  image: (node: { key: string; attributes: { src?: string } }) => (
    <Image
      key={node.key}
      source={{ uri: node.attributes.src }}
      style={styles.mdImage}
      resizeMode="contain"
    />
  ),
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.bg },
  center: { alignItems: "center", justifyContent: "center" },
  listContent: { padding: 14, paddingBottom: 8, flexGrow: 1 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  emptyTitle: { color: theme.text, fontSize: 20, fontWeight: "700", marginBottom: 8, textAlign: "center" },
  emptyHint: { color: theme.textDim, fontSize: 14, textAlign: "center", lineHeight: 20 },
  bubble: { maxWidth: "86%", borderRadius: 16, paddingHorizontal: 14, paddingVertical: 8, marginVertical: 5 },
  alignRight: { alignSelf: "flex-end", borderBottomRightRadius: 4 },
  alignLeft: { alignSelf: "flex-start", borderBottomLeftRadius: 4 },
  userBubble: { backgroundColor: theme.userBubble, paddingVertical: 10 },
  modelBubble: { backgroundColor: theme.modelBubble, borderWidth: 1, borderColor: theme.border },
  userText: { color: "#ffffff", fontSize: 15, lineHeight: 21 },
  mdImage: { width: "100%", height: 220, marginVertical: 8, borderRadius: 10 },
  statusRow: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 6, gap: 8 },
  statusText: { color: theme.textDim, fontSize: 13, fontStyle: "italic", flex: 1 },
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
  sendBtn: { backgroundColor: theme.accent, borderRadius: 20, paddingHorizontal: 18, paddingVertical: 12, justifyContent: "center" },
  sendBtnDisabled: { opacity: 0.45 },
  sendText: { color: theme.bg, fontWeight: "700", fontSize: 15 },
});

// Dark-theme markdown styling for model replies.
const mdStyles = StyleSheet.create({
  body: { color: theme.text, fontSize: 15, lineHeight: 21 },
  heading1: { color: theme.text, fontSize: 20, fontWeight: "700", marginTop: 4, marginBottom: 4 },
  heading2: { color: theme.text, fontSize: 18, fontWeight: "700", marginTop: 4, marginBottom: 4 },
  heading3: { color: theme.text, fontSize: 16, fontWeight: "700" },
  strong: { fontWeight: "700", color: theme.text },
  em: { fontStyle: "italic" },
  link: { color: theme.accent, textDecorationLine: "underline" },
  bullet_list: { marginVertical: 4 },
  ordered_list: { marginVertical: 4 },
  list_item: { color: theme.text },
  code_inline: {
    color: theme.accent,
    backgroundColor: theme.surfaceAlt,
    borderRadius: 4,
    paddingHorizontal: 4,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  },
  code_block: {
    color: theme.text,
    backgroundColor: theme.surfaceAlt,
    borderRadius: 8,
    padding: 10,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  },
  fence: {
    color: theme.text,
    backgroundColor: theme.surfaceAlt,
    borderRadius: 8,
    padding: 10,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  },
  blockquote: { backgroundColor: theme.surfaceAlt, borderLeftColor: theme.accent, borderLeftWidth: 3, paddingHorizontal: 10 },
});
