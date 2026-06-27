// Minimal MCP client over Streamable HTTP (JSON-RPC). Connects to remote MCP
// servers, lists their tools, and calls them. Tool names are namespaced
// mcp__<serverId>__<tool> so the agent can route calls back here.

import { FunctionDeclaration, ParamSchema } from "../types";
import * as Store from "./McpStore";

const PROTOCOL = "2025-06-18";

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}
interface Conn {
  url: string;
  token: string;
  sessionId?: string;
  tools: McpTool[];
}

const conns = new Map<string, Conn>();
let rpcId = 0;

// Responses may be plain JSON or an SSE stream ("data: {...}"). Get the JSON-RPC payload.
function parseRpc(text: string): any {
  const t = text.trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      return JSON.parse(t);
    } catch {
      return null;
    }
  }
  const datas = t.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
  for (let i = datas.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(datas[i]);
    } catch {
      // try previous
    }
  }
  return null;
}

async function rpc(conn: Conn, method: string, params?: unknown, notification = false): Promise<any> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": PROTOCOL,
  };
  if (conn.token) headers.Authorization = `Bearer ${conn.token}`;
  if (conn.sessionId) headers["Mcp-Session-Id"] = conn.sessionId;
  const payload: Record<string, unknown> = { jsonrpc: "2.0", method };
  if (!notification) payload.id = ++rpcId;
  if (params !== undefined) payload.params = params;

  const res = await fetch(conn.url, { method: "POST", headers, body: JSON.stringify(payload) });
  const sid = res.headers.get("mcp-session-id");
  if (sid) conn.sessionId = sid;
  if (notification) return null;
  const text = await res.text();
  if (res.status === 401) throw new Error("Unauthorized — the connection needs (re)authorising.");
  if (!res.ok) throw new Error(`MCP ${method} failed (${res.status}): ${text.slice(0, 160)}`);
  const json = parseRpc(text);
  if (json?.error) throw new Error(`MCP error: ${json.error.message ?? JSON.stringify(json.error)}`);
  return json?.result;
}

// Connect + cache a server's tools. Returns {ok,...}; never throws.
export async function connect(
  server: { id: string; url: string },
  token: string
): Promise<{ ok: boolean; error?: string; toolCount?: number }> {
  const conn: Conn = { url: server.url, token, tools: [] };
  try {
    await rpc(conn, "initialize", {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: "Fraude", version: "1.0.0" },
    });
    await rpc(conn, "notifications/initialized", undefined, true);
    const res = await rpc(conn, "tools/list", {});
    conn.tools = Array.isArray(res?.tools) ? res.tools : [];
    conns.set(server.id, conn);
    return { ok: true, toolCount: conn.tools.length };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export function disconnectClient(id: string): void {
  conns.delete(id);
}

// Reconnect any saved-but-not-live connections (called before a turn).
export async function ensureConnections(): Promise<void> {
  const ids = await Store.connectedIds();
  if (!ids.length) return;
  const servers = await Store.allServers();
  for (const id of ids) {
    if (conns.has(id)) continue;
    const s = servers.find((x) => x.id === id);
    if (!s) continue;
    await connect(s, (await Store.getToken(id)) ?? "");
  }
}

function sanitizeSchema(s: any): ParamSchema {
  if (!s || typeof s !== "object" || s.type !== "object") return { type: "object", properties: {} };
  return {
    type: "object",
    properties: (s.properties as Record<string, ParamSchema>) ?? {},
    ...(Array.isArray(s.required) ? { required: s.required } : {}),
  };
}

// Gemini function declarations for all connected MCP tools.
export function getMcpToolDeclarations(): FunctionDeclaration[] {
  const decls: FunctionDeclaration[] = [];
  for (const [id, conn] of conns) {
    for (const t of conn.tools) {
      decls.push({
        name: `mcp__${id}__${t.name}`,
        description: `[${id} MCP] ${(t.description ?? "").slice(0, 280)}`,
        parameters: sanitizeSchema(t.inputSchema),
      });
    }
  }
  return decls;
}

export function isMcpTool(name: string): boolean {
  return name.startsWith("mcp__");
}

export async function callMcpTool(fullName: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const parts = fullName.split("__");
  const id = parts[1];
  const tool = parts.slice(2).join("__");
  const conn = conns.get(id);
  if (!conn) return { ok: false, error: `MCP server '${id}' is not connected.` };
  try {
    const res = await rpc(conn, "tools/call", { name: tool, arguments: args });
    const content = Array.isArray(res?.content)
      ? res.content.map((c: any) => (typeof c?.text === "string" ? c.text : JSON.stringify(c))).join("\n")
      : JSON.stringify(res ?? {});
    return { ok: !res?.isError, content: content.slice(0, 12000) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
