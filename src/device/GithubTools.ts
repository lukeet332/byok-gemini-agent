// GitHub coding backend — all via the REST/Git Data API with the user's PAT.
// No local clone: GitHub is the working copy. Reads are free; commits honour the
// user's write mode (branch+PR / branch / main) and are confirm-gated upstream.

import { applyPatch, parsePatch } from "diff";

import { getGithubToken, getWriteMode } from "../storage/SecureStorage";

const API = "https://api.github.com";
const MAX_FILE_CHARS = 16000;

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "Fraude",
  };
}

async function gh(token: string, method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(API + path, {
    method,
    headers: { ...authHeaders(token), "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${(json?.message ?? "request failed").toString().slice(0, 200)}`);
  return json;
}

// List a directory (or report a path is a file). Used to navigate a repo.
export async function listPath(repo: string, path = "", ref?: string): Promise<Record<string, unknown>> {
  const token = await getGithubToken();
  if (!token) return { ok: false, error: "No GitHub token. Add it in Settings." };
  try {
    const q = ref ? `?ref=${encodeURIComponent(ref)}` : "";
    const data = await gh(token, "GET", `/repos/${repo}/contents/${path}${q}`);
    if (Array.isArray(data)) {
      return { ok: true, type: "dir", entries: data.map((e: any) => ({ name: e.name, path: e.path, type: e.type })) };
    }
    return { ok: true, type: "file", path: data.path, note: "Use github_get_file to read it." };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// Read a file's text content (raw — no base64).
export async function getFile(repo: string, path: string, ref?: string): Promise<Record<string, unknown>> {
  const token = await getGithubToken();
  if (!token) return { ok: false, error: "No GitHub token. Add it in Settings." };
  try {
    const q = ref ? `?ref=${encodeURIComponent(ref)}` : "";
    const res = await fetch(`${API}/repos/${repo}/contents/${path}${q}`, {
      headers: { ...authHeaders(token), Accept: "application/vnd.github.raw" },
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      return { ok: false, error: `GitHub ${res.status}: ${(j?.message ?? "").toString().slice(0, 160)}` };
    }
    const text = await res.text();
    const truncated = text.length > MAX_FILE_CHARS;
    return { ok: true, repo, path, content: truncated ? text.slice(0, MAX_FILE_CHARS) + "\n...[truncated]" : text };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function searchCode(query: string, repo?: string): Promise<Record<string, unknown>> {
  const token = await getGithubToken();
  if (!token) return { ok: false, error: "No GitHub token. Add it in Settings." };
  try {
    const q = encodeURIComponent(repo ? `${query} repo:${repo}` : query);
    const data = await gh(token, "GET", `/search/code?q=${q}&per_page=15`);
    const items = (data.items ?? []).map((i: any) => ({ repo: i.repository?.full_name, path: i.path, url: i.html_url }));
    return { ok: true, count: items.length, items };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export interface FileChange {
  path: string;
  content: string;
}

// Fetch a file's FULL raw content (no truncation — needed for patching).
async function fetchRaw(token: string, repo: string, path: string, ref?: string): Promise<string | null> {
  const q = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  const res = await fetch(`${API}/repos/${repo}/contents/${path}${q}`, {
    headers: { ...authHeaders(token), Accept: "application/vnd.github.raw" },
  });
  if (!res.ok) return null;
  return res.text();
}

// Surgical edit: apply a unified git diff (possibly multi-file) IN-APP and commit
// the result. Works for everyone (no Termux/local clone). Fetches each file's
// current content, applies the hunks with jsdiff, and commits via commitChangeset.
export async function applyPatchAndCommit(
  repo: string,
  message: string,
  diff: string,
  opts: { branch?: string } = {}
): Promise<Record<string, unknown>> {
  const token = await getGithubToken();
  if (!token) return { ok: false, error: "No GitHub token. Add it in Settings." };
  if (!repo || !message || !diff?.trim()) return { ok: false, error: "Need repo, message, and a unified diff." };

  let patches: ReturnType<typeof parsePatch>;
  try {
    patches = parsePatch(diff);
  } catch (e) {
    return { ok: false, error: `Couldn't parse the diff: ${String(e)}` };
  }
  if (!patches.length) return { ok: false, error: "No file patches found in the diff." };

  const files: FileChange[] = [];
  const failed: string[] = [];
  for (const p of patches) {
    const rawName =
      p.newFileName && p.newFileName !== "/dev/null" ? p.newFileName : p.oldFileName ?? "";
    const path = rawName.replace(/^[ab]\//, "").replace(/^\/+/, "").trim();
    if (!path) {
      failed.push("(unknown path)");
      continue;
    }
    try {
      const isNew = p.oldFileName === "/dev/null";
      const current = isNew ? "" : (await fetchRaw(token, repo, path)) ?? "";
      // A little fuzz tolerates minor context drift; false = hunks didn't match.
      const patched = applyPatch(current, p, { fuzzFactor: 2 });
      if (patched === false) {
        failed.push(path);
        continue;
      }
      files.push({ path, content: patched });
    } catch (e) {
      failed.push(`${path} (${String(e)})`);
    }
  }

  if (!files.length) {
    return {
      ok: false,
      error: `The patch didn't apply (files: ${failed.join(", ") || "none"}). Re-read the current file(s) with github_get_file and regenerate the diff against their exact contents.`,
    };
  }

  const result = await commitChangeset(repo, message, files, opts);
  if (result.ok && failed.length) {
    (result as Record<string, unknown>).warning = `Committed ${files.length} file(s); these hunks did NOT apply: ${failed.join(", ")}`;
  }
  return result;
}

// Commit a set of files in ONE commit via the Git Data API, honouring write mode.
export async function commitChangeset(
  repo: string,
  message: string,
  files: FileChange[],
  opts: { branch?: string } = {}
): Promise<Record<string, unknown>> {
  const token = await getGithubToken();
  if (!token) return { ok: false, error: "No GitHub token. Add it in Settings." };
  if (!repo || !message || !files?.length) return { ok: false, error: "Need repo, message, and at least one file." };
  try {
    const mode = await getWriteMode();
    const info = await gh(token, "GET", `/repos/${repo}`);
    const base: string = info.default_branch;
    const baseRef = await gh(token, "GET", `/repos/${repo}/git/ref/heads/${base}`);
    const headSha: string = baseRef.object.sha;

    let target: string;
    if (mode === "main") target = base;
    else if (mode === "branch") target = opts.branch || "fraude/edits";
    else target = `fraude/${Date.now()}`;

    // Ensure the target branch exists (create from base head if new).
    let parentSha = headSha;
    if (target !== base) {
      try {
        const tRef = await gh(token, "GET", `/repos/${repo}/git/ref/heads/${target}`);
        parentSha = tRef.object.sha;
      } catch {
        await gh(token, "POST", `/repos/${repo}/git/refs`, { ref: `refs/heads/${target}`, sha: headSha });
        parentSha = headSha;
      }
    }
    const parentCommit = await gh(token, "GET", `/repos/${repo}/git/commits/${parentSha}`);
    const baseTree: string = parentCommit.tree.sha;

    const tree = [];
    for (const f of files) {
      const blob = await gh(token, "POST", `/repos/${repo}/git/blobs`, { content: f.content, encoding: "utf-8" });
      tree.push({ path: f.path, mode: "100644", type: "blob", sha: blob.sha });
    }
    const newTree = await gh(token, "POST", `/repos/${repo}/git/trees`, { base_tree: baseTree, tree });
    const commit = await gh(token, "POST", `/repos/${repo}/git/commits`, {
      message,
      tree: newTree.sha,
      parents: [parentSha],
    });
    await gh(token, "PATCH", `/repos/${repo}/git/refs/heads/${target}`, { sha: commit.sha });

    let prUrl: string | undefined;
    if (mode === "pr") {
      try {
        const pr = await gh(token, "POST", `/repos/${repo}/pulls`, {
          title: message.split("\n")[0].slice(0, 72),
          head: target,
          base,
          body: "Opened by Fraude.",
        });
        prUrl = pr.html_url;
      } catch (e) {
        prUrl = `(branch ${target} pushed, but opening the PR failed: ${String(e)})`;
      }
    }
    return {
      ok: true,
      mode,
      branch: target,
      files: files.length,
      commit: commit.sha.slice(0, 7),
      commitUrl: `https://github.com/${repo}/commit/${commit.sha}`,
      ...(prUrl ? { pullRequest: prUrl } : {}),
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
