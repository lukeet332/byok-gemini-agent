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
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import Markdown from "react-native-markdown-display";
import { Ionicons } from "@expo/vector-icons";
import * as Speech from "expo-speech";
import * as ImagePicker from "expo-image-picker";
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from "expo-speech-recognition";

import { AbortedError, compactConversation, runAgentTurn } from "../agent/GeminiAgent";
import {
  COMPACT_THRESHOLD_CHARS,
  KEEP_RECENT_TURNS,
  historySize,
  loadThread,
  newThread,
  saveThread,
} from "../storage/ThreadStore";
import { ChatMessage, Content, Part, Thread } from "../types";
import { theme } from "../theme";

let seq = 0;
const nextId = () => `${Date.now()}-${++seq}`;

// Should a message sent mid-task INTERRUPT the running turn, or queue after it?
// Replicates "gauge priority" cheaply (no API call): clear redirect/cancel cues
// override now; everything else queues to run when the current turn finishes.
function isInterrupt(text: string): boolean {
  const t = text.trim().toLowerCase();
  return /^(stop|wait|hold on|no\b|nope|cancel|abort|actually|instead|forget|never ?mind|scratch that|hang on|hold up)/.test(
    t
  );
}

interface Queued {
  prompt: string;
  wasVoice: boolean;
  image?: { uri: string; data: string; mimeType: string };
}

// Pick the most natural en-GB voice available (Enhanced = neural, if the device
// has it installed via Google TTS). Falls back to any English voice.
function bestVoiceId(voices: Speech.Voice[]): string | undefined {
  const en = voices.filter((v) => (v.language || "").toLowerCase().startsWith("en"));
  const gb = en.filter((v) => (v.language || "").toLowerCase().startsWith("en-gb"));
  const pool = gb.length ? gb : en;
  const enhanced = pool.find((v) => v.quality === Speech.VoiceQuality.Enhanced);
  return (enhanced ?? pool[0])?.identifier;
}

