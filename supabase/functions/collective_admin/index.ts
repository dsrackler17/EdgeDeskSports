// Model Collective admin API: the founder console's backend. Every route
// requires a signed-in account on the admin.user_ids config list. Minting
// an invite returns the raw link exactly once.

import { json, err, preflight, subpath } from "../_shared/http.ts";
import { rpc, RpcError } from "../_shared/db.ts";
import { requireAdmin } from "../_shared/auth.ts";
import { newInviteToken } from "../_shared/keys.ts";
import { BASE_URL } from "../_shared/env.ts";
import { tableWrite, viewCount, viewGet } from "../_shared/reads.ts";

const NO_STORE = { "cache-control": "no-store" };
const SOURCE_KINDS = ["excel", "github", "online", "other"];

async function cfgInt(key: string, fallback: number): Promise<number> {
  const v = await rpc<unknown>("get_config", { p_key: key });
  if (v === null || v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// Start of "today" on the Collective's home clock (America/Chicago). Two-pass
// offset lookup so the answer is exact even on DST transition days: first get
// CT midnight using the current offset, then re-derive the offset as of that
// midnight and recompute.
function ctDayStartIso(): string {
  try {
    const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
    const offAt = (d: Date) => {
      const name = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", timeZoneName: "longOffset" })
        .formatToParts(d).find((x) => x.type === "timeZoneName")?.value ?? "GMT-06:00";
      const o = name.replace("GMT", "");
      return /^[+-]\d{2}:\d{2}$/.test(o) ? o : "-06:00";
    };
    let guess = new Date(`${ymd}T00:00:00${offAt(new Date())}`);
    guess = new Date(`${ymd}T00:00:00${offAt(guess)}`);
    if (Number.isNaN(guess.getTime())) throw new Error("bad date");
    return guess.toISOString();
  } catch {
    return new Date(Date.now() - 24 * 3600e3).toISOString();
  }
}

function inviteMessage(url: string, name: string): string {
  return `You're invited to the Model Collective.

Open this link to set up your profile and model (it takes about a minute):
${url}

You sign in with your email (no password), confirm your name and your model, and say where the model lives (spreadsheet, GitHub, or hosted). After that your dashboard handles everything: post a slate by uploading your spreadsheet, and the Collective grades your record independently.

The link is personal to you${name ? `, ${name}` : ""}, works once, and expires in 30 days.`;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  const path = subpath(req, "collective_admin");

  try {
    const admin = await requireAdmin(req);
    if (admin instanceof Response) return admin;

    // One action mints the whole onboarding package: token, URL, prefill
    // (name, model, source), founding status, expiry. Provisioning of the
    // account, profile, model, key, prompt, and embed happens automatically
    // when the creator completes onboarding through the link.
    if (path === "/v1/admin/invites" && req.method === "POST") {
      const body = await req.json().catch(() => null) as {
        display_name?: string; email?: string; model_name?: string;
        source_kind?: string; source_ref?: string; founding?: boolean;
        prefill?: Record<string, unknown>; max_uses?: number; note?: string;
      } | null;
      if (!body) return err("invalid_payload", "Body must be JSON.", 422);
      const name = (body.display_name ?? "").toString().trim();
      let prefill: Record<string, unknown>;
      if (name) {
        if (name.length < 2 || name.length > 60) {
          return err("invalid_payload", "Name must be 2 to 60 characters.", 422);
        }
        const email = (body.email ?? "").toString().trim().slice(0, 120);
        if (email && !/.+@.+\..+/.test(email)) {
          return err("invalid_payload", `"${email}" does not look like an email address.`, 422);
        }
        prefill = {
          display_name: name,
          model_name: (body.model_name ?? "").toString().trim().slice(0, 60) || null,
          email: email || null,
          source_kind: SOURCE_KINDS.includes(body.source_kind ?? "") ? body.source_kind : null,
          source_ref: (body.source_ref ?? "").toString().trim().slice(0, 300) || null,
        };
      } else if (body.prefill && typeof body.prefill === "object") {
        // older client shape, still honored
        prefill = body.prefill;
      } else {
        return err("invalid_payload", "A name is required to mint an invite.", 422);
      }
      const t = await newInviteToken();
      const out = await rpc<{ ok: boolean; code?: string; message?: string; expires_at?: string; invite_id?: string }>(
        "mint_invite", {
          p_admin: admin.id,
          p_prefill: prefill,
          p_founding: body.founding === true,
          p_share_bps: null,
          p_max_uses: typeof body.max_uses === "number" ? body.max_uses : 1,
          p_note: (body.note ?? prefill.email ?? "").toString().slice(0, 300),
          p_token_hash: t.hash,
          p_token_prefix: t.prefix,
        });
      if (!out.ok) return err(out.code ?? "server_error", out.message ?? "Mint failed.", out.code === "forbidden" ? 403 : 500);
      const url = `${BASE_URL}/join/${t.raw}`;
      return json({
        invite_id: out.invite_id ?? null,
        invite_url: url,
        token: t.raw, expires_at: out.expires_at, shown_once: true,
        invite: {
          display_name: (prefill.display_name as string) ?? null,
          model_name: (prefill.model_name as string) ?? null,
          email: (prefill.email as string) ?? null,
          source_kind: (prefill.source_kind as string) ?? null,
          founding: body.founding === true,
        },
        message: inviteMessage(url, (prefill.display_name as string) ?? ""),
      }, 200, NO_STORE);
    }

    if (path === "/v1/admin/invites" && req.method === "GET") {
      interface Row {
        id: string; token_prefix: string; note: string | null; founding_member: boolean;
        max_uses: number; use_count: number; expires_at: string; created_at: string;
        revoked_at: string | null; prefill: Record<string, unknown> | null;
      }
      const rows = await viewGet<Row>("invite_tokens",
        "select=id,token_prefix,note,founding_member,max_uses,use_count,expires_at,created_at,revoked_at,prefill&order=created_at.desc&limit=200");
      const now = new Date().toISOString();
      return json({
        rows: rows.map((r) => {
          const p = r.prefill ?? {};
          return {
            id: r.id,
            display_name: (p.display_name as string) ?? null,
            model_name: (p.model_name as string) ?? null,
            email: (p.email as string) ?? null,
            source_kind: (p.source_kind as string) ?? null,
            note: r.note, founding: r.founding_member,
            max_uses: r.max_uses, use_count: r.use_count,
            expires_at: r.expires_at, created_at: r.created_at,
            status: r.revoked_at ? "revoked"
              : r.use_count >= r.max_uses ? "redeemed"
              : (r.expires_at < now ? "expired" : "sent"),
          };
        }),
      }, 200, NO_STORE);
    }

    const rm = path.match(/^\/v1\/admin\/invites\/([0-9a-f-]{36})\/revoke$/);
    if (rm && req.method === "POST") {
      const out = await rpc<{ ok: boolean; code?: string; message?: string; already_revoked?: boolean }>(
        "revoke_invite", { p_admin: admin.id, p_invite_id: rm[1] });
      if (!out.ok) {
        return err(out.code ?? "server_error", out.message ?? "Revoke failed.",
          out.code === "forbidden" ? 403 : out.code === "not_found" ? 404 : 500);
      }
      return json({ ok: true, already_revoked: out.already_revoked === true }, 200, NO_STORE);
    }

    // The command center numbers: who is in, who is onboarding, what happened
    // today, and where the money stands. Everything computed from real rows
    // and the configured economics, nothing hard-coded.
    if (path === "/v1/admin/overview" && req.method === "GET") {
      const since = ctDayStartIso();
      interface CreatorRow { id: string; founding_member: boolean; status: string }
      interface InviteRow { use_count: number; max_uses: number; expires_at: string; revoked_at: string | null }
      interface SubRow { model_id: string }
      const [creators, invites, subsToday, models, subscribers, quarantine, monthly, reserveBps, platformBps, poolBps, fCount, billing] =
        await Promise.all([
          viewGet<CreatorRow>("creators", "select=id,founding_member,status"),
          viewGet<InviteRow>("invite_tokens", "select=use_count,max_uses,expires_at,revoked_at"),
          viewGet<SubRow>("submissions",
            `select=model_id&data_origin=eq.live&received_at=gte.${encodeURIComponent(since)}`),
          viewGet<{ id: string }>("models", "select=id&is_listed=is.true"),
          viewCount("subscribers", "status=in.(active,past_due)"),
          viewCount("quarantine_queue", "", "projection_id"),
          cfgInt("pricing.monthly_cents", 2499),
          cfgInt("econ.reserve_bps", 1000),
          cfgInt("econ.platform_bps", 3000),
          cfgInt("econ.founder_pool_bps", 6000),
          cfgInt("econ.founder_count", 6),
          rpc<unknown>("get_config", { p_key: "billing.enabled" }),
        ]);
      const nowIso = new Date().toISOString();
      const active = creators.filter((c) => c.status === "active");
      const submittedModels = new Set(subsToday.map((s) => s.model_id));
      const mrr = subscribers * monthly;
      const pool = Math.floor((mrr * poolBps) / 10000);
      return json({
        collective: {
          founding_members: active.filter((c) => c.founding_member).length,
          creators: active.length,
          subscribers,
          mrr_cents: mrr,
          billing_live: billing === true,
        },
        onboarding: {
          invites_pending: invites.filter((i) =>
            !i.revoked_at && i.use_count < i.max_uses && i.expires_at >= nowIso).length,
          invites_redeemed: invites.filter((i) => i.use_count >= i.max_uses).length,
        },
        today: {
          models_submitted: submittedModels.size,
          models_missing: models.filter((mo) => !submittedModels.has(mo.id)).length,
          quarantined_rows: quarantine,
        },
        economics: {
          price_cents: monthly,
          reserve_bps: reserveBps, platform_bps: platformBps,
          founder_pool_bps: poolBps, founder_count: Math.max(fCount, 1),
          reserve_cents: Math.floor((mrr * reserveBps) / 10000),
          platform_cents: Math.floor((mrr * platformBps) / 10000),
          pool_cents: pool,
          per_founder_cents: Math.floor(pool / Math.max(fCount, 1)),
        },
      }, 200, NO_STORE);
    }

    if (path === "/v1/admin/members" && req.method === "GET") {
      interface WallRow {
        creator_id: string; creator_slug: string; creator_name: string; membership: string;
        founding: boolean; model_name: string; last_submission_at: string | null;
      }
      interface CreatorRow {
        id: string; slug: string; display_name: string; description: string | null;
        website_url: string | null; status: string; founding_member: boolean;
        referral_share_bps: number; billing_mode: string; created_at: string;
      }
      interface ModelRow {
        creator_id: string; slug: string; name: string; sport_code: string;
        source_kind: string | null; source_ref: string | null;
      }
      const [wall, creators, models, keys, installs] = await Promise.all([
        viewGet<WallRow>("model_wall", "select=creator_id,creator_slug,creator_name,membership,founding,model_name,last_submission_at"),
        viewGet<CreatorRow>("creators",
          "select=id,slug,display_name,description,website_url,status,founding_member,referral_share_bps,billing_mode,created_at&order=created_at.asc"),
        viewGet<ModelRow>("models", "select=creator_id,slug,name,sport_code,source_kind,source_ref"),
        viewGet<{ creator_id: string; key_prefix: string; kind: string; status: string }>(
          "api_keys", "select=creator_id,key_prefix,kind,status"),
        viewGet<{ creator_id: string; origin: string }>("embed_installs", "select=creator_id,origin&status=eq.active"),
      ]);
      return json({
        rows: creators.map((c) => {
          const mine = wall.filter((w) => w.creator_id === c.id);
          const myModels = models.filter((mo) => mo.creator_id === c.id);
          return {
            creator_slug: c.slug,
            display_name: c.display_name,
            description: c.description,
            website_url: c.website_url,
            account_status: c.status,
            membership: mine[0]?.membership ?? "MEMBER",
            founding: c.founding_member,
            referral_share_bps: c.referral_share_bps,
            billing_mode: c.billing_mode,
            models: myModels.map((mo) => ({
              slug: mo.slug, name: mo.name, sport: mo.sport_code,
              source_kind: mo.source_kind, source_ref: mo.source_ref,
            })),
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
      const [rows, subscribers, monthly, reserveBps, platformBps, poolBps, fCount, refBps, billing] =
        await Promise.all([
          viewGet<Row>("creator_earnings_monthly", "select=*&order=period_month.desc"),
          viewCount("subscribers", "status=in.(active,past_due)"),
          cfgInt("pricing.monthly_cents", 2499),
          cfgInt("econ.reserve_bps", 1000),
          cfgInt("econ.platform_bps", 3000),
          cfgInt("econ.founder_pool_bps", 6000),
          cfgInt("econ.founder_count", 6),
          cfgInt("econ.referral_bps", 0),
          rpc<unknown>("get_config", { p_key: "billing.enabled" }),
        ]);
      const mrr = subscribers * monthly;
      const pool = Math.floor((mrr * poolBps) / 10000);
      const n = Math.max(fCount, 1);
      return json({
        summary: {
          price_cents: monthly, subscribers, mrr_cents: mrr,
          reserve_bps: reserveBps, platform_bps: platformBps,
          founder_pool_bps: poolBps, founder_count: n, referral_bps: refBps,
          reserve_cents: Math.floor((mrr * reserveBps) / 10000),
          platform_cents: Math.floor((mrr * platformBps) / 10000),
          pool_cents: pool,
          per_founder_cents: Math.floor(pool / n),
          billing_live: billing === true,
        },
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
