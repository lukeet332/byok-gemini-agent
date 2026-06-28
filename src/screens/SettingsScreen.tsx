// Settings: the user's Gemini key plus an arbitrary set of named API
// credentials. Everything is read from / written to expo-secure-store via
// SecureStorage and never leaves the device except as the user's own direct
// API calls. The agent references these secrets by NAME ({{NAME}}), so the raw
// values are never sent to Gemini.

import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

import {
  getAnthropicConfig,
  getBackgroundRun,
  getConfirmSystemActions,
  getExecMode,
  getGeminiKey,
  getGithubToken,
  getModel,
  getOpenAiConfig,
  getProvider,
  getSystemPrompt,
  getWriteMode,
  loadSecrets,
  normalizeSecretName,
  saveAll,
  saveAnthropicConfig,
  saveBackgroundRun,
  saveConfirmSystemActions,
  saveExecMode,
  saveGithubToken,
  saveModel,
  saveOpenAiConfig,
  saveProvider,
  saveSystemPrompt,
  saveWriteMode,
  AiProvider,
  ExecMode,
  GitWriteMode,
  NamedSecret,
} from "../storage/SecureStorage";
import { clearErrors, listErrorsByThread, ErrorGroup } from "../storage/ErrorLogStore";
import { requestNotificationPermission } from "../agent/Background";
import {
  a11yEnabled,
  hasAllFilesAccess,
  linuxTerminalStatus,
  LinuxTerminalStatus,
  openA11ySettings,
  openAppInfo,
  openLinuxTerminal,
  requestAllFilesAccess,
  requestShizukuPermission,
  shizukuStatus,
  ShizukuStatus,
} from "../../modules/shell-exec";
import { getUserNotes, saveUserNotes } from "../storage/UserNotes";
import {
  ANTHROPIC_DEFAULT_MODEL,
  ANTHROPIC_PRESETS,
  DEFAULT_MODEL,
  DEFAULT_SYSTEM_PROMPT,
  MODEL_PRESETS,
  OPENAI_PRESETS,
} from "../agent/GeminiAgent";
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
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [shizuku, setShizuku] = useState<ShizukuStatus>({ running: false, granted: false });
  const [a11yOn, setA11yOn] = useState(false);
  const [allFiles, setAllFiles] = useState(false);
  const [linux, setLinux] = useState<LinuxTerminalStatus>({ supported: false, available: false, sdk: 0 });
  const [userNotes, setUserNotes] = useState("");
  // Live model list from Google (null = loading/failed -> use presets).
  const [modelMenu, setModelMenu] = useState(false);
  const [customModel, setCustomModel] = useState(false);
  // AI provider + the non-Gemini backends' config.
  const [provider, setProvider] = useState<AiProvider>("gemini");
  const [anthropicKey, setAnthropicKey] = useState("");
  const [anthropicModel, setAnthropicModel] = useState("");
  const [anthMenu, setAnthMenu] = useState(false);
  const [customAnth, setCustomAnth] = useState(false);
  const [openaiBase, setOpenaiBase] = useState("");
  const [openaiKey, setOpenaiKey] = useState("");
  const [openaiModel, setOpenaiModel] = useState("");
  const [backgroundRun, setBackgroundRunState] = useState(true);
  const [execMode, setExecModeState] = useState<ExecMode>("off");
  const [confirmSystem, setConfirmSystemState] = useState(true);

  // Latest form values + a "loaded" flag, so we can auto-save on leave (a cleanup
  // closure would otherwise capture stale initial state).
  const loadedRef = useRef(false);
  const latest = useRef({
    geminiKey,
    model,
    provider,
    openaiBase,
    openaiKey,
    openaiModel,
    anthropicKey,
    anthropicModel,
    backgroundRun,
    execMode,
    confirmSystem,
    githubToken,
    writeMode,
    systemPrompt,
    userNotes,
    secrets,
  });
  latest.current = {
    geminiKey,
    model,
    provider,
    openaiBase,
    openaiKey,
    openaiModel,
    anthropicKey,
    anthropicModel,
    backgroundRun,
    execMode,
    confirmSystem,
    githubToken,
    writeMode,
    systemPrompt,
    userNotes,
    secrets,
  };

  useEffect(() => {
    (async () => {
      setGeminiKey(await getGeminiKey());
      setModel(await getModel());
      setProvider(await getProvider());
      const oa = await getOpenAiConfig();
      setOpenaiBase(oa.baseUrl);
      setOpenaiKey(oa.apiKey);
      setOpenaiModel(oa.model);
      const an = await getAnthropicConfig();
      setAnthropicKey(an.apiKey);
      setAnthropicModel(an.model);
      setBackgroundRunState(await getBackgroundRun());
      setExecModeState(await getExecMode());
      setConfirmSystemState(await getConfirmSystemActions());
      setShizuku(await shizukuStatus());
      setA11yOn(a11yEnabled());
      setAllFiles(hasAllFilesAccess());
      setLinux(linuxTerminalStatus());
      setGithubToken(await getGithubToken());
      setWriteMode(await getWriteMode());
      setSystemPrompt(await getSystemPrompt());
      setUserNotes(await getUserNotes());
      setSecrets(await loadSecrets());
      setErrorGroups(await listErrorsByThread());
      setLoading(false);
      loadedRef.current = true;
    })();
  }, []);

  // Auto-save when leaving the screen, so dropdown/provider/toggle changes stick
  // even if the user doesn't tap Save. Guarded so we never write before load.
  useEffect(() => {
    return () => {
      if (loadedRef.current) void persistSettings(latest.current);
    };
  }, []);

  async function refreshShizuku() {
    setShizuku(await shizukuStatus());
  }
  async function grantShizuku() {
    await requestShizukuPermission();
    await refreshShizuku();
  }

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

  async function persistSettings(v: typeof latest.current) {
    await saveAll(v.geminiKey, v.secrets);
    await saveModel(v.model);
    await saveProvider(v.provider);
    await saveOpenAiConfig({ baseUrl: v.openaiBase, apiKey: v.openaiKey, model: v.openaiModel });
    await saveAnthropicConfig({ apiKey: v.anthropicKey, model: v.anthropicModel });
    await saveBackgroundRun(v.backgroundRun);
    await saveExecMode(v.execMode);
    await saveConfirmSystemActions(v.confirmSystem);
    await saveGithubToken(v.githubToken);
    await saveWriteMode(v.writeMode);
    await saveSystemPrompt(v.systemPrompt);
    await saveUserNotes(v.userNotes);
  }

  async function onSave() {
    setSaving(true);
    setStatus(null);
    try {
      await persistSettings(latest.current);
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

        <Text style={styles.sectionLabel}>AI provider</Text>
        <Text style={styles.hint}>Which AI runs the agent. Gemini is the default; the app is provider-agnostic.</Text>
        <View style={styles.segment}>
          {([
            { id: "gemini", label: "Gemini" },
            { id: "anthropic", label: "Claude" },
            { id: "openai", label: "Other" },
          ] as { id: AiProvider; label: string }[]).map((p) => (
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
          <>
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
            <Text style={styles.hint}>Which Gemini model the agent uses.</Text>
            {(() => {
              const eff = model || DEFAULT_MODEL;
              const preset = MODEL_PRESETS.find((p) => p.id === eff);
              return (
                <TouchableOpacity style={styles.dropdown} onPress={() => setModelMenu(true)}>
                  <Text style={styles.dropdownText}>{preset ? `${preset.id} — ${preset.label}` : eff}</Text>
                  <Text style={styles.dropdownChevron}>▾</Text>
                </TouchableOpacity>
              );
            })()}
            {customModel || (!!model && !MODEL_PRESETS.some((p) => p.id === model)) ? (
              <TextInput
                style={[styles.input, { marginTop: 8 }]}
                value={model}
                onChangeText={setModel}
                placeholder={`custom model id (default ${DEFAULT_MODEL})`}
                placeholderTextColor={theme.textDim}
                autoCapitalize="none"
                autoCorrect={false}
              />
            ) : null}
          </>
        ) : provider === "anthropic" ? (
          <>
            <Text style={styles.sectionLabel}>Anthropic API key</Text>
            <Text style={styles.hint}>Runs Claude directly via the Anthropic Messages API.</Text>
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
            <Link label="Get an Anthropic key →" url="https://console.anthropic.com/settings/keys" />

            <Text style={styles.sectionLabel}>Claude model</Text>
            {(() => {
              const eff = anthropicModel || ANTHROPIC_DEFAULT_MODEL;
              const preset = ANTHROPIC_PRESETS.find((p) => p.id === eff);
              return (
                <TouchableOpacity style={styles.dropdown} onPress={() => setAnthMenu(true)}>
                  <Text style={styles.dropdownText}>{preset ? `${preset.id} — ${preset.label}` : eff}</Text>
                  <Text style={styles.dropdownChevron}>▾</Text>
                </TouchableOpacity>
              );
            })()}
            {customAnth || (!!anthropicModel && !ANTHROPIC_PRESETS.some((p) => p.id === anthropicModel)) ? (
              <TextInput
                style={[styles.input, { marginTop: 8 }]}
                value={anthropicModel}
                onChangeText={setAnthropicModel}
                placeholder={`custom Claude model (default ${ANTHROPIC_DEFAULT_MODEL})`}
                placeholderTextColor={theme.textDim}
                autoCapitalize="none"
                autoCorrect={false}
              />
            ) : null}
          </>
        ) : (
          <>
            <Text style={styles.sectionLabel}>OpenAI-compatible backend</Text>
            <Text style={styles.hint}>
              Any /chat/completions server — OpenAI, OpenRouter (incl. Claude), Groq, Mistral, DeepSeek, a local
              LLM… Tap a preset or paste a base URL.
            </Text>
            <View style={styles.chips}>
              {OPENAI_PRESETS.map((p) => (
                <TouchableOpacity
                  key={p.id}
                  style={[styles.chip, openaiBase === p.baseUrl && styles.chipActive]}
                  onPress={() => {
                    setOpenaiBase(p.baseUrl);
                    if (!openaiModel) setOpenaiModel(p.sampleModel);
                  }}
                >
                  <Text style={[styles.chipText, openaiBase === p.baseUrl && styles.chipTextActive]}>{p.label}</Text>
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
          </>
        )}

        <Modal visible={modelMenu} transparent animationType="fade" onRequestClose={() => setModelMenu(false)}>
          <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setModelMenu(false)}>
            <View style={styles.modeCard}>
              <Text style={styles.modeCardTitle}>Model</Text>
              {MODEL_PRESETS.map((p) => (
                <TouchableOpacity
                  key={p.id}
                  style={styles.modelRow}
                  onPress={() => {
                    setModel(p.id);
                    setCustomModel(false);
                    setModelMenu(false);
                  }}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={styles.modelName}>{p.id}</Text>
                    <Text style={styles.modelDesc}>{p.label}</Text>
                  </View>
                  {(model || DEFAULT_MODEL) === p.id ? <Text style={styles.modelCheck}>✓</Text> : null}
                </TouchableOpacity>
              ))}
              <TouchableOpacity
                style={styles.modelRow}
                onPress={() => {
                  setCustomModel(true);
                  setModelMenu(false);
                }}
              >
                <Text style={styles.modelName}>Custom…</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </Modal>

        <Modal visible={anthMenu} transparent animationType="fade" onRequestClose={() => setAnthMenu(false)}>
          <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setAnthMenu(false)}>
            <View style={styles.modeCard}>
              <Text style={styles.modeCardTitle}>Claude model</Text>
              {ANTHROPIC_PRESETS.map((p) => (
                <TouchableOpacity
                  key={p.id}
                  style={styles.modelRow}
                  onPress={() => {
                    setAnthropicModel(p.id);
                    setCustomAnth(false);
                    setAnthMenu(false);
                  }}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={styles.modelName}>{p.id}</Text>
                    <Text style={styles.modelDesc}>{p.label}</Text>
                  </View>
                  {(anthropicModel || ANTHROPIC_DEFAULT_MODEL) === p.id ? <Text style={styles.modelCheck}>✓</Text> : null}
                </TouchableOpacity>
              ))}
              <TouchableOpacity
                style={styles.modelRow}
                onPress={() => {
                  setCustomAnth(true);
                  setAnthMenu(false);
                }}
              >
                <Text style={styles.modelName}>Custom…</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </Modal>

        <Text style={styles.sectionLabel}>Background</Text>
        <View style={styles.toggleRow}>
          <View style={styles.toggleTextWrap}>
            <Text style={styles.toggleName}>Keep working in the background</Text>
            <Text style={styles.hint}>
              Don't cancel a running task when you leave the app or lock the screen — let it finish, and get a
              notification when it's done. The OS grants a grace period (longer on Android than iOS); if a long
              task is suspended, your chat is saved and offers a Continue button when you reopen it.
            </Text>
          </View>
          <Switch
            value={backgroundRun}
            onValueChange={(v) => {
              setBackgroundRunState(v);
              if (v) void requestNotificationPermission();
            }}
            trackColor={{ false: theme.border, true: theme.accent }}
            thumbColor={theme.text}
          />
        </View>

        <Text style={styles.sectionLabel}>Screen automation</Text>
        <Text style={styles.hint}>
          Let Fraude operate your phone — read the screen and tap/type to drive any app (e.g. open WhatsApp
          with a drafted message and press send). App-agnostic; no root needed. Status:{" "}
          {a11yOn ? "enabled ✓" : "off"}.
        </Text>
        {!a11yOn ? (
          <Text style={[styles.hint, { marginTop: 6 }]}>
            ⚠️ If the Accessibility toggle is greyed out or says “Restricted setting” (normal for apps installed
            outside the Play Store on Android 13+): open App info → ⋮ menu (top-right) → “Allow restricted
            settings”, then turn Fraude on in Accessibility.
          </Text>
        ) : null}
        <View style={styles.advButtons}>
          <TouchableOpacity style={styles.advBtn} onPress={() => openA11ySettings()}>
            <Text style={styles.advBtnText}>{a11yOn ? "Accessibility settings" : "Enable screen automation"}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.advBtn} onPress={() => openAppInfo()}>
            <Text style={styles.advBtnText}>App info (allow restricted)</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.advBtn} onPress={() => setA11yOn(a11yEnabled())}>
            <Text style={styles.advBtnText}>Refresh</Text>
          </TouchableOpacity>
        </View>

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

        <TouchableOpacity style={styles.accordionHead} onPress={() => setAdvancedOpen((o) => !o)}>
          <Text style={styles.sectionLabel}>Advanced mode</Text>
          <Text style={styles.accordionChevron}>{advancedOpen ? "▾" : "▸"}</Text>
        </TouchableOpacity>
        {advancedOpen ? (
          <>
            <Text style={styles.hint}>
              These give Fraude deeper powers, for two different jobs: CODING (build/run/test code) and DEVICE
              CONTROL (operate the phone & other apps). Quick guide to what to enable:
            </Text>
            <Text style={[styles.hint, { marginTop: 8 }]}>
              {"• Coding, simplest (no root): install Termux + grant All files access → Fraude builds & tests with real tools.\n"}
              {"• Coding, more power: add Shizuku (or root) so Fraude can also read any file and run system commands.\n"}
              {"• Do things in other apps (e.g. send a WhatsApp): Screen automation — no root needed.\n"}
              {"• Shizuku = ADB-level powers (pm, settings, input, grant permissions, read anything) WITHOUT root.\n"}
              {"• Root = everything Shizuku does + system files + system-app install (rooted devices only).\n"}
              {"• Set ONE Execution mode (below) = the single backend the AI runs commands with: App sandbox / Termux / Shizuku / Root.\n"}
              {"• Linux Terminal (Android 16+) = a full Debian VM for heavy manual coding; Fraude can't drive it yet, so use Termux for automated runs."}
            </Text>
            <Text style={[styles.hint, { marginTop: 8 }]}>Powerful and risky — only enable what you need.</Text>

            <Text style={styles.smallLabel}>Execution mode</Text>
            <Text style={styles.hint}>
              Pick the ONE backend the AI runs code/commands with (so it's never confused which to use). Set up
              the matching tool below.
            </Text>
            {(
              [
                { id: "off", label: "Off", desc: "No on-device execution (edit via GitHub)." },
                { id: "app", label: "App sandbox", desc: "Basic built-in tools only; no compilers." },
                { id: "termux", label: "Termux", desc: "Real toolchains (python/node/clang/git). No root." },
                { id: "shizuku", label: "Shizuku", desc: "ADB-level: device control + commands + Termux." },
                { id: "root", label: "Root", desc: "Full root + Termux (rooted devices)." },
              ] as { id: ExecMode; label: string; desc: string }[]
            ).map((m) => (
              <TouchableOpacity key={m.id} style={styles.modelRow} onPress={() => setExecModeState(m.id)}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.modelName}>{m.label}</Text>
                  <Text style={styles.modelDesc}>{m.desc}</Text>
                </View>
                {execMode === m.id ? <Text style={styles.modelCheck}>✓</Text> : null}
              </TouchableOpacity>
            ))}

            <View style={styles.toggleRow}>
              <View style={styles.toggleTextWrap}>
                <Text style={styles.toggleName}>Always confirm system actions</Text>
                <Text style={styles.hint}>
                  Make Shizuku & root commands ask for confirmation every time — even when Auto mode is on.
                  Strongly recommended; these run with elevated privileges.
                </Text>
              </View>
              <Switch
                value={confirmSystem}
                onValueChange={setConfirmSystemState}
                trackColor={{ false: theme.border, true: theme.accent }}
                thumbColor={theme.text}
              />
            </View>

            <Text style={styles.smallLabel}>Shizuku — shell access without root</Text>
            <Text style={styles.hint}>
              Shizuku grants ADB-level (shell-uid) privileges to apps without rooting — enough to run
              pm/cmd/settings, automate other apps, and grant Fraude extra permissions. Install it, start it
              once via Wireless Debugging, then grant access here.{"\n"}Status:{" "}
              {shizuku.running ? (shizuku.granted ? "connected ✓" : "running — needs permission") : "not running"}.
            </Text>
            <Link label="How to set up Shizuku →" url="https://shizuku.rikka.app/guide/setup/" />
            <View style={styles.advButtons}>
              <TouchableOpacity style={styles.advBtn} onPress={refreshShizuku}>
                <Text style={styles.advBtnText}>Refresh status</Text>
              </TouchableOpacity>
              {shizuku.running && !shizuku.granted ? (
                <TouchableOpacity style={styles.advBtn} onPress={grantShizuku}>
                  <Text style={styles.advBtnText}>Grant Shizuku access</Text>
                </TouchableOpacity>
              ) : null}
            </View>

            <Text style={styles.smallLabel}>Native Linux terminal (Android 16+)</Text>
            <Text style={styles.hint}>
              {linux.supported
                ? linux.available
                  ? "Your device has the native Linux Terminal — a full Debian VM with apt and real toolchains. The best place for heavy local coding. (To let Fraude run commands inside it, run an SSH server in the VM — bridge coming.)"
                  : "Your device supports the native Linux Terminal (Android 16+). Enable it in Developer options → Linux development environment, then it's a full Debian VM for coding."
                : `Not available on this device (Android 16+ only; you're on API ${linux.sdk || "?"}). Use Termux above instead.`}
            </Text>
            {linux.supported ? (
              <View style={styles.advButtons}>
                <TouchableOpacity style={styles.advBtn} onPress={() => openLinuxTerminal()}>
                  <Text style={styles.advBtnText}>{linux.available ? "Open Linux Terminal" : "Enable in Developer options"}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.advBtn} onPress={() => setLinux(linuxTerminalStatus())}>
                  <Text style={styles.advBtnText}>Refresh</Text>
                </TouchableOpacity>
              </View>
            ) : null}

            <Text style={styles.smallLabel}>Root</Text>
            <Text style={styles.hint}>
              If your device is rooted, the AI can run commands as root (su) — confirmed each time, no extra
              setup beyond a working su. Root also allows installing Fraude as a privileged system app (very
              advanced, device-specific) — ask the assistant to walk you through it.
            </Text>

            <Text style={styles.smallLabel}>Local programming tools (Termux)</Text>
            <Text style={styles.hint}>
              Android ships toybox (ls, grep, cat, ps…) but no compilers. Install Termux + the Termux:API
              add-on for a full local toolchain (python, node, clang, git…). Once both are installed and shell
              execution is on, ask Fraude to set up or run your project and it drives the steps via run_shell /
              Termux.
            </Text>
            <Link label="Get Termux (F-Droid) →" url="https://f-droid.org/packages/com.termux/" />
            <Link label="Get Termux:API (F-Droid) →" url="https://f-droid.org/packages/com.termux.api/" />
            <Text style={[styles.hint, { marginTop: 10 }]}>
              To read Termux build output WITHOUT root or Shizuku, grant All files access — Fraude then reads
              the output it captures to shared storage.{"\n"}Status: {allFiles ? "granted ✓" : "not granted"}.
            </Text>
            <View style={styles.advButtons}>
              <TouchableOpacity style={styles.advBtn} onPress={() => requestAllFilesAccess()}>
                <Text style={styles.advBtnText}>Grant All files access</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.advBtn} onPress={() => setAllFiles(hasAllFilesAccess())}>
                <Text style={styles.advBtnText}>Refresh</Text>
              </TouchableOpacity>
            </View>
          </>
        ) : null}

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
  segment: {
    flexDirection: "row",
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 12,
    padding: 4,
    gap: 4,
    marginTop: 8,
  },
  toggleRow: { flexDirection: "row", alignItems: "center", gap: 12, marginTop: 8 },
  toggleTextWrap: { flex: 1 },
  toggleName: { color: theme.text, fontSize: 15, fontWeight: "700" },
  advButtons: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10 },
  advBtn: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.accent,
    backgroundColor: theme.surface,
  },
  advBtnText: { color: theme.accent, fontWeight: "700", fontSize: 13 },
  segItem: { flex: 1, paddingVertical: 10, borderRadius: 9, alignItems: "center" },
  segItemOn: { backgroundColor: theme.accent },
  segText: { color: theme.textDim, fontSize: 14, fontWeight: "700" },
  segTextOn: { color: theme.bg },
  chipActive: { borderColor: theme.accent, backgroundColor: theme.surfaceAlt },
  chipText: { color: theme.textDim, fontSize: 13 },
  chipTextActive: { color: theme.accent, fontWeight: "700" },
  promptInput: { minHeight: 120, textAlignVertical: "top" },
  accordionHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 14 },
  accordionChevron: { color: theme.textDim, fontSize: 16, marginTop: 14 },
  promptActions: { flexDirection: "row", justifyContent: "flex-end", gap: 20, marginTop: 8 },
  promptAction: { color: theme.accent, fontWeight: "700", fontSize: 13 },
  promptActionOff: { opacity: 0.4 },
  dropdown: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  dropdownText: { color: theme.text, fontSize: 15, flex: 1, marginRight: 8 },
  dropdownChevron: { color: theme.textDim, fontSize: 14 },
  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "center", padding: 22 },
  modeCard: { backgroundColor: theme.surface, borderRadius: 16, borderWidth: 1, borderColor: theme.border, padding: 12 },
  modeCardTitle: { color: theme.textDim, fontSize: 13, fontWeight: "700", marginBottom: 6, marginLeft: 4, textTransform: "uppercase", letterSpacing: 1 },
  modelRow: { flexDirection: "row", alignItems: "center", padding: 12, borderRadius: 10 },
  modelName: { color: theme.text, fontSize: 15, fontWeight: "700" },
  modelDesc: { color: theme.textDim, fontSize: 13, marginTop: 2 },
  modelCheck: { color: theme.accent, fontSize: 18, fontWeight: "700", marginLeft: 10 },
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
