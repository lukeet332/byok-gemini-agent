// Chat: renders one persisted thread. It owns the wire-format `contents` history
// plus the dense `memo` (compacted older context), loads/saves them via
// ThreadStore, and folds old turns into the memo when the history grows large.
// Model replies render as markdown with inline images.

import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  BackHandler,
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
import { Ionicons } from "@expo/vector-icons";
import * as Speech from "expo-speech";
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from "expo-speech-recognition";

import { AbortedError, compactConversation, runAgentTurn, suggestTitle } from "../agent/GeminiAgent";
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

// Strip markdown/URLs so text-to-speech reads cleanly.
function plainText(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[*_`#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
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
  onOpenSettings: () => void; // navigate to Settings (for tappable notices)
}

export default function ChatScreen({ threadId, onThreadChanged, onOpenSettings }: Props) {
  const [thread, setThread] = useState<Thread | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const listRef = useRef<FlatList<ChatMessage>>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bgAbortRef = useRef(false);
  const busyRef = useRef(false);
  // True when the pending message was dictated (so we read the reply aloud).
  const voiceInputRef = useRef(false);

  // Keep a ref in sync so AppState/back handlers see the latest busy state.
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  // If the app is backgrounded mid-task, the JS engine pauses and the turn can't
  // continue — abort cleanly and tell the user, rather than hanging forever.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active" && busyRef.current && abortRef.current) {
        bgAbortRef.current = true;
        abortRef.current.abort();
      }
    });
    return () => sub.remove();
  }, []);

  // Warn on hardware back while a task is running.
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (!busyRef.current) return false;
      Alert.alert("Task running", "Leaving will cancel the running task. Leave anyway?", [
        { text: "Stay", style: "cancel" },
        { text: "Leave & cancel", style: "destructive", onPress: () => abortRef.current?.abort() },
      ]);
      return true; // block the default back action
    });
    return () => sub.remove();
  }, []);

  function confirmWrite({ method, url }: { method: string; url: string }): Promise<boolean> {
    const body =
      method === "INTENT"
        ? `The assistant wants to hand off to another app:\n\n${url}\n\nAllow it?`
        : method === "FILE"
          ? `The assistant wants to write to a file:\n\n${url}\n\nAllow it?`
          : `The assistant wants to send a ${method} request to:\n\n${url}\n\nThis can change data. Allow it?`;
    return new Promise((resolve) => {
      Alert.alert("Confirm action", body, [
        { text: "Decline", style: "cancel", onPress: () => resolve(false) },
        { text: "Allow", onPress: () => resolve(true) },
      ], { cancelable: false });
    });
  }

  // Speech-to-text: stream the transcript into the input box.
  useSpeechRecognitionEvent("result", (e) => {
    const t = e.results?.[0]?.transcript;
    if (typeof t === "string") {
      setInput(t);
      voiceInputRef.current = true; // dictated → reply will be spoken
    }
  });
  useSpeechRecognitionEvent("end", () => setListening(false));
  useSpeechRecognitionEvent("error", () => setListening(false));

  async function toggleMic() {
    if (listening) {
      ExpoSpeechRecognitionModule.stop();
      setListening(false);
      return;
    }
    const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!perm.granted) return;
    setInput("");
    setListening(true);
    ExpoSpeechRecognitionModule.start({ lang: "en-GB", interimResults: true });
  }

  // Text-to-speech: read a reply aloud (British English by default).
  function startSpeak(id: string, text: string) {
    Speech.stop();
    setSpeakingId(id);
    Speech.speak(plainText(text), {
      language: "en-GB",
      onDone: () => setSpeakingId(null),
      onStopped: () => setSpeakingId(null),
      onError: () => setSpeakingId(null),
    });
  }
  function speak(msg: ChatMessage) {
    if (speakingId === msg.id) {
      Speech.stop();
      setSpeakingId(null);
      return;
    }
    startSpeak(msg.id, msg.text);
  }

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

  function pushMessage(role: ChatMessage["role"], text: string, action?: ChatMessage["action"]): string {
    const id = nextId();
    setMessages((prev) => [...prev, { id, role, text, action }]);
    scrollToEnd();
    return id;
  }

  async function handleSendMessage(userPrompt: string) {
    const prompt = userPrompt.trim();
    if (!prompt || busy || !thread) return;

    const wasVoice = voiceInputRef.current;
    voiceInputRef.current = false;
    setInput("");
    setBusy(true);
    pushMessage("user", prompt);

    const isFirst = thread.contents.length === 0;
    const nextContents: Content[] = [...thread.contents, { role: "user", parts: [{ text: prompt }] }];

    const controller = new AbortController();
    abortRef.current = controller;
    bgAbortRef.current = false;

    try {
      const result = await runAgentTurn(
        nextContents,
        { onStatus: setStatus, signal: controller.signal, confirmWrite },
        thread.memo,
        { threadId: thread.id, threadTitle: thread.title }
      );

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
      const replyId = pushMessage("model", result.reply);
      if (wasVoice) startSpeak(replyId, result.reply); // spoke the question → speak the answer
    } catch (err) {
      const aborted = err instanceof AbortedError || (err as Error)?.name === "AbortedError";
      if (aborted) {
        pushMessage(
          "model",
          bgAbortRef.current
            ? "Stopped — Fraude was sent to the background. Keep the app open while a task runs."
            : "Stopped."
        );
      } else {
        pushMessage("model", `Error: ${String(err instanceof Error ? err.message : err)}`);
      }
      // Persist the user turn so a retry keeps context.
      const updated = { ...thread, contents: nextContents, updatedAt: Date.now() };
      setThread(updated);
      await saveThread(updated);
      onThreadChanged();
    } finally {
      abortRef.current = null;
      setStatus(null);
      setBusy(false);
    }
  }

  function renderItem({ item }: ListRenderItemInfo<ChatMessage>) {
    if (item.action === "open_settings") {
      return (
        <TouchableOpacity style={styles.notice} onPress={onOpenSettings}>
          <Text style={styles.noticeText}>{item.text}</Text>
        </TouchableOpacity>
      );
    }
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
        <TouchableOpacity onPress={() => speak(item)} style={styles.speakBtn} hitSlop={10}>
          <Ionicons
            name={speakingId === item.id ? "stop-circle" : "volume-high-outline"}
            size={20}
            color={speakingId === item.id ? theme.accent : theme.textDim}
          />
        </TouchableOpacity>
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
        extraData={speakingId}
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

      {busy ? <Text style={styles.keepOpen}>Keep Fraude open — leaving cancels this task.</Text> : null}

      <View style={styles.inputBar}>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={(t) => {
            setInput(t);
            voiceInputRef.current = false; // typed → don't auto-speak the reply
          }}
          placeholder={listening ? "Listening…" : "Message"}
          placeholderTextColor={theme.textDim}
          multiline
          editable={!busy}
        />
        <TouchableOpacity
          style={[styles.iconBtn, listening ? styles.micActive : styles.iconBtnGhost]}
          onPress={toggleMic}
          disabled={busy}
        >
          <Ionicons name={listening ? "stop" : "mic"} size={22} color={listening ? "#fff" : theme.accent} />
        </TouchableOpacity>
        {busy ? (
          <TouchableOpacity style={[styles.iconBtn, styles.stopBtn]} onPress={() => abortRef.current?.abort()}>
            <Ionicons name="square" size={18} color="#fff" />
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={[styles.iconBtn, styles.sendBtn, !input.trim() && styles.sendBtnDisabled]}
            onPress={() => handleSendMessage(input)}
            disabled={!input.trim()}
          >
            <Ionicons name="arrow-up" size={22} color={theme.bg} />
          </TouchableOpacity>
        )}
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
  notice: {
    alignSelf: "center",
    maxWidth: "92%",
    backgroundColor: theme.surfaceAlt,
    borderWidth: 1,
    borderColor: theme.accent,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginVertical: 6,
  },
  noticeText: { color: theme.accent, fontSize: 13, textAlign: "center", lineHeight: 19 },
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
  iconBtn: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" },
  iconBtnGhost: { backgroundColor: theme.surfaceAlt, borderWidth: 1, borderColor: theme.border },
  sendBtn: { backgroundColor: theme.accent },
  sendBtnDisabled: { opacity: 0.45 },
  stopBtn: { backgroundColor: theme.danger },
  micActive: { backgroundColor: theme.danger },
  keepOpen: { color: theme.textDim, fontSize: 11, textAlign: "center", paddingHorizontal: 16, paddingBottom: 4 },
  speakBtn: { alignSelf: "flex-start", marginTop: 6 },
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
