// Bridge between the (plain-module) agent and the React <HiddenBrowser> component.
// The component registers its imperative implementation here on mount; the agent
// calls these methods to drive a real, hidden WebView for JS-rendered browsing.

export interface PageResult {
  ok: boolean;
  url: string;
  title?: string;
  text?: string;
  error?: string;
}

export interface SearchResult {
  ok: boolean;
  query: string;
  results?: { title: string; url: string; snippet: string }[];
  error?: string;
}

export interface BrowserImpl {
  fetchPage(url: string, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<PageResult>;
  search(query: string, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<SearchResult>;
}

let impl: BrowserImpl | null = null;

export const BrowserEngine = {
  register(i: BrowserImpl | null) {
    impl = i;
  },
  isReady(): boolean {
    return impl !== null;
  },
  fetchPage(url: string, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<PageResult> {
    if (!impl) return Promise.resolve({ ok: false, url, error: "Browser engine not ready." });
    return impl.fetchPage(url, opts);
  },
  search(query: string, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<SearchResult> {
    if (!impl) return Promise.resolve({ ok: false, query, error: "Browser engine not ready." });
    return impl.search(query, opts);
  },
};
