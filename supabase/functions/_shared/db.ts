// Shared database access. Edge functions never talk SQL: they call the
// SECURITY DEFINER RPCs in the collective schema through PostgREST with the
// service role key. RPCs return jsonb outcome objects like { ok: true, ... }
// or { ok: false, code: "token_expired", message: "..." }; callers translate
// ok:false codes to the HTTP error taxonomy. RpcError means an unexpected
// database failure and maps to 500 server_error (log it, never leak the body).

import { SB_URL, SERVICE_KEY } from "./env.ts";

export class RpcError extends Error {
  status: number;
  body: string;

  constructor(fn: string, status: number, body: string) {
    super(`rpc ${fn} failed with status ${status}`);
    this.name = "RpcError";
    this.status = status;
    this.body = body;
  }
}

export async function rpc<T = unknown>(
  fn: string,
  args: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      "apikey": SERVICE_KEY,
      "Authorization": `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      "Content-Profile": "collective",
    },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new RpcError(fn, res.status, text);
  }
  if (text === "") {
    return null as T;
  }
  return JSON.parse(text) as T;
}
