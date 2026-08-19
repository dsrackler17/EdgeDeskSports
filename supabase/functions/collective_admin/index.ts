// Model Collective admin API: the founder console's backend. Every route
// requires a signed-in account on the admin.user_ids config list. Minting
// an invite returns the raw link exactly once.

import { json, err, preflight, subpath } from "../_shared/http.ts";
import { rpc, RpcError } from "../_shared/db.ts";
import { requireAdmin } from "../_shared/auth.ts";
import { newInviteToken } from "../_shared/keys.ts";
import { BASE_URL } from "../_shared/env.ts";
import { tableWrite, viewGet } from "../_shared/reads.ts";

const NO_STORE = { "cache-control": "no-store" };

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  const path = subpath(req, "collective_admin");

  try {
    const admin = await requireAdmin(req);
    if (admin instanceof Response) return admin;

    if (path === "/v1/admin/invites" && req.method === "POST") {
      const body = await req.json().catch(() => null) as {
        prefill?: Record<string, unknown>; founding?: boolean; share_bps?: number | null;
        max_uses?: number; note?: string;
      } | null;
      if (!body) return err("invalid_payload", "Body must be JSON.", 422);
      const t = await newInviteToken();
      const out = await rpc<{ ok: boolean; code?: string; message?: string; expires_at?: string }>(
        "mint_invite", {
          p_admin: admin.id,
          p_prefill: body.prefill ?? {},
          p_founding: body.founding === true,
          p_share_bps: typeof body.share_bps === "number" ? body.share_bps : null,
          p_max_uses: typeof body.max_uses === "number" ? body.max_uses : 1,
          p_note: (body.note ?? "").toString().slice(0, 300),
          p_token_hash: t.hash,
          p_token_prefix: t.prefix,
        });
      if (!out.ok) return err(out.code ?? "server_error", out.message ?? "Mint failed.", out.code === "forbidden" ? 403 : 500);
      return json({
        invite_url: `${BASE_URL}/join/${t.raw}`,
        token: t.raw, expires_at: out.expires_at, shown_once: true,
      }, 200, NO_STORE);
    }

    if (path === "/v1/admin/invites" && req.method === "GET") {
      interface Row {
        id: string; token_prefix: string; note: string | null; founding_member: boolean;
        max_uses: number; use_count: number; expires_at: string; created_at: string;
      }
      const rows = await viewGet<Row>("invite_tokens",
        "select=id,token_prefix,note,founding_member,max_uses,use_count,expires_at,created_at&order=created_at.desc&limit=200");
      const now = new Date().toISOString();
      return json({
        rows: rows.map((r) => ({
          id: r.id, prefix: `mci_${r.token_prefix}`, note: r.note, founding: r.founding_member,
          max_uses: r.max_uses, use_count: r.use_count, expires_at: r.expires_at,
          status: r.use_count >= r.max_uses ? "spent" : (r.expires_at < now ? "expired" : "active"),
          created_at: r.created_at,
        })),
      }, 200, NO_STORE);
    }

    if (path === "/v1/admin/members" && req.method === "GET") {
      interface WallRow {
        creator_id: string; creator_slug: string; creator_name: string; membership: string;
        founding: boolean; model_name: string; last_submission_at: string | null;
      }
      interface CreatorRow {
        id: string; slug: string; referral_share_bps: number; billing_mode: string; created_at: string;
      }
      const [wall, creators, keys, installs] = await Promise.all([
        viewGet<WallRow>("model_wall", "select=creator_id,creator_slug,creator_name,membership,founding,model_name,last_submission_at"),
        viewGet<CreatorRow>("creators", "select=id,slug,referral_share_bps,billing_mode,created_at&order=created_at.asc"),
        viewGet<{ creator_id: string; key_prefix: string; kind: string; status: string }>(
          "api_keys", "select=creator_id,key_prefix,kind,status"),
        viewGet<{ creator_id: string; origin: string }>("embed_installs", "select=creator_id,origin&status=eq.active"),
      ]);
      return json({
        rows: creators.map((c) => {
          const mine = wall.filter((w) => w.creator_id === c.id);
          return {
            creator_slug: c.slug,
            display_name: mine[0]?.creator_name ?? c.slug,
            membership: mine[0]?.membership ?? "MEMBER",
            founding: mine[0]?.founding ?? false,
            referral_share_bps: c.referral_share_bps,
            billing_mode: c.billing_mode,
            models: mine.map((w) => w.model_name),
            key_prefixes: keys.filter((k) => k.creator_id === c.id && k.status === "active")
              .map((k) => `mck_${k.kind}_${k.key_prefix}`),
            origins: installs.filter((i) => i.creator_id === c.id).map((i) => i.origin),
            joined_at: c.created_at,
            last_submission_at: mine.map((w) => w.last_submission_at).filter(Boolean).sort().pop() ?? null,
          };
        }),
      }, 200, NO_STORE);
    }

    if (path === "/v1/admin/quarantine" && req.method === "GET") {
      const rows = await viewGet("quarantine_queue", "select=*&limit=200");
      return json({ rows }, 200, NO_STORE);
    }

    let m = path.match(/^\/v1\/admin\/quarantine\/([0-9a-f-]+)\/resolve$/);
    if (m && req.method === "POST") {
      const body = await req.json().catch(() => null) as {
        game_id?: string; alias?: { sport?: string; alias?: string; team_code?: string };
      } | null;
      if (!body) return err("invalid_payload", "Body must be JSON.", 422);
      if (typeof body.game_id === "string" && body.game_id) {
        const out = await rpc<{ ok: boolean; code?: string; message?: string; resolved?: number }>(
          "admin_resolve_quarantine", { p_projection_id: m[1], p_game_id: body.game_id });
        if (!out.ok) return err(out.code ?? "not_found", out.message ?? "Could not resolve.", 404);
        return json({ ok: true, resolved: out.resolved ?? 1 }, 200, NO_STORE);
      }
      if (body.alias && body.alias.alias && body.alias.team_code) {
        const sport = (body.alias.sport ?? "NFL").toUpperCase();
        const code = body.alias.team_code.toUpperCase();
        if (!/^[A-Z0-9]{2,10}$/.test(sport) || !/^[A-Z0-9]{2,5}$/.test(code)) {
          return err("invalid_payload", "Sport and team code look wrong.", 422);
        }
        const teams = await viewGet<{ id: string }>(
          "teams", `select=id&sport_code=eq.${sport}&code=eq.${code}&limit=1`);
        if (!teams[0]) return err("not_found", "No team with that code.", 404);
        await tableWrite("team_aliases", "POST", "", {
          sport_code: sport, alias: body.alias.alias.trim(), team_id: teams[0].id,
        }).catch(() => { /* alias may already exist; the re-resolve still runs */ });
        const out = await rpc<{ ok: boolean; resolved?: number }>("admin_reresolve", { p_sport: sport });
        return json({ ok: true, resolved: out.resolved ?? 0 }, 200, NO_STORE);
      }
      return err("invalid_payload", "Pass game_id or alias.", 422);
    }

    if (path === "/v1/admin/games" && req.method === "POST") {
      const body = await req.json().catch(() => null);
      if (!body) return err("invalid_payload", "Body must be JSON.", 422);
      const out = await rpc<{ ok: boolean; code?: string; message?: string; upserted?: number; failed?: unknown[] }>(
        "upsert_games", { p_admin: admin.id, p_payload: body });
      if (!out.ok) return err(out.code ?? "invalid_payload", out.message ?? "Upsert failed.", out.code === "forbidden" ? 403 : 422);
      return json({ ok: true, upserted: out.upserted ?? 0, failed: out.failed ?? [] }, 200, NO_STORE);
    }

    if (path === "/v1/admin/results" && req.method === "POST") {
      const body = await req.json().catch(() => null) as { results?: Record<string, unknown>[] } | null;
      if (!body || !Array.isArray(body.results)) return err("invalid_payload", "Pass a results array.", 422);
      let settled = 0, graded = 0;
      const failures: unknown[] = [];
      for (const r of body.results.slice(0, 100)) {
        const out = await rpc<{ ok: boolean; message?: string; graded?: number }>(
          "settle_game", { p_admin: admin.id, p_game_id: r.game_id, p_result: r });
        if (out.ok) { settled++; graded += out.graded ?? 0; }
        else failures.push({ game_id: r.game_id, message: out.message });
      }
      return json({ ok: failures.length === 0, settled, graded, failures }, 200, NO_STORE);
    }

    if (path === "/v1/admin/earnings" && req.method === "GET") {
      interface Row {
        creator_slug: string; period_month: string; earned_cents: number | null;
        clawed_cents: number | null; paid_cents: number | null;
        balance_cents: number | null; available_cents: number | null;
      }
      const rows = await viewGet<Row>("creator_earnings_monthly", "select=*&order=period_month.desc");
      return json({
        rows: rows.map((r) => ({
          creator_slug: r.creator_slug, month: r.period_month?.slice(0, 7),
          earned_cents: r.earned_cents ?? 0, clawed_cents: r.clawed_cents ?? 0,
          paid_cents: r.paid_cents ?? 0, balance_cents: r.balance_cents ?? 0,
          available_cents: r.available_cents ?? 0,
        })),
      }, 200, NO_STORE);
    }

    return err("not_found", `No such route: ${req.method} ${path}`, 404);
  } catch (e) {
    if (e instanceof RpcError) console.error("collective_admin rpc failure:", e.message, e.body);
    else console.error("collective_admin failure:", e);
    return err("server_error", "Something went wrong on our side.", 500);
  }
});
