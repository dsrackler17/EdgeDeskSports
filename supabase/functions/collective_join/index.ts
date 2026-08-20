// Model Collective join API: the whole join flow is one link (Section 6).
// GET checks a token, POST redeems it after the magic-link sign-in, and the
// dead-token request route makes sure a lost creator is never dropped.

import { corsHeaders, json, err, preflight, subpath } from "../_shared/http.ts";
import { rpc, RpcError } from "../_shared/db.ts";
import { getUser } from "../_shared/auth.ts";
import { newApiKey, sha256hex } from "../_shared/keys.ts";
import { BASE_URL, SB_URL } from "../_shared/env.ts";
import { renderPrompt } from "../_shared/prompt_template.ts";
import { viewGet } from "../_shared/reads.ts";

const TOKEN_RE = /^mci_[A-Za-z0-9]{8,64}$/;

function embedSnippet(slug: string): string {
  return `<script src="${BASE_URL}/collective/embed.js" data-collective-host="${slug}" async></script>`;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  const path = subpath(req, "collective_join");

  // CONTRACT 5: join GETs answer any origin, join POSTs answer only the
  // Collective's own site (plus localhost for development).
  if (req.method === "POST") {
    const origin = req.headers.get("origin");
    if (origin) {
      let host = "";
      try { host = new URL(origin).hostname; } catch { host = ""; }
      const base = new URL(BASE_URL).hostname;
      const allowed = host === base || host === `www.${base}` || host === "localhost" || host === "127.0.0.1";
      if (!allowed) return err("forbidden_origin", "Join requests come from the Collective site only.", 403);
    }
  }

  try {
    let m = path.match(/^\/v1\/join\/([^/]+)$/);
    if (req.method === "GET" && m) {
      const raw = decodeURIComponent(m[1]);
      if (!TOKEN_RE.test(raw)) return err("token_invalid", "That invite code does not look right.", 404);
      const st = await rpc<{ ok: boolean; code?: string; status?: string; founding?: boolean; prefill?: unknown; expires_at?: string }>(
        "invite_status", { p_token_hash: await sha256hex(raw) });
      if (!st.ok) return err("token_invalid", "That invite does not exist.", 404);
      const body = {
        status: st.status, founding: st.founding ?? false,
        prefill: st.prefill ?? {}, expires_at: st.expires_at ?? null,
        request_url: "/v1/join/request",
      };
      if (st.status === "expired" || st.status === "spent" || st.status === "revoked") return json(body, 410);
      return json(body, 200, { "cache-control": "no-store" });
    }

    m = path.match(/^\/v1\/join\/([^/]+)\/redeem$/);
    if (req.method === "POST" && m) {
      const raw = decodeURIComponent(m[1]);
      if (!TOKEN_RE.test(raw)) return err("token_invalid", "That invite code does not look right.", 404);
      const user = await getUser(req);
      if (!user) return err("invalid_key", "Sign in with your magic link first.", 401);

      const body = await req.json().catch(() => null) as {
        display_name?: string; sport?: string; model_name?: string;
        description?: string | null; website_url?: string | null;
        x_handle?: string | null; logo_url?: string | null; accept_terms?: boolean;
        source_kind?: string | null; source_ref?: string | null;
      } | null;
      if (!body) return err("invalid_payload", "Body must be JSON.", 422);

      const problems: string[] = [];
      const name = (body.display_name ?? "").trim();
      const modelName = (body.model_name ?? "").trim();
      const sport = (body.sport ?? "").trim().toUpperCase();
      if (name.length < 2 || name.length > 60) problems.push("Display name must be 2 to 60 characters.");
      if (modelName.length < 2 || modelName.length > 60) problems.push("Model name must be 2 to 60 characters.");
      if (body.accept_terms !== true) problems.push("The terms checkbox is required.");
      const sports = await viewGet<{ code: string }>("sports", "select=code&active=is.true");
      if (!sports.some((s) => s.code === sport)) problems.push(`Sport must be one of: ${sports.map((s) => s.code).join(", ")}.`);
      const cleanUrl = (v: string | null | undefined): string | null => {
        const s = (v ?? "").trim();
        if (!s) return null;
        try {
          const u = new URL(s.startsWith("http") ? s : `https://${s}`);
          if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("bad");
          return u.toString();
        } catch {
          problems.push(`"${s}" is not a usable URL.`);
          return null;
        }
      };
      const website = cleanUrl(body.website_url);
      const logo = cleanUrl(body.logo_url);
      // Model source: optional forever; an unknown kind is dropped, not fatal.
      const srcKind = typeof body.source_kind === "string" &&
        ["excel", "github", "online", "other"].includes(body.source_kind) ? body.source_kind : null;
      const srcRef = (body.source_ref ?? "").toString().trim().slice(0, 300) || null;
      if (problems.length) return err("invalid_payload", problems.join(" "), 422, problems);

      const fresh = await newApiKey("live");
      const out = await rpc<{
        ok: boolean; code?: string; message?: string; already_issued?: boolean;
        creator_slug?: string; display_name?: string; founding?: boolean;
        model_slug?: string; model_name?: string; sport?: string;
      }>("redeem_invite", {
        p_token_hash: await sha256hex(raw),
        p_user_id: user.id,
        p_email: user.email,
        p_profile: {
          display_name: name, sport, model_name: modelName,
          description: (body.description ?? "").toString().trim() || null,
          website_url: website,
          x_handle: (body.x_handle ?? "").toString().trim().replace(/^@/, "") || null,
          logo_url: logo,
          source_kind: srcKind, source_ref: srcRef,
        },
        p_key_prefix: fresh.prefix,
        p_key_hash: fresh.hash,
      });

      if (!out.ok) {
        const status = out.code === "token_expired" || out.code === "token_spent" || out.code === "token_revoked" ? 410 : 404;
        return err(out.code ?? "token_invalid", out.message ?? "This invite cannot be used.", status);
      }

      const slug = out.creator_slug!;
      const prompt = renderPrompt({
        CREATOR_NAME: out.display_name ?? name,
        MODEL_NAME: out.model_name ?? modelName,
        SPORT: out.sport ?? sport,
        API_BASE: `${SB_URL}/functions/v1`,
        API_KEY: out.already_issued ? "(already issued: rotate from your dashboard to get a new one)" : fresh.raw,
        EMBED_SNIPPET: embedSnippet(slug),
        DASHBOARD_URL: `${BASE_URL}/collective/#dashboard`,
        DOCS_URL: `${BASE_URL}/collective/#rules`,
      });

      return json({
        creator: {
          slug, display_name: out.display_name,
          profile_url: `${BASE_URL}/collective/#/${slug}`,
        },
        model: { model_slug: out.model_slug, model_name: out.model_name, sport: out.sport },
        api_key: out.already_issued
          ? { key: null, prefix: null, shown_once: true, note: "already_issued" }
          : { key: fresh.raw, prefix: `mck_live_${fresh.prefix}`, shown_once: true },
        prompt,
        embed_snippet: embedSnippet(slug),
        dashboard_url: `${BASE_URL}/collective/#dashboard`,
        founding: out.founding ?? false,
      }, 200, { "cache-control": "no-store" });
    }

    if (req.method === "POST" && path === "/v1/join/request") {
      const body = await req.json().catch(() => null) as { email?: string; note?: string; token?: string } | null;
      const email = (body?.email ?? "").trim();
      if (!/.+@.+\..+/.test(email)) return err("invalid_payload", "A valid email is required.", 422);
      await rpc("join_request", {
        p_email: email.slice(0, 200),
        p_note: (body?.note ?? "").toString().slice(0, 500),
        p_token: (body?.token ?? "").toString(),
      });
      return json({ ok: true, message: "Request recorded. The founder reviews these and sends fresh links." });
    }

    return err("not_found", `No such route: ${req.method} ${path}`, 404);
  } catch (e) {
    if (e instanceof RpcError) console.error("collective_join rpc failure:", e.message, e.body);
    else console.error("collective_join failure:", e);
    return err("server_error", "Something went wrong on our side.", 500);
  }
});
