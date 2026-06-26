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

// A Content "part". Gemini parts are a union: exactly one of these fields is set.
export interface Part {
  text?: string;
  functionCall?: FunctionCall;
  functionResponse?: FunctionResponse;
}

// One turn in the conversation. This is the exact wire shape Gemini expects in
// the `contents` array, so we store history in this format directly.
export interface Content {
  role: Role;
  parts: Part[];
}

// ---- Tool schema (Gemini function declarations) ----

export interface FunctionDeclaration {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
}

export interface Tool {
  functionDeclarations: FunctionDeclaration[];
}

// ---- UI-facing message model (a flattened view of Content for rendering) ----

export interface ChatMessage {
  id: string;
  role: Role;
  text: string;
}
