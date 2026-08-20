// Shared JWT auth. Bearer tokens are validated against Supabase Auth by
// calling /auth/v1/user; the JWT is never decoded locally, so revoked or
// expired sessions fail closed. Admin checks compare the user id against the
// admin.user_ids config list via the get_config RPC.

import { ANON_KEY, SB_URL } from "./env.ts";
import { rpc } from "./db.ts";
import { err } from "./http.ts";

export async function getUser(
  req: Request,
): Promise<{ id: string; email: string | null } | null> {
  const authz = req.headers.get("authorization") ?? "";
  if (!/^Bearer\s+\S+/i.test(authz)) return null;
  let res: Response;
  try {
    res = await fetch(`${SB_URL}/auth/v1/user`, {
      headers: {
        "apikey": ANON_KEY,
        "Authorization": authz,
      },
    });
  } catch (e) {
    console.error("auth.getUser: auth service unreachable:", e);
    return null;
  }
  if (!res.ok) return null;
  const user = await res.json().catch(() => null) as
    | { id?: string; email?: string | null }
    | null;
  if (!user || typeof user.id !== "string" || user.id.length === 0) return null;
  return { id: user.id, email: typeof user.email === "string" ? user.email : null };
}

// getUser plus membership of admin.user_ids. Returns the user, or an err()
// Response (401 invalid_key or 403 forbidden) ready to return to the caller.
export async function requireAdmin(
  req: Request,
): Promise<{ id: string; email: string | null } | Response> {
  const user = await getUser(req);
  if (!user) {
    return err("invalid_key", "A valid signed-in session is required.", 401);
  }
  const cfg = await rpc<unknown>("get_config", { p_key: "admin.user_ids" });
  const ids = Array.isArray(cfg) ? cfg.filter((v) => typeof v === "string") : [];
  if (!ids.includes(user.id)) {
    return err("forbidden", "This account is not an administrator.", 403);
  }
  return user;
}
