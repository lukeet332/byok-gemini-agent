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
}

export const MCP_CATALOG: McpCatalogEntry[] = [
  { id: "deepwiki", name: "DeepWiki (public docs)", url: "https://mcp.deepwiki.com/mcp", auth: "none" },
  { id: "huggingface", name: "Hugging Face", url: "https://huggingface.co/mcp", auth: "token" },
  { id: "github", name: "GitHub", url: "https://api.githubcopilot.com/mcp/", auth: "token" },
  { id: "linear", name: "Linear", url: "https://mcp.linear.app/sse", auth: "oauth" },
  { id: "notion", name: "Notion", url: "https://mcp.notion.com/mcp", auth: "oauth" },
  { id: "sentry", name: "Sentry", url: "https://mcp.sentry.dev/mcp", auth: "oauth" },
  { id: "stripe", name: "Stripe", url: "https://mcp.stripe.com", auth: "token" },
  { id: "atlassian", name: "Atlassian", url: "https://mcp.atlassian.com/v1/sse", auth: "oauth" },
];
