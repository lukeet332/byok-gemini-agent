// Shared types modelling the Gemini generateContent request/response shapes.
// Kept minimal and hand-rolled so we never pull in a node-dependent SDK.

export type Role = "user" | "model";

// A single function call emitted by the model.
export interface FunctionCall {
  name: string;
  args: Record<string, unknown>;
}

// Our reply to a function call, fed back to the model on the next turn.
export interface FunctionResponse {
  name: string;
  response: Record<string, unknown>;
}

// Inline binary data (e.g. an image) sent to the model, base64-encoded.
export interface InlineData {
  mimeType: string;
  data: string; // base64
}

// A Content "part". Gemini parts are a union: exactly one of these fields is set.
export interface Part {
  text?: string;
  functionCall?: FunctionCall;
  functionResponse?: FunctionResponse;
  inlineData?: InlineData;
  // Gemini 2.5 attaches an opaque thought signature to function-call (and some
  // text) parts; it MUST be echoed back verbatim on the next request or tool
  // use breaks ("Function call is missing a thought_signature").
  thoughtSignature?: string;
}

// One turn in the conversation. This is the exact wire shape Gemini expects in
// the `contents` array, so we store history in this format directly.
export interface Content {
  role: Role;
  parts: Part[];
}

// ---- Tool schema (Gemini function declarations) ----

// A (recursive) JSON-schema-ish node for tool parameters — supports objects,
// arrays (items), and nested properties.
export interface ParamSchema {
  type: string;
  description?: string;
  items?: ParamSchema;
  properties?: Record<string, ParamSchema>;
  required?: string[];
}

export interface FunctionDeclaration {
  name: string;
  description: string;
  parameters: ParamSchema;
}

export interface Tool {
  functionDeclarations: FunctionDeclaration[];
}

// ---- UI-facing message model (a flattened view of Content for rendering) ----

export interface ChatMessage {
  id: string;
  role: Role;
  text: string;
  // A tappable system notice (e.g. rate-limit prompt that opens Settings).
  action?: "open_settings";
  // Marks a server-error notice that offers a manual retry control.
  canRetry?: boolean;
  // Optional attached image to show in the bubble (local uri or data: uri).
  imageUri?: string;
  // Optional attached non-image file name to show as a chip in the bubble.
  attachName?: string;
}

// ---- Threads (locally persisted conversations) ----

// Lightweight entry for the thread list (no heavy history).
export interface ThreadMeta {
  id: string;
  title: string;
  updatedAt: number;
}

// A full conversation thread, persisted on-device as JSON.
// `memo` is a dense, AI-only summary of older turns (compacted context);
// `contents` holds the recent verbatim turns kept for the model.
export interface Thread extends ThreadMeta {
  createdAt: number;
  memo: string;
  contents: Content[];
}
