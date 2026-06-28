// Chat: renders one persisted thread. It owns the wire-format `contents` history
// plus the dense `memo` (compacted older context), loads/saves them via
// ThreadStore, and folds old turns into the memo when the history grows large.
// Model replies render as markdown with inline images.

import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  AppState,
  BackHandler,
  FlatList,
  Image,
  KeyboardAvoidingView,
  ListRenderItemInfo,
  Modal,
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

import { AbortedError, compactConversation, runAgentTurn, stripLeadingTitle } from "../agent/GeminiAgent";
import { notifyTurnDone } from "../agent/Background";
import { getBackgroundRun, getConfirmSystemActions, getProMode } from "../storage/SecureStorage";
import McpServersModal from "./McpServersModal";
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

// Pick the most natural en-GB voice (Enhanced = neural). We deliberately do NOT
// fall back to other English locales — pinning a US voice is what made it sound
// American. If no en-GB voice is installed, return undefined and just request the
// "en-GB" language so the engine uses its own British default.
function bestVoiceId(voices: Speech.Voice[]): string | undefined {
  const norm = (l: string | undefined) => (l || "").toLowerCase().replace(/_/g, "-");
  const gb = voices.filter((v) => norm(v.language).startsWith("en-gb"));
  if (!gb.length) return undefined;
  const enhanced = gb.find((v) => v.quality === Speech.VoiceQuality.Enhanced);
  return (enhanced ?? gb[0]).identifier;
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

// Defensively strip a leading "TITLE: …" line (older threads saved before the
// title line was stripped from history).
function dropTitleLine(text: string): string {
  return text.replace(/^\s*TITLE:.*(?:\r?\n)+/i, "");
}

// Build the visible bubble list from the structured history (skips tool turns).
function toMessages(contents: Content[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const c of contents) {
    const text = c.role === "model" ? dropTitleLine(turnText(c)) : turnText(c);
    const img = (c.parts ?? []).find((p) => p.inlineData)?.inlineData;
    const imageUri = img ? `data:${img.mimeType};base64,${img.data}` : undefined;
    if (text || imageUri) out.push({ id: nextId(), role: c.role, text, imageUri });
  }
  return out;
}

// Strip markdown/URLs so text-to-speech reads cleanly.
function plainText(text: string): string {
  return text
    .replace(/^\s*TITLE:.*(?:\r?\n)+/i, "") // never read the title line aloud
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

// A live waveform that wiggles inside the "stop listening" button. Five bars run
// continuous staggered loops so it's always alive; `level` (0..1 mic loudness)
// scales their amplitude so they jump when you actually speak.
function VoiceWave({ level, color }: { level: number; color: string }) {
  const bars = useRef([0, 1, 2, 3, 4].map(() => new Animated.Value(0.3))).current;
  useEffect(() => {
    const loops = bars.map((v, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.timing(v, { toValue: 1, duration: 320 + i * 70, delay: i * 60, useNativeDriver: false }),
          Animated.timing(v, { toValue: 0.25, duration: 320 + i * 70, useNativeDriver: false }),
        ])
      )
    );
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [bars]);
  const amp = 0.4 + Math.min(1, Math.max(0, level)) * 0.6; // floor so it's never flat
  return (
    <View style={styles.wave}>
      {bars.map((v, i) => (
        <Animated.View
          key={i}
          style={[
            styles.waveBar,
            {
              backgroundColor: color,
              transform: [{ scaleY: Animated.multiply(v, amp) }],
            },
          ]}
        />
      ))}
    </View>
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

type ApprovalMode = "auto" | "batched" | "granular";

interface Props {
  threadId: string;
  onThreadChanged: () => void; // tell the list to refresh (title/updatedAt)
  onOpenSettings: () => void; // navigate to Settings (for tappable notices)
  initialText?: string; // text shared into the app, to pre-fill the composer
  onShareConsumed?: () => void;
  initialSend?: string; // a routine prompt to auto-send once the thread loads
  onSendConsumed?: () => void;
}

export default function ChatScreen({
  threadId,
  onThreadChanged,
  onOpenSettings,
  initialText,
  onShareConsumed,
  initialSend,
  onSendConsumed,
}: Props) {
  const [thread, setThread] = useState<Thread | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [micLevel, setMicLevel] = useState(0); // 0..1 live input loudness
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [pendingImage, setPendingImage] = useState<{ uri: string; data: string; mimeType: string } | null>(null);
  // Approval mode (session-only; resets to a confirming mode each launch):
  //  auto     — run everything without asking
  //  batched  — approve the whole batch of actions in ONE prompt (default)
  //  granular — tick/untick each action; nothing runs until you Apply
  const [approvalMode, setApprovalModeState] = useState<ApprovalMode>("batched");
  const [autoMenu, setAutoMenu] = useState(false);
  const [mcpVisible, setMcpVisible] = useState(false);
  // Themed in-app confirmation (replaces the native Alert). Holds the actions
  // needing a decision; `total` is the full batch size so the result array lines
  // up. `resolve` is the pending promise's resolver from confirmWrite.
  const [confirmReq, setConfirmReq] = useState<{
    items: { idx: number; label: string; body: string }[];
    total: number;
    granular: boolean;
    danger: boolean;
  } | null>(null);
  const [confirmChecks, setConfirmChecks] = useState<Record<number, boolean>>({});
  const [confirmNote, setConfirmNote] = useState(""); // "Other" redirect text
  const [noteOpen, setNoteOpen] = useState(false);
  const confirmResolveRef = useRef<((r: { decisions: boolean[]; feedback?: string }) => void) | null>(null);
  const approvalRef = useRef<ApprovalMode>("batched");
  const voiceIdRef = useRef<string | undefined>(undefined);

  function setApprovalMode(m: ApprovalMode) {
    approvalRef.current = m;
    setApprovalModeState(m);
    setAutoMenu(false);
  }
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
  // Background execution: when enabled, let the turn keep running when the app
  // is backgrounded (instead of aborting it) and notify on completion.
  const backgroundRunRef = useRef(true);
  // Always confirm Shizuku/root commands, even in Auto mode (safety rail).
  const confirmSystemRef = useRef(true);
  // Pro mode keeps more conversation verbatim (less-lossy compaction).
  const proModeRef = useRef(false);
  // Last turn left a user message unanswered (interrupted) → offer to continue.
  const [needsResume, setNeedsResume] = useState(false);
  // True when the pending message was dictated (so we read the reply aloud).
  const voiceInputRef = useRef(false);
  const lastTranscriptRef = useRef(""); // newest dictation transcript (for auto-send)
  const retriedLocaleRef = useRef(false); // fell back to en-US after en-GB pack missing?
  const handleSendRef = useRef<(t: string) => void>(() => {}); // latest sender, for event handlers
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

  // Load the background-run preference (kept in a ref for the AppState handler).
  useEffect(() => {
    getBackgroundRun().then((v) => {
      backgroundRunRef.current = v;
    });
    getConfirmSystemActions().then((v) => {
      confirmSystemRef.current = v;
    });
    getProMode().then((v) => {
      proModeRef.current = v;
    });
  }, []);

  // App backgrounded mid-task: if background-run is ON, let the turn keep
  // running (the OS grants a grace period; we notify on completion). If it's
  // OFF, abort cleanly so the turn doesn't hang.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active" && busyRef.current && !backgroundRunRef.current && abortRef.current) {
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

  // Decide a batch of pending actions, returning one boolean per request.
  //  auto     — approve everything (except Shizuku/root shell, which always asks)
  //  batched  — one prompt; Allow/Decline applies to the whole batch
  //  granular — one prompt; tick each action, nothing runs until Apply
  function confirmWrite(reqs: { method: string; url: string }[]): Promise<{ decisions: boolean[]; feedback?: string }> {
    if (!reqs.length) return Promise.resolve({ decisions: [] });
    const labels: Record<string, string> = {
      INTENT: "Open another app",
      OPEN: "Open a link",
      FILE: "Write a file",
      COMMIT: "Commit to GitHub",
      SETTING: "Change a setting",
      SHELL: "Run a shell command",
      UI: "Automate your screen",
    };
    const isSystem = (r: { method: string; url: string }) => r.method === "SHELL" && /^\[(shizuku|root)\]/.test(r.url);
    const mode = approvalRef.current;
    // Which requests actually need a human decision in this mode.
    const gated = reqs
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => (isSystem(r) && confirmSystemRef.current) || mode !== "auto");
    if (!gated.length) return Promise.resolve({ decisions: reqs.map(() => true) }); // pure Auto
    const items = gated.map(({ r, i }) => ({ idx: i, label: labels[r.method] ?? `${r.method} request`, body: r.url }));
    const danger = gated.some(({ r }) => r.method === "SHELL" || r.method === "HTTP" || isSystem(r));
    setConfirmChecks(Object.fromEntries(items.map((it) => [it.idx, true])));
    setConfirmNote("");
    setNoteOpen(false);
    return new Promise((resolve) => {
      confirmResolveRef.current = resolve;
      setConfirmReq({ items, total: reqs.length, granular: mode === "granular", danger });
    });
  }

  // Resolve the themed confirm. allow=true → approve all gated; false → decline
  // all; null → use the per-item ticks (granular). With `feedback`, every gated
  // action is declined and the note is sent back so the model can re-plan.
  // Auto-approved items always stay true.
  function answerConfirm(allow: boolean | null, feedback?: string) {
    const req = confirmReq;
    const resolve = confirmResolveRef.current;
    confirmResolveRef.current = null;
    setConfirmReq(null);
    if (!req || !resolve) return;
    const note = feedback?.trim() || undefined;
    const decisions = new Array<boolean>(req.total).fill(true);
    for (const it of req.items) {
      decisions[it.idx] = note ? false : allow === null ? !!confirmChecks[it.idx] : allow;
    }
    resolve({ decisions, feedback: note });
  }

  // Speech-to-text: stream the transcript into the input box.
  useSpeechRecognitionEvent("result", (e) => {
    const t = e.results?.[0]?.transcript;
    if (typeof t === "string") {
      setInput(t);
      lastTranscriptRef.current = t;
      voiceInputRef.current = true; // dictated → reply will be spoken
    }
  });
  // Live mic feedback: volumechange gives a loudness value (~ -2..10); normalise
  // to 0..1 to drive the on-screen level meter so the user can see it's hearing.
  useSpeechRecognitionEvent("volumechange", (e) => {
    const v = typeof e.value === "number" ? e.value : 0;
    setMicLevel(Math.max(0, Math.min(1, (v + 2) / 12)));
  });
  // Finished talking (after the silence grace period) → auto-send the dictation.
  useSpeechRecognitionEvent("end", () => {
    setListening(false);
    setMicLevel(0);
    const finalText = lastTranscriptRef.current.trim();
    lastTranscriptRef.current = "";
    if (finalText) handleSendRef.current(finalText);
  });
  useSpeechRecognitionEvent("error", (e) => {
    setListening(false);
    setMicLevel(0);
    // en-GB pack not downloaded (error 13) → retry once with en-US so dictation
    // still works now, and kick off the en-GB download for next time.
    const langIssue = e.error === "language-not-supported" || /not.*download|language.?pack/i.test(e.message || "");
    if (langIssue && !retriedLocaleRef.current) {
      retriedLocaleRef.current = true;
      try {
        ExpoSpeechRecognitionModule.androidTriggerOfflineModelDownload({ locale: "en-GB" }).catch(() => {});
      } catch {
        // download trigger not available — ignore
      }
      startListening("en-US");
    }
  });

  function startListening(lang: string) {
    setInput("");
    setMicLevel(0);
    setListening(true);
    ExpoSpeechRecognitionModule.start({
      lang,
      interimResults: true,
      continuous: false,
      addsPunctuation: true,
      volumeChangeEventOptions: { enabled: true, intervalMillis: 120 },
      // Wait a couple of seconds of silence before deciding the user has finished,
      // so they aren't cut off mid-sentence.
      androidIntentOptions: {
        EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS: 2000,
        EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS: 2000,
        EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS: 2000,
      },
    });
  }

  async function toggleMic() {
    if (listening) {
      ExpoSpeechRecognitionModule.stop(); // fires "end" → auto-sends
      return;
    }
    const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!perm.granted) return;
    retriedLocaleRef.current = false;
    lastTranscriptRef.current = "";
    startListening("en-GB");
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
      // If the thread ends on an unanswered user message, the last turn was
      // interrupted (backgrounded/killed/crashed) — offer to continue it.
      const last = loaded.contents[loaded.contents.length - 1];
      setNeedsResume(!!last && last.role === "user" && !!turnText(last));
    })();
    return () => {
      active = false;
    };
  }, [threadId]);

  // Pre-fill the composer with text shared into the app (capture flow).
  useEffect(() => {
    if (initialText) {
      setInput(initialText);
      onShareConsumed?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialText]);

  // Auto-send a routine's prompt once the thread has loaded (one-tap routines).
  const autoSentRef = useRef<string | null>(null);
  useEffect(() => {
    if (initialSend && thread && autoSentRef.current !== thread.id) {
      autoSentRef.current = thread.id;
      handleSendMessage(initialSend);
      onSendConsumed?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSend, thread]);

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

  // Keep the ref pointing at the latest sender so event handlers (STT auto-send)
  // never call a stale closure.
  handleSendRef.current = handleSendMessage;

  function handleSendMessage(userPrompt: string) {
    const prompt = userPrompt.trim();
    // Slash commands (handled locally, not sent to the model).
    if (prompt === "/mcp") {
      setInput("");
      setMcpVisible(true);
      return;
    }
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

  // Continue an interrupted turn: the history already ends with the user's
  // message, so just run it (no new bubble). Used by the resume banner.
  function resumeTurn() {
    if (runningRef.current || !thread) return;
    setNeedsResume(false);
    void runTurn(liveContentsRef.current, false, null);
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
    setNeedsResume(false);
    const requestTitle = !!titleFrom; // first message → ask the model to title it inline
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
            // Hide the inline "TITLE:" line from the streamed reply.
            targetRef.current = requestTitle ? stripLeadingTitle(full) : full;
            ensureTicker();
          },
          signal: controller.signal,
          confirmWrite,
        },
        thread.memo,
        { threadId: thread.id, threadTitle: thread.title },
        requestTitle
      );

      let updated: Thread = { ...thread, contents: result.contents, updatedAt: Date.now() };
      if (historySize(updated.contents) > (proModeRef.current ? COMPACT_THRESHOLD_CHARS * 2 : COMPACT_THRESHOLD_CHARS)) {
        const split = safeSplit(updated.contents);
        if (split > 0) {
          setStatus("Compacting memory...");
          const memo = await compactConversation(updated.memo, updated.contents.slice(0, split));
          updated = { ...updated, memo, contents: updated.contents.slice(split) };
        }
      }
      // Title the thread from the AI's first reply — batched into this same turn
      // (the model prepends a TITLE line; no separate request). Fall back to a
      // local title if it didn't.
      if (titleFrom) updated.title = result.title?.trim() || deriveTitle(titleFrom);

      liveContentsRef.current = updated.contents;
      setThread(updated);
      await saveThread(updated);
      onThreadChanged();
      resetStream();
      const replyId = pushMessage("model", result.reply);
      if (wasVoice) startSpeak(replyId, result.reply);
      // Finished while the user was away → ping them their reply is ready.
      if (AppState.currentState !== "active") void notifyTurnDone(updated.title, result.reply);
    } catch (err) {
      const aborted = err instanceof AbortedError || (err as Error)?.name === "AbortedError";
      if (interruptRef.current) {
        // Aborted to immediately run a redirect message — no "Stopped" notice.
        interruptRef.current = false;
      } else if (aborted) {
        if (bgAbortRef.current) {
          // Background-run is off and the app was backgrounded — offer to resume.
          pushMessage(
            "model",
            "Paused — Fraude was sent to the background. Turn on “Keep working in the background” in Settings, or continue now.",
            undefined,
            true
          );
        } else {
          pushMessage("model", "Stopped.");
        }
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
        </View>
      ) : null}

      {needsResume && !busy ? (
        <TouchableOpacity style={styles.resumeBanner} onPress={resumeTurn}>
          <Ionicons name="play" size={16} color={theme.bg} />
          <Text style={styles.resumeText}>Continue this answer</Text>
        </TouchableOpacity>
      ) : null}

      {pendingImage ? (
        <View style={styles.attachPreview}>
          <Image source={{ uri: pendingImage.uri }} style={styles.attachThumb} />
          <Text style={styles.attachLabel}>Image attached</Text>
          <TouchableOpacity onPress={() => setPendingImage(null)} hitSlop={8}>
            <Ionicons name="close-circle" size={22} color={theme.textDim} />
          </TouchableOpacity>
        </View>
      ) : null}

      {/* Unified composer: text + mic row, divider, actions row. */}
      <View style={styles.composer}>
        <View style={styles.composerTop}>
          <TextInput
            style={styles.composerInput}
            value={input}
            onChangeText={(t) => {
              setInput(t);
              voiceInputRef.current = false;
            }}
            placeholder={listening ? "Listening…" : busy ? "Queue another message…" : "Message"}
            placeholderTextColor={theme.textDim}
            multiline
          />
          <TouchableOpacity onPress={toggleMic} disabled={busy} hitSlop={8}>
            {listening ? (
              <View style={styles.micActive}>
                <VoiceWave level={micLevel} color={theme.danger} />
              </View>
            ) : (
              <Ionicons name="mic" size={22} color={theme.textDim} />
            )}
          </TouchableOpacity>
        </View>
        <View style={styles.composerDivider} />
        <View style={styles.composerBottom}>
          <TouchableOpacity onPress={pickImage} hitSlop={8}>
            <Ionicons name="add" size={26} color={theme.textDim} />
          </TouchableOpacity>
          <View style={{ flex: 1 }} />
          <TouchableOpacity
            style={[styles.autoPill, approvalMode === "auto" && styles.autoPillOn]}
            onPress={() => setAutoMenu(true)}
          >
            <Ionicons
              name={approvalMode === "auto" ? "flash" : approvalMode === "granular" ? "list" : "albums"}
              size={14}
              color={approvalMode === "auto" ? theme.bg : theme.accent}
            />
            <Text style={[styles.autoPillText, approvalMode === "auto" && styles.autoPillTextOn]}>
              {approvalMode === "auto" ? "Auto" : approvalMode === "granular" ? "Each" : "Batched"}
            </Text>
          </TouchableOpacity>
          {busy ? (
            <TouchableOpacity style={styles.composerStop} onPress={() => abortRef.current?.abort()}>
              <Ionicons name="square" size={16} color="#fff" />
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity
            style={[styles.composerSend, !input.trim() && !pendingImage && styles.sendBtnDisabled]}
            onPress={() => handleSendMessage(input)}
            disabled={!input.trim() && !pendingImage}
          >
            <Ionicons name="arrow-up" size={20} color={theme.bg} />
          </TouchableOpacity>
        </View>
      </View>

      <McpServersModal visible={mcpVisible} onClose={() => setMcpVisible(false)} />

      <Modal visible={!!confirmReq} transparent animationType="fade" onRequestClose={() => answerConfirm(false)}>
        <View style={styles.confirmOverlay}>
          <View style={styles.confirmCard}>
            <Text style={styles.confirmTitle}>
              {(confirmReq?.items.length ?? 0) > 1 ? `Confirm ${confirmReq?.items.length} actions` : "Confirm action"}
            </Text>
            <Text style={styles.confirmDetail}>
              {confirmReq?.granular
                ? "Tick the actions to allow — nothing runs until you tap Apply:"
                : (confirmReq?.items.length ?? 0) > 1
                  ? "Fraude wants to do the following, in order:"
                  : "Fraude wants to:"}
            </Text>
            <ScrollView style={styles.confirmList} contentContainerStyle={{ gap: 10 }}>
              {confirmReq?.items.map((it, i) => {
                const on = confirmChecks[it.idx];
                const row = (
                  <>
                    {confirmReq.granular ? (
                      <Ionicons
                        name={on ? "checkbox" : "square-outline"}
                        size={22}
                        color={on ? theme.accent : theme.textDim}
                      />
                    ) : confirmReq.items.length > 1 ? (
                      <Text style={styles.confirmStep}>{i + 1}</Text>
                    ) : null}
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.confirmItemLabel, confirmReq.granular && !on && styles.confirmItemOff]}>
                        {it.label}
                      </Text>
                      <Text style={styles.confirmItemBody} selectable numberOfLines={4}>{it.body}</Text>
                    </View>
                  </>
                );
                return confirmReq.granular ? (
                  <TouchableOpacity
                    key={i}
                    style={styles.confirmItem}
                    onPress={() => setConfirmChecks((c) => ({ ...c, [it.idx]: !c[it.idx] }))}
                  >
                    {row}
                  </TouchableOpacity>
                ) : (
                  <View key={i} style={styles.confirmItem}>{row}</View>
                );
              })}
            </ScrollView>

            {noteOpen ? (
              <View style={styles.confirmNoteWrap}>
                <TextInput
                  style={styles.confirmNoteInput}
                  value={confirmNote}
                  onChangeText={setConfirmNote}
                  placeholder="What should it do instead?"
                  placeholderTextColor={theme.textDim}
                  multiline
                  autoFocus
                />
                <View style={styles.confirmActions}>
                  <TouchableOpacity style={styles.confirmDecline} onPress={() => setNoteOpen(false)}>
                    <Text style={styles.confirmDeclineText}>Back</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.confirmAllow, !confirmNote.trim() && styles.confirmAllowDisabled]}
                    disabled={!confirmNote.trim()}
                    onPress={() => answerConfirm(false, confirmNote)}
                  >
                    <Text style={styles.confirmAllowText}>Send guidance</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : (
              <>
                <View style={styles.confirmActions}>
                  <TouchableOpacity style={styles.confirmDecline} onPress={() => answerConfirm(false)}>
                    <Text style={styles.confirmDeclineText}>{confirmReq?.granular ? "Cancel" : "Decline"}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.confirmAllow, confirmReq?.danger && styles.confirmAllowDanger]}
                    onPress={() => answerConfirm(confirmReq?.granular ? null : true)}
                  >
                    <Text style={[styles.confirmAllowText, confirmReq?.danger && styles.confirmAllowDangerText]}>
                      {confirmReq?.granular ? "Apply" : confirmReq?.danger ? "Run anyway" : "Allow"}
                    </Text>
                  </TouchableOpacity>
                </View>
                <TouchableOpacity style={styles.confirmOther} onPress={() => setNoteOpen(true)}>
                  <Ionicons name="create-outline" size={15} color={theme.textDim} />
                  <Text style={styles.confirmOtherText}>Something else — tell Fraude what to do</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        </View>
      </Modal>

      <Modal visible={autoMenu} transparent animationType="fade" onRequestClose={() => setAutoMenu(false)}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setAutoMenu(false)}>
          <View style={styles.modeCard}>
            <Text style={styles.modeCardTitle}>Permission mode</Text>
            <TouchableOpacity
              style={[styles.modeRow, approvalMode === "batched" && styles.modeRowActive]}
              onPress={() => setApprovalMode("batched")}
            >
              <Ionicons name="albums-outline" size={22} color={theme.text} />
              <View style={styles.modeTextWrap}>
                <Text style={styles.modeName}>Batched approval</Text>
                <Text style={styles.modeDesc}>Approve a whole task in one prompt. Quick for multi-step jobs.</Text>
              </View>
              {approvalMode === "batched" ? <Ionicons name="checkmark" size={20} color={theme.accent} /> : null}
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.modeRow, approvalMode === "granular" && styles.modeRowActive]}
              onPress={() => setApprovalMode("granular")}
            >
              <Ionicons name="list-outline" size={22} color={theme.text} />
              <View style={styles.modeTextWrap}>
                <Text style={styles.modeName}>Approve each action</Text>
                <Text style={styles.modeDesc}>Tick the steps to allow — nothing runs until you Apply. Most control.</Text>
              </View>
              {approvalMode === "granular" ? <Ionicons name="checkmark" size={20} color={theme.accent} /> : null}
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.modeRow, approvalMode === "auto" && styles.modeRowActive]}
              onPress={() => setApprovalMode("auto")}
            >
              <Ionicons name="flash" size={22} color={theme.accent} />
              <View style={styles.modeTextWrap}>
                <Text style={styles.modeName}>Auto mode</Text>
                <Text style={styles.modeDesc}>Run everything without asking (system shell still confirms). Trust the task.</Text>
              </View>
              {approvalMode === "auto" ? <Ionicons name="checkmark" size={20} color={theme.accent} /> : null}
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>
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
  // ```diff blocks render git-style with +/- line colouring (CLI-like review).
  fence: (node: { key: string; content: string; sourceInfo?: string }) => {
    const lang = (node.sourceInfo || "").trim().toLowerCase();
    if (lang === "diff" || lang === "patch") {
      const lines = node.content.replace(/\n$/, "").split("\n");
      return (
        <ScrollView key={node.key} horizontal showsHorizontalScrollIndicator={false} style={styles.codeBlock} contentContainerStyle={styles.codeBlockInner}>
          <View>
            {lines.map((ln, i) => {
              const style =
                ln.startsWith("+") && !ln.startsWith("+++")
                  ? styles.diffAdd
                  : ln.startsWith("-") && !ln.startsWith("---")
                    ? styles.diffDel
                    : ln.startsWith("@@")
                      ? styles.diffHunk
                      : null;
              return (
                <Text key={i} style={[styles.codeText, style]}>
                  {ln.length ? ln : " "}
                </Text>
              );
            })}
          </View>
        </ScrollView>
      );
    }
    return (
      <ScrollView key={node.key} horizontal showsHorizontalScrollIndicator={false} style={styles.codeBlock} contentContainerStyle={styles.codeBlockInner}>
        <Text style={styles.codeText}>{node.content}</Text>
      </ScrollView>
    );
  },
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
  diffAdd: { color: "#3fb950" },
  diffDel: { color: "#f85149" },
  diffHunk: { color: theme.accent },
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
  resumeBanner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    alignSelf: "center",
    backgroundColor: theme.accent,
    borderRadius: 20,
    paddingHorizontal: 18,
    paddingVertical: 10,
    marginHorizontal: 16,
    marginBottom: 6,
  },
  resumeText: { color: theme.bg, fontWeight: "700", fontSize: 14 },
  statusText: { color: theme.textDim, fontSize: 13, fontStyle: "italic", flex: 1 },
  composer: {
    margin: 10,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.surface,
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 10,
    overflow: "hidden",
  },
  composerTop: { flexDirection: "row", alignItems: "flex-end", gap: 10, paddingBottom: 8 },
  micActive: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.danger + "22",
    borderWidth: 1,
    borderColor: theme.danger + "55",
  },
  wave: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 2.5, height: 18 },
  waveBar: { width: 2.5, height: 16, borderRadius: 2 },
  composerInput: { flex: 1, color: theme.text, fontSize: 16, minHeight: 36, maxHeight: 150, paddingTop: 4, paddingBottom: 4 },
  // Full-bleed divider (cancels the card's horizontal padding so it spans edge to edge).
  composerDivider: { height: 1, backgroundColor: theme.border, marginHorizontal: -14, marginBottom: 10 },
  composerBottom: { flexDirection: "row", alignItems: "center", gap: 10 },
  autoPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 15,
    borderWidth: 1,
    borderColor: theme.accent,
  },
  autoPillOn: { backgroundColor: theme.accent },
  autoPillText: { color: theme.accent, fontSize: 13, fontWeight: "700" },
  autoPillTextOn: { color: theme.bg },
  composerSend: { width: 36, height: 36, borderRadius: 18, backgroundColor: theme.accent, alignItems: "center", justifyContent: "center" },
  composerStop: { width: 36, height: 36, borderRadius: 18, backgroundColor: theme.danger, alignItems: "center", justifyContent: "center" },
  confirmOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "center", padding: 22 },
  confirmCard: {
    backgroundColor: theme.surface,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: theme.border,
    padding: 18,
  },
  confirmTitle: { color: theme.text, fontSize: 18, fontWeight: "800" },
  confirmDetail: { color: theme.textDim, fontSize: 13, marginTop: 4, marginBottom: 12, lineHeight: 18 },
  confirmList: { maxHeight: 280 },
  confirmItem: { flexDirection: "row", gap: 10, backgroundColor: theme.surfaceAlt, borderRadius: 12, padding: 12 },
  confirmStep: {
    color: theme.accent,
    fontSize: 13,
    fontWeight: "800",
    width: 20,
    height: 20,
    textAlign: "center",
    lineHeight: 20,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.accent,
    overflow: "hidden",
  },
  confirmItemLabel: { color: theme.text, fontSize: 15, fontWeight: "700" },
  confirmItemOff: { color: theme.textDim, textDecorationLine: "line-through" },
  confirmItemBody: { color: theme.textDim, fontSize: 13, marginTop: 3, lineHeight: 18 },
  confirmActions: { flexDirection: "row", gap: 10, marginTop: 16 },
  confirmOther: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 12, marginTop: 2 },
  confirmOtherText: { color: theme.textDim, fontSize: 13, fontWeight: "600" },
  confirmNoteWrap: { marginTop: 12 },
  confirmNoteInput: {
    backgroundColor: theme.surfaceAlt,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.border,
    color: theme.text,
    fontSize: 15,
    padding: 12,
    minHeight: 80,
    textAlignVertical: "top",
  },
  confirmDecline: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.border,
    alignItems: "center",
  },
  confirmDeclineText: { color: theme.textDim, fontSize: 15, fontWeight: "700" },
  confirmAllow: { flex: 1, paddingVertical: 13, borderRadius: 12, backgroundColor: theme.accent, alignItems: "center" },
  confirmAllowText: { color: theme.bg, fontSize: 15, fontWeight: "800" },
  confirmAllowDanger: { backgroundColor: theme.danger },
  confirmAllowDangerText: { color: "#fff" },
  confirmAllowDisabled: { opacity: 0.4 },
  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end", padding: 16 },
  modeCard: { backgroundColor: theme.surface, borderRadius: 16, borderWidth: 1, borderColor: theme.border, padding: 14, marginBottom: 80 },
  modeCardTitle: { color: theme.textDim, fontSize: 13, fontWeight: "700", marginBottom: 10, textTransform: "uppercase", letterSpacing: 1 },
  modeRow: { flexDirection: "row", alignItems: "center", gap: 12, padding: 12, borderRadius: 12 },
  modeRowActive: { backgroundColor: theme.surfaceAlt },
  modeTextWrap: { flex: 1 },
  modeName: { color: theme.text, fontSize: 16, fontWeight: "700" },
  modeDesc: { color: theme.textDim, fontSize: 13, marginTop: 2, lineHeight: 18 },
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
