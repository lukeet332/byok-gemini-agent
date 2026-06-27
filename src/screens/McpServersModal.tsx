// MCP servers panel — a catalog of remote servers with Connected / Needs-Auth
// status, like Claude's connectors. Tapping connects via OAuth (one tap) or a
// pasted token; tapping a connected server disconnects it.

import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

import { McpCatalogEntry } from "../mcp/catalog";
import * as Store from "../mcp/McpStore";
import * as Client from "../mcp/McpClient";
import { oauthConnect } from "../mcp/McpOAuth";
import { theme } from "../theme";

export default function McpServersModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const [servers, setServers] = useState<McpCatalogEntry[]>([]);
  const [connected, setConnected] = useState<Set<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [tokenFor, setTokenFor] = useState<McpCatalogEntry | null>(null);
  const [tokenInput, setTokenInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setServers(await Store.allServers());
    setConnected(new Set(await Store.connectedIds()));
  }

  useEffect(() => {
    if (visible) refresh();
  }, [visible]);

  async function finishConnect(server: McpCatalogEntry, token: string) {
    const r = await Client.connect(server, token);
    if (!r.ok) {
      setError(`${server.name}: ${r.error ?? "could not connect."}`);
      return;
    }
    await Store.setConnection(server.id, token);
    setTokenFor(null);
    setTokenInput("");
    setError(null);
    await refresh();
  }

  async function onConnect(server: McpCatalogEntry) {
    setError(null);
    if (server.auth === "none") {
      setBusyId(server.id);
      await finishConnect(server, "");
      setBusyId(null);
      return;
    }
    if (server.auth === "token") {
      setTokenFor(server);
      return;
    }
    // oauth: one-tap; fall back to token entry if the server won't do DCR.
    setBusyId(server.id);
    try {
      const token = await oauthConnect(server.url);
      await finishConnect(server, token);
    } catch (e) {
      setError(`${server.name}: ${String(e)}`);
      setTokenFor(server); // offer the token fallback
    } finally {
      setBusyId(null);
    }
  }

  async function onDisconnect(server: McpCatalogEntry) {
    await Store.disconnect(server.id);
    Client.disconnectClient(server.id);
    await refresh();
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>MCP servers</Text>
            <TouchableOpacity onPress={onClose} hitSlop={10}>
              <Text style={styles.close}>✕</Text>
            </TouchableOpacity>
          </View>
          {error ? <Text style={styles.error}>{error}</Text> : null}

          <ScrollView contentContainerStyle={styles.list}>
            {servers.map((s) => {
              const isOn = connected.has(s.id);
              const busy = busyId === s.id;
              return (
                <View key={s.id}>
                  <TouchableOpacity
                    style={styles.row}
                    onPress={() => (isOn ? onDisconnect(s) : onConnect(s))}
                    disabled={busy}
                  >
                    <Text style={styles.rowName}>{s.name}</Text>
                    {busy ? (
                      <ActivityIndicator size="small" color={theme.accent} />
                    ) : isOn ? (
                      <View style={[styles.badge, styles.badgeOn]}>
                        <Text style={styles.badgeOnText}>✓ Connected</Text>
                      </View>
                    ) : (
                      <View style={[styles.badge, s.auth === "none" ? styles.badgeConnect : styles.badgeAuth]}>
                        <Text style={s.auth === "none" ? styles.badgeConnectText : styles.badgeAuthText}>
                          {s.auth === "none" ? "Connect" : "⚠ Needs Auth"}
                        </Text>
                      </View>
                    )}
                  </TouchableOpacity>

                  {tokenFor?.id === s.id ? (
                    <View style={styles.tokenBox}>
                      <Text style={styles.tokenHint}>Paste an access token / API key for {s.name}:</Text>
                      <TextInput
                        style={styles.tokenInput}
                        value={tokenInput}
                        onChangeText={setTokenInput}
                        placeholder="token"
                        placeholderTextColor={theme.textDim}
                        autoCapitalize="none"
                        autoCorrect={false}
                        secureTextEntry
                      />
                      <View style={styles.tokenActions}>
                        <TouchableOpacity onPress={() => setTokenFor(null)}>
                          <Text style={styles.tokenCancel}>Cancel</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          onPress={async () => {
                            setBusyId(s.id);
                            await finishConnect(s, tokenInput.trim());
                            setBusyId(null);
                          }}
                          disabled={!tokenInput.trim()}
                        >
                          <Text style={[styles.tokenSave, !tokenInput.trim() && { opacity: 0.4 }]}>Connect</Text>
                        </TouchableOpacity>
                      </View>
                    </View>
                  ) : null}
                </View>
              );
            })}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: theme.bg,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    borderColor: theme.border,
    maxHeight: "85%",
    paddingBottom: 24,
  },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 18 },
  title: { color: theme.text, fontSize: 22, fontWeight: "800" },
  close: { color: theme.textDim, fontSize: 20 },
  error: { color: theme.danger, fontSize: 13, paddingHorizontal: 18, paddingBottom: 8 },
  list: { paddingHorizontal: 14, paddingBottom: 12 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 16,
    marginVertical: 5,
  },
  rowName: { color: theme.text, fontSize: 16, fontWeight: "600", flex: 1, marginRight: 10 },
  badge: { borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
  badgeOn: { backgroundColor: "#1f3a24" },
  badgeOnText: { color: theme.accent, fontWeight: "700", fontSize: 13 },
  badgeAuth: { backgroundColor: "#3a341f" },
  badgeAuthText: { color: "#e8c97a", fontWeight: "700", fontSize: 13 },
  badgeConnect: { borderWidth: 1, borderColor: theme.accent },
  badgeConnectText: { color: theme.accent, fontWeight: "700", fontSize: 13 },
  tokenBox: { backgroundColor: theme.surfaceAlt, borderRadius: 12, padding: 12, marginBottom: 6, marginTop: -2 },
  tokenHint: { color: theme.textDim, fontSize: 13, marginBottom: 8 },
  tokenInput: {
    color: theme.text,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  tokenActions: { flexDirection: "row", justifyContent: "flex-end", gap: 20, marginTop: 10 },
  tokenCancel: { color: theme.textDim, fontWeight: "600" },
  tokenSave: { color: theme.accent, fontWeight: "700" },
});
