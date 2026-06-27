// Curated list of popular *remote* (Streamable HTTP / SSE) MCP servers — the kind
// a phone can reach over the network. URLs/auth vary by provider and may need
// updating; users can also add a custom server. (stdio/local servers can't run
// in a sandboxed app, so they're intentionally not here.)

export type McpAuth = "none" | "token" | "oauth";

export interface McpCatalogEntry {
  id: string;
  name: string;
  url: string;
  auth: McpAuth;
  // Self-hosted: no shared URL. Tapping pre-fills the Add form + shows setupUrl.
  selfHost?: boolean;
  setupUrl?: string;
}

// Curated for mobile: high-value, hosted (no self-host), genuinely useful on a
// phone. (Native GitHub tools already cover GitHub, so no GitHub MCP here.)
// Aggregators with per-user URLs — Zapier, Pipedream, Composio — are best added
// via the custom-server form. URLs are best-effort and may need updating.
export const MCP_CATALOG: McpCatalogEntry[] = [
  { id: "context7", name: "Context7 — live docs", url: "https://mcp.context7.com/mcp", auth: "none" },
  { id: "deepwiki", name: "DeepWiki — repo Q&A", url: "https://mcp.deepwiki.com/mcp", auth: "none" },
  { id: "notion", name: "Notion", url: "https://mcp.notion.com/mcp", auth: "oauth" },
  { id: "linear", name: "Linear", url: "https://mcp.linear.app/mcp", auth: "oauth" },
  { id: "sentry", name: "Sentry", url: "https://mcp.sentry.dev/mcp", auth: "oauth" },
  { id: "atlassian", name: "Atlassian — Jira/Confluence", url: "https://mcp.atlassian.com/v1/sse", auth: "oauth" },
  { id: "stripe", name: "Stripe", url: "https://mcp.stripe.com", auth: "token" },
  { id: "huggingface", name: "Hugging Face", url: "https://huggingface.co/mcp", auth: "token" },
  {
    id: "google-workspace",
    name: "Google Workspace (self-host)",
    url: "",
    auth: "oauth",
    selfHost: true,
    setupUrl: "https://github.com/taylorwilsdon/google_workspace_mcp",
  },
];