// Derive a thread title locally (no API call) from the first user message.
function deriveTitle(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  const words = clean.split(" ").slice(0, 7).join(" ");
  const t = words.length > 48 ? words.slice(0, 48).trim() + "…" : words;
  return t.replace(/[.?!,;:]+$/, "") || "New chat";
}

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
    const img = (c.parts ?? []).find((p) => p.inlineData)?.inlineData;
    const imageUri = img ? `data:${img.mimeType};base64,${img.data}` : undefined;
    if (text || imageUri) out.push({ id: nextId(), role: c.role, text, imageUri });
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
  const [pendingImage, setPendingImage] = useState<{ uri: string; data: string; mimeType: string } | null>(null);
  const voiceIdRef = useRef<string | undefined>(undefined);
  // Streaming: targetRef holds the full text so far; `displayed` is the smoothly
  // revealed substring (animated char-by-char by a ticker).
  const [displayed, setDisplayed] = useState("");
  const targetRef = useRef("");
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const listRef = useRef<FlatList<ChatMessage>>(null);

  function ensureTicker() {
    if (tickRef.current) return;
    tickRef.current = setInterval(() => {
      setDisplayed((d) => {
        const t = targetRef.current;
        if (d.length >= t.length) return d; // caught up → no re-render
        const step = Math.max(2, Math.ceil((t.length - d.length) / 5));
        return t.slice(0, d.length + step);
      });
    }, 16);
  }
  function stopTicker() {
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
  }
  function resetStream() {
    stopTicker();
    targetRef.current = "";
    setDisplayed("");
  }
  useEffect(() => stopTicker, []);

  // Resolve the most natural TTS voice once (Enhanced en-GB if installed).
  useEffect(() => {
    Speech.getAvailableVoicesAsync()
      .then((vs) => {
        voiceIdRef.current = bestVoiceId(vs);
      })
      .catch(() => {});
  }, []);
  const abortRef = useRef<AbortController | null>(null);
  const bgAbortRef = useRef(false);
  const busyRef = useRef(false);
  // True when the pending message was dictated (so we read the reply aloud).
  const voiceInputRef = useRef(false);
  // Messages sent while a turn is running queue here; runningRef gates the single
  // runner; interruptRef marks an abort that should immediately run the queue.
  const queueRef = useRef<Queued[]>([]);
  const runningRef = useRef(false);
  const interruptRef = useRef(false);
  const [queuedCount, setQueuedCount] = useState(0);
  // Authoritative, synchronously-updated history (setThread lags across the
  // rapid abort -> drain chain, so queued turns build on this instead).
  const liveContentsRef = useRef<Content[]>([]);

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
      voice: voiceIdRef.current, // most natural installed voice, if any
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

  // Attach an image for the model to analyse (multimodal input).
  async function pickImage() {
    try {
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        base64: true,
        quality: 0.5,
      });
      if (res.canceled || !res.assets?.length || !res.assets[0].base64) return;
      const a = res.assets[0];
      setPendingImage({ uri: a.uri, data: a.base64 as string, mimeType: a.mimeType ?? "image/jpeg" });
    } catch {
      // ignore picker errors
    }
  }

  useEffect(() => {
    let active = true;
    (async () => {
      const loaded = (await loadThread(threadId)) ?? newThread(Date.now(), threadId);
      if (!active) return;
      setThread(loaded);
      liveContentsRef.current = loaded.contents;
      queueRef.current = [];
      setQueuedCount(0);
      setMessages(toMessages(loaded.contents));
    })();
    return () => {
      active = false;
    };
  }, [threadId]);

  function scrollToEnd() {
    requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
  }

  function pushMessage(
    role: ChatMessage["role"],
    text: string,
    action?: ChatMessage["action"],
    canRetry?: boolean,
    imageUri?: string
  ): string {
    const id = nextId();
    setMessages((prev) => [...prev, { id, role, text, action, canRetry, imageUri }]);
    scrollToEnd();
    return id;
  }

  function handleSendMessage(userPrompt: string) {
    const prompt = userPrompt.trim();
    const image = pendingImage;
    if ((!prompt && !image) || !thread) return;
    const wasVoice = voiceInputRef.current;
    voiceInputRef.current = false;
    setInput("");
    setPendingImage(null);
    pushMessage("user", prompt, undefined, false, image?.uri); // show it immediately

    queueRef.current.push({ prompt, wasVoice, image: image ?? undefined });
    setQueuedCount(queueRef.current.length);

    if (runningRef.current) {
      // A turn is in flight: interrupt now if it's a redirect, else let it queue.
      if (isInterrupt(prompt)) {
        interruptRef.current = true;
        abortRef.current?.abort();
      }
    } else {
      drainQueue();
    }
  }

  // Run the next queued message (single runner gated by runningRef).
  function drainQueue() {
    if (runningRef.current || !thread) return;
    const next = queueRef.current.shift();
    setQueuedCount(queueRef.current.length);
    if (!next) return;
    const base = liveContentsRef.current;
    const isFirst = base.length === 0;
    const parts: Part[] = [];
    if (next.prompt) parts.push({ text: next.prompt });
    if (next.image) parts.push({ inlineData: { mimeType: next.image.mimeType, data: next.image.data } });
    if (!parts.length) parts.push({ text: "" });
    const nextContents: Content[] = [...base, { role: "user", parts }];
    void runTurn(nextContents, next.wasVoice, isFirst ? next.prompt || "Image" : null);
  }

  // Re-run the last turn on the existing history (which already ends with the
  // user's message from the failed attempt) — no extra user bubble, no new request
  // until the user asks.
  async function retryLastTurn() {
    if (!thread || runningRef.current) return;
    setMessages((prev) => prev.filter((m) => !m.canRetry)); // drop the error notice
    await runTurn(liveContentsRef.current, false, null);
  }

  // Re-run the last user turn: drop the trailing model reply and regenerate.
  function regenerateLast() {
    if (runningRef.current || !thread) return;
    const contents = liveContentsRef.current;
    let i = contents.length - 1;
    while (i >= 0 && contents[i].role !== "user") i--;
    if (i < 0) return;
    const truncated = contents.slice(0, i + 1);
    liveContentsRef.current = truncated;
    setMessages((prev) => {
      let idx = prev.length - 1;
      while (idx >= 0 && prev[idx].role !== "user") idx--;
      return idx >= 0 ? prev.slice(0, idx + 1) : prev;
    });
    void runTurn(truncated, false, null);
  }

  async function runTurn(contents: Content[], wasVoice: boolean, titleFrom: string | null) {
    if (!thread) return;
    runningRef.current = true;
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    bgAbortRef.current = false;
    try {
      const result = await runAgentTurn(
        contents,
        {
          onStatus: (s) => {
            setStatus(s);
            if (s === "Thinking...") resetStream();
          },
          onToken: (full) => {
            targetRef.current = full;
            ensureTicker();
          },
          signal: controller.signal,
          confirmWrite,
        },
        thread.memo,
        { threadId: thread.id, threadTitle: thread.title }
      );

      let updated: Thread = { ...thread, contents: result.contents, updatedAt: Date.now() };
      if (historySize(updated.contents) > COMPACT_THRESHOLD_CHARS) {
        const split = safeSplit(updated.contents);
        if (split > 0) {
          setStatus("Compacting memory...");
          const memo = await compactConversation(updated.memo, updated.contents.slice(0, split));
          updated = { ...updated, memo, contents: updated.contents.slice(split) };
        }
      }
      if (titleFrom) updated.title = deriveTitle(titleFrom);

      liveContentsRef.current = updated.contents;
      setThread(updated);
      await saveThread(updated);
      onThreadChanged();
      resetStream();
      const replyId = pushMessage("model", result.reply);
      if (wasVoice) startSpeak(replyId, result.reply);
    } catch (err) {
      const aborted = err instanceof AbortedError || (err as Error)?.name === "AbortedError";
      if (interruptRef.current) {
        // Aborted to immediately run a redirect message — no "Stopped" notice.
        interruptRef.current = false;
      } else if (aborted) {
        pushMessage(
          "model",
          bgAbortRef.current
            ? "Stopped — Fraude was sent to the background. Keep the app open while a task runs."
            : "Stopped."
        );
      } else {
        // Surface the error with a manual retry (no auto-retry — saves quota).
        pushMessage("model", String(err instanceof Error ? err.message : err), undefined, true);
      }
      const updated = { ...thread, contents, updatedAt: Date.now() };
      liveContentsRef.current = contents;
      setThread(updated);
      await saveThread(updated);
      onThreadChanged();
    } finally {
      abortRef.current = null;
      runningRef.current = false;
      resetStream();
      setStatus(null);
      setBusy(false);
      drainQueue(); // run the next queued / interrupting message, if any
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
    if (item.canRetry) {
      return (
        <View style={[styles.bubble, styles.errorBubble, styles.alignLeft]}>
          <Text style={styles.errorText}>{item.text}</Text>
          <TouchableOpacity style={styles.retryRow} onPress={retryLastTurn} disabled={busy} hitSlop={8}>
            <Ionicons name="reload" size={16} color={theme.accent} />
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      );
    }
    const isUser = item.role === "user";
    if (isUser) {
      return (
        <View style={[styles.bubble, styles.userBubble, styles.alignRight]}>
          {item.imageUri ? <Image source={{ uri: item.imageUri }} style={styles.attachImage} resizeMode="cover" /> : null}
          {item.text ? <Text style={styles.userText}>{item.text}</Text> : null}
        </View>
      );
    }
    const isLast = item.id === messages[messages.length - 1]?.id;
    return (
      <View style={[styles.bubble, styles.modelBubble, styles.alignLeft]}>
        {item.imageUri ? <Image source={{ uri: item.imageUri }} style={styles.attachImage} resizeMode="cover" /> : null}
        <Markdown style={mdStyles} rules={mdRules}>
          {withInlineImages(item.text)}
        </Markdown>
        <View style={styles.bubbleActions}>
          <TouchableOpacity onPress={() => speak(item)} hitSlop={10}>
            <Ionicons
              name={speakingId === item.id ? "stop-circle" : "volume-high-outline"}
              size={20}
              color={speakingId === item.id ? theme.accent : theme.textDim}
            />
          </TouchableOpacity>
          {isLast ? (
            <TouchableOpacity onPress={regenerateLast} hitSlop={10} disabled={busy}>
              <Ionicons name="refresh" size={19} color={theme.textDim} />
            </TouchableOpacity>
          ) : null}
        </View>
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
        extraData={`${speakingId}|${busy}`}
        contentContainerStyle={styles.listContent}
        onContentSizeChange={scrollToEnd}
        ListFooterComponent={
          displayed !== "" ? (
            <View style={[styles.bubble, styles.modelBubble, styles.alignLeft]}>
              <Text style={styles.modelText}>{displayed}</Text>
            </View>
          ) : null
        }
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
            {queuedCount > 0 ? `  ·  ${queuedCount} queued` : ""}
          </Text>
          <TouchableOpacity onPress={() => abortRef.current?.abort()} hitSlop={8}>
            <Ionicons name="stop-circle" size={24} color={theme.danger} />
          </TouchableOpacity>
        </View>
      ) : null}

      {busy ? <Text style={styles.keepOpen}>Keep Fraude open — leaving cancels this task. Send more to queue them.</Text> : null}

      {pendingImage ? (
        <View style={styles.attachPreview}>
          <Image source={{ uri: pendingImage.uri }} style={styles.attachThumb} />
          <Text style={styles.attachLabel}>Image attached</Text>
          <TouchableOpacity onPress={() => setPendingImage(null)} hitSlop={8}>
            <Ionicons name="close-circle" size={22} color={theme.textDim} />
          </TouchableOpacity>
        </View>
      ) : null}

      <View style={styles.inputBar}>
        <TouchableOpacity style={[styles.iconBtn, styles.iconBtnGhost]} onPress={pickImage}>
          <Ionicons name="image-outline" size={22} color={theme.accent} />
        </TouchableOpacity>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={(t) => {
            setInput(t);
            voiceInputRef.current = false; // typed → don't auto-speak the reply
          }}
          placeholder={listening ? "Listening…" : busy ? "Queue another message…" : "Message"}
          placeholderTextColor={theme.textDim}
          multiline
        />
        <TouchableOpacity
          style={[styles.iconBtn, listening ? styles.micActive : styles.iconBtnGhost]}
          onPress={toggleMic}
          disabled={busy}
        >
          <Ionicons name={listening ? "stop" : "mic"} size={22} color={listening ? "#fff" : theme.accent} />
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.iconBtn, styles.sendBtn, !input.trim() && !pendingImage && styles.sendBtnDisabled]}
          onPress={() => handleSendMessage(input)}
          disabled={!input.trim() && !pendingImage}
        >
          <Ionicons name="arrow-up" size={22} color={theme.bg} />
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
  // Code blocks scroll horizontally so long lines don't overflow or wrap ugly.
  fence: (node: { key: string; content: string }) => (
    <ScrollView key={node.key} horizontal showsHorizontalScrollIndicator={false} style={styles.codeBlock} contentContainerStyle={styles.codeBlockInner}>
      <Text style={styles.codeText}>{node.content}</Text>
    </ScrollView>
  ),
  code_block: (node: { key: string; content: string }) => (
    <ScrollView key={node.key} horizontal showsHorizontalScrollIndicator={false} style={styles.codeBlock} contentContainerStyle={styles.codeBlockInner}>
      <Text style={styles.codeText}>{node.content}</Text>
    </ScrollView>
  ),
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.bg },
  center: { alignItems: "center", justifyContent: "center" },
  listContent: { padding: 14, paddingBottom: 8, flexGrow: 1 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  emptyTitle: { color: theme.text, fontSize: 20, fontWeight: "700", marginBottom: 8, textAlign: "center" },
  emptyHint: { color: theme.textDim, fontSize: 14, textAlign: "center", lineHeight: 20 },
  bubble: { maxWidth: "86%", borderRadius: 16, paddingHorizontal: 14, paddingVertical: 8, marginVertical: 5, overflow: "hidden" },
  codeBlock: { backgroundColor: theme.surfaceAlt, borderRadius: 8, marginVertical: 6, maxWidth: "100%" },
  codeBlockInner: { padding: 10 },
  codeText: { color: theme.text, fontSize: 13, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
  alignRight: { alignSelf: "flex-end", borderBottomRightRadius: 4 },
  alignLeft: { alignSelf: "flex-start", borderBottomLeftRadius: 4 },
  userBubble: { backgroundColor: theme.userBubble, paddingVertical: 10 },
  modelBubble: { backgroundColor: theme.modelBubble, borderWidth: 1, borderColor: theme.border },
  userText: { color: theme.userBubbleText, fontSize: 15, lineHeight: 21 },
  modelText: { color: theme.text, fontSize: 15, lineHeight: 21 },
  attachImage: { width: 200, height: 200, borderRadius: 10, marginBottom: 6 },
  bubbleActions: { flexDirection: "row", gap: 16, alignSelf: "flex-end", marginTop: 6, alignItems: "center" },
  attachPreview: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingBottom: 6 },
  attachThumb: { width: 40, height: 40, borderRadius: 6 },
  attachLabel: { color: theme.textDim, fontSize: 13, flex: 1 },
  errorBubble: { backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.danger },
  errorText: { color: theme.text, fontSize: 14, lineHeight: 20 },
  retryRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 10, alignSelf: "flex-start" },
  retryText: { color: theme.accent, fontWeight: "700", fontSize: 13 },
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
  speakBtn: { alignSelf: "flex-end", marginTop: 6 },
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
  // list_item is a row [marker][content]; the content MUST flex or each
  // character wraps to its own line and the bubble collapses.
  list_item: { flexDirection: "row", justifyContent: "flex-start", marginVertical: 2 },
  bullet_list_icon: { color: theme.accent, marginRight: 6 },
  ordered_list_icon: { color: theme.accent, marginRight: 6 },
  bullet_list_content: { flex: 1, color: theme.text },
  ordered_list_content: { flex: 1, color: theme.text },
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
