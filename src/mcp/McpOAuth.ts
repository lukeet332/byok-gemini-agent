// One-tap MCP OAuth (like Claude's connectors) — no domain required:
//   discover auth metadata -> dynamic client registration -> PKCE authorize in
//   the browser (redirect to fraude://oauth) -> exchange code for a token.
// Falls back with a clear error if a server won't do dynamic registration
// (then the user pastes a token instead).

import * as AuthSession from "expo-auth-session";
import * as WebBrowser from "expo-web-browser";

WebBrowser.maybeCompleteAuthSession();

function originOf(url: string): string {
  const m = url.match(/^(https?:\/\/[^/]+)/i);
  return m ? m[1] : url;
}

interface Endpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
}

async function discover(serverUrl: string): Promise<Endpoints> {
  const origin = originOf(serverUrl);
  let authServer = origin;
  // Protected-resource metadata points to the authorization server(s).
  try {
    const r = await fetch(`${origin}/.well-known/oauth-protected-resource`);
    if (r.ok) {
      const j = await r.json();
      if (Array.isArray(j.authorization_servers) && j.authorization_servers[0]) authServer = j.authorization_servers[0];
    }
  } catch {
    // ignore; fall back to the origin
  }
  const base = authServer.replace(/\/$/, "");
  for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"]) {
    try {
      const r = await fetch(base + path);
      if (r.ok) {
        const j = await r.json();
        if (j.authorization_endpoint && j.token_endpoint) {
          return {
            authorizationEndpoint: j.authorization_endpoint,
            tokenEndpoint: j.token_endpoint,
            registrationEndpoint: j.registration_endpoint,
          };
        }
      }
    } catch {
      // try next
    }
  }
  throw new Error("Could not discover this server's OAuth endpoints.");
}

async function registerClient(registrationEndpoint: string, redirectUri: string): Promise<string> {
  const res = await fetch(registrationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Fraude",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "native",
    }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.client_id) throw new Error(`Client registration failed (${res.status}).`);
  return j.client_id as string;
}

// Returns an access token, or throws (caller shows the error / offers token paste).
export async function oauthConnect(serverUrl: string): Promise<string> {
  const redirectUri = AuthSession.makeRedirectUri({ scheme: "fraude", path: "oauth" });
  const ep = await discover(serverUrl);
  if (!ep.registrationEndpoint) {
    throw new Error("This server needs manual setup (no dynamic registration). Paste a token instead.");
  }
  const clientId = await registerClient(ep.registrationEndpoint, redirectUri);
  const discovery = { authorizationEndpoint: ep.authorizationEndpoint, tokenEndpoint: ep.tokenEndpoint };

  const request = new AuthSession.AuthRequest({
    clientId,
    redirectUri,
    scopes: [],
    usePKCE: true,
    extraParams: { resource: serverUrl }, // RFC 8707 — bind the token to this MCP server
  });
  await request.makeAuthUrlAsync(discovery);
  const result = await request.promptAsync(discovery);
  if (result.type !== "success" || !result.params.code) throw new Error("Authorization was cancelled.");

  const token = await AuthSession.exchangeCodeAsync(
    {
      clientId,
      code: result.params.code,
      redirectUri,
      extraParams: { code_verifier: request.codeVerifier ?? "", resource: serverUrl },
    },
    discovery
  );
  if (!token.accessToken) throw new Error("Token exchange failed.");
  return token.accessToken;
}
