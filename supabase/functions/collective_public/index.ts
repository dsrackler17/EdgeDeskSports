// Model Collective public read API. Free surfaces are genuinely free (they
// are the marketing surface); paid surfaces gate IN THE RESPONSE BODY, so
// no unentitled caller ever receives a pre-kickoff number (Section 5).
// Dashboard routes serve the signed-in creator only.

import { json, err, preflight, subpath } from "../_shared/http.ts";
import { rpc, RpcError } from "../_shared/db.ts";
import { getUser } from "../_shared/auth.ts";
import { newApiKey } from "../_shared/keys.ts";
import { BASE_URL } from "../_shared/env.ts";
import {
  buildGames, buildMeta, buildWall, currentWeek, isEntitled, RULES, tableWrite, viewGet,
} from "../_shared/reads.ts";

const FREE_CACHE = { "cache-control": "public, max-age=60" };
const NO_STORE = { "cache-control": "no-store" };

interface CreatorRow {
  id: string; user_id: string | null; slug: string; display_name: string;
  description: string | null; website_url: string | null; x_handle: string | null;
  logo_url: string | null; founding_member: boolean; billing_mode: string;
  referral_share_bps: number; pinned_model_id: string | null; created_at: string;
}

function pub(c: CreatorRow, membership: string, monogram: string, pinned: string | null) {
  return {
    slug: c.slug, display_name: c.display_name, description: c.description,
    website_url: c.website_url, x_handle: c.x_handle, logo_url: c.logo_url,
    monogram, founding: c.founding_member, membership,
    joined_at: c.created_at, pinned_model_slug: pinned,
  };
}

async function creatorPayload(slug: string) {
  const wall = await buildWall();
  const mine = wall.filter((w) => w.creator_slug === slug);
  if (mine.length === 0) return null;
  const creators = await viewGet<CreatorRow>("creators", `select=*&slug=eq.${slug}&limit=1`);
  if (creators.length === 0) return null;
  const c = creators[0];
  const backfill = await viewGet<{ model_id: string; rows: number }>(
    "model_backfill", `select=*`);
  const models = await viewGet<{ id: string; slug: string }>(
    "models", `select=id,slug&creator_id=eq.${c.id}`);
  const pinned = models.find((m) => m.id === c.pinned_model_id)?.slug ?? null;
  const anyLive = mine.some((w) => w.last_submission_at !== null);
  return {
    creator: pub(c, mine[0].membership, mine[0].monogram, pinned),
    models: mine.map((w) => {
      const modelId = models.find((m) => m.slug === w.model_slug)?.id;
      const bf = backfill.find((b) => b.model_id === modelId);
      return {
        model_slug: w.model_slug, model_name: w.model_name, sport: w.sport,
        record: w.record, coverage_pct: w.coverage_pct, last_submission_at: w.last_submission_at,
        backfill: bf ? { rows: bf.rows, note: "Backfilled history, shown separately, never ranked" } : null,
      };
    }),
    empty_state: !anyLive,
  };
}

async function requireCreator(req: Request): Promise<{ user: { id: string }; creator: CreatorRow } | Response> {
  const user = await getUser(req);
  if (!user) return err("invalid_key", "Sign in to use the dashboard.", 401);
  const rows = await viewGet<CreatorRow>("creators", `select=*&user_id=eq.${user.id}&limit=1`);
  if (rows.length === 0) return err("not_found", "This account has no creator profile.", 404);
  return { user, creator: rows[0] };
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  const path = subpath(req, "collective_public");

  try {
    // ------------------------------------------------------------ free
    if (req.method === "GET" && path === "/v1/meta") {
      return json(await buildMeta(), 200, FREE_CACHE);
    }
    if (req.method === "GET" && path === "/v1/wall") {
      return json({ generated_at: new Date().toISOString(), rows: await buildWall() }, 200, FREE_CACHE);
    }
    if (req.method === "GET" && path === "/v1/rules") {
      return json(RULES, 200, FREE_CACHE);
    }
    if (req.method === "GET" && path === "/v1/rankings") {
      interface RankRow {
        creator_slug: string; creator_name: string; model_slug: string; model_name: string;
        sport: string; graded: number | null; coverage_pct: number | null;
        win_pct: number | null; margin_mae: number | null; brier: number | null;
        is_ranked: boolean; unranked_reason: string | null;
        rank_win_pct: number | null; rank_margin_mae: number | null; rank_brier: number | null;
      }
      const rows = await viewGet<RankRow>("model_rankings", "select=*");
      const [minCov, minGraded] = await Promise.all([
        rpc<unknown>("get_config", { p_key: "ranking.min_coverage_pct" }),
        rpc<unknown>("get_config", { p_key: "ranking.min_graded_games" }),
      ]);
      const board = (rankKey: "rank_win_pct" | "rank_margin_mae" | "rank_brier",
        valKey: "win_pct" | "margin_mae" | "brier") =>
        rows.filter((r) => r.is_ranked && r[rankKey] !== null)
          .sort((a, b) => (a[rankKey] ?? 0) - (b[rankKey] ?? 0))
          .map((r) => ({
            rank: r[rankKey], creator_slug: r.creator_slug, creator_name: r.creator_name,
            model_slug: r.model_slug, model_name: r.model_name, sport: r.sport,
            value: r[valKey], graded: r.graded, coverage_pct: r.coverage_pct,
          }));
      return json({
        rules_version: RULES.version,
        thresholds: { min_coverage_pct: Number(minCov ?? 60), min_graded_games: Number(minGraded ?? 20) },
        boards: {
          win_pct: board("rank_win_pct", "win_pct"),
          margin_mae: board("rank_margin_mae", "margin_mae"),
          brier: board("rank_brier", "brier"),
        },
        unranked: rows.filter((r) => !r.is_ranked).map((r) => ({
          creator_slug: r.creator_slug, model_slug: r.model_slug,
          model_name: r.model_name, reason: r.unranked_reason,
        })),
      }, 200, FREE_CACHE);
    }
    if (req.method === "GET" && path === "/v1/activity") {
      interface ActRow {
        at: string; creator_slug: string; creator_name: string; model_name: string;
        sport: string; n_rows: number; n_first: number; week: number | null;
      }
      const rows = await viewGet<ActRow>("activity_feed", "select=*&limit=40");
      return json({
        rows: rows.map((r) => ({
          at: r.at, creator_slug: r.creator_slug, creator_name: r.creator_name,
          model_name: r.model_name, sport: r.sport, kind: "submission",
          n_rows: r.n_rows, n_first: r.n_first, week: r.week,
        })),
      }, 200, FREE_CACHE);
    }

    // Who am I: the one route the site uses to decide which dashboard to
    // render. Role resolution happens here, server side, from the actual
    // rows: a creators row makes a creator, an active subscribers row makes
    // a subscriber, anyone else signed in is a member. The client only uses
    // this for layout; every paid number stays gated in its own response.
    if (req.method === "GET" && path === "/v1/me") {
      const user = await getUser(req);
      if (!user) return json({ signed_in: false, role: "guest" }, 200, NO_STORE);
      interface SubscriberRow { status: string; plan: string; current_period_end: string | null; started_at: string }
      const [creators, subs, adminCfg] = await Promise.all([
        viewGet<CreatorRow>("creators", `select=*&user_id=eq.${user.id}&limit=1`),
        viewGet<SubscriberRow>("subscribers",
          `select=status,plan,current_period_end,started_at&user_id=eq.${user.id}&limit=1`),
        rpc<unknown>("get_config", { p_key: "admin.user_ids" }),
      ]);
      const admin = Array.isArray(adminCfg) && adminCfg.includes(user.id);
      const entitled = await isEntitled(user.id);
      const c = creators[0] ?? null;
      let creator = null;
      if (c) {
        const wall = await buildWall();
        const mine = wall.filter((w) => w.creator_slug === c.slug);
        creator = {
          slug: c.slug, display_name: c.display_name, founding: c.founding_member,
          membership: mine[0]?.membership ?? "MEMBER", monogram: mine[0]?.monogram ?? "",
          logo_url: c.logo_url,
          models: mine.map((w) => ({ model_slug: w.model_slug, model_name: w.model_name, sport: w.sport })),
        };
      }
      const sub = subs[0] ?? null;
      const role = c
        ? "creator"
        : (sub && ["active", "past_due"].includes(sub.status) ? "subscriber" : "member");
      return json({
        signed_in: true, email: user.email, role, admin, entitled,
        founding: c?.founding_member ?? false,
        creator,
        subscription: sub
          ? { status: sub.status, plan: sub.plan, current_period_end: sub.current_period_end, started_at: sub.started_at }
          : null,
      }, 200, NO_STORE);
    }

    let m = path.match(/^\/v1\/creators\/([a-z0-9-]+)$/);
    if (req.method === "GET" && m) {
      const payload = await creatorPayload(m[1]);
      if (!payload) return err("not_found", "No creator at this address.", 404);
      return json(payload, 200, FREE_CACHE);
    }

    m = path.match(/^\/v1\/models\/([a-z0-9-]+)\/([a-z0-9-]+)$/);
    if (req.method === "GET" && m) {
      const payload = await creatorPayload(m[1]);
      const model = payload?.models.find((x) => x.model_slug === m![2]);
      if (!payload || !model) return err("not_found", "No such model.", 404);
      const models = await viewGet<{ id: string; description: string | null }>(
        "models", `select=id,description,slug,creators!inner(slug)&slug=eq.${m[2]}&creators.slug=eq.${m[1]}&limit=1`);
      const modelId = models[0]?.id;
      interface CovRow { season: number; week: number; games_available: number; games_submitted: number }
      interface LogRow {
        game_id: string; label: string; kickoff_at: string; week: number | null;
        pick_side: string | null; closing_spread: number | null; final: string | null;
        pick_result: string | null; margin_error: number | null; brier: number | null; movement_n: number;
      }
      const [coverage, log] = await Promise.all([
        modelId
          ? viewGet<CovRow>("model_coverage", `select=season,week,games_available,games_submitted&model_id=eq.${modelId}&order=season.desc,week.asc`)
          : Promise.resolve([] as CovRow[]),
        modelId
          ? viewGet<LogRow>("model_game_log", `select=*&model_id=eq.${modelId}&order=graded_at.desc&limit=25`)
          : Promise.resolve([] as LogRow[]),
      ]);
      return json({
        creator: {
          slug: payload.creator.slug, display_name: payload.creator.display_name,
          founding: payload.creator.founding,
        },
        model: { model_slug: model.model_slug, model_name: model.model_name, sport: model.sport,
          description: models[0]?.description ?? null },
        record: model.record,
        coverage,
        coverage_pct: model.coverage_pct,
        recent_graded: log.map((g) => ({
          game_id: g.game_id, label: g.label, kickoff_at: g.kickoff_at, week: g.week,
          pick_side: g.pick_side, closing_spread: g.closing_spread, final: g.final,
          pick_result: g.pick_result, margin_error: g.margin_error, brier: g.brier,
          movement_n: g.movement_n,
        })),
      }, 200, FREE_CACHE);
    }

    // ------------------------------------------- free list, paid numbers
    if (req.method === "GET" && path === "/v1/games") {
      const u = new URL(req.url);
      const meta = await buildMeta();
      const rawSport = u.searchParams.get("sport") ?? "";
      const sport = /^[A-Z0-9]{2,10}$/.test(rawSport) ? rawSport : (meta.sports[0]?.code ?? "NFL");
      const season = Number(u.searchParams.get("season") ?? meta.sports.find((s) => s.code === sport)?.season);
      if (!Number.isFinite(season)) return err("invalid_payload", "season must be a number", 422);
      const rawWeek = u.searchParams.get("week");
      let week: number | null = null;
      if (rawWeek !== null) {
        week = Number(rawWeek);
        if (!Number.isInteger(week)) return err("invalid_payload", "week must be an integer", 422);
      } else {
        // No week asked for: default to the current slate, not the season.
        week = await currentWeek(sport, season);
      }
      const user = await getUser(req);
      const entitled = await isEntitled(user?.id ?? null);
      const payload = await buildGames(sport, season, week, entitled);
      return json(payload, 200, entitled ? NO_STORE : FREE_CACHE);
    }

    if (req.method === "GET" && path === "/v1/consensus") {
      const u = new URL(req.url);
      const meta = await buildMeta();
      const rawSport = u.searchParams.get("sport") ?? "";
      const sport = /^[A-Z0-9]{2,10}$/.test(rawSport) ? rawSport : (meta.sports[0]?.code ?? "NFL");
      const season = Number(u.searchParams.get("season") ?? meta.sports.find((s) => s.code === sport)?.season);
      if (!Number.isFinite(season)) return err("invalid_payload", "season must be a number", 422);
      const rawWeek = u.searchParams.get("week");
      let week: number | null = null;
      if (rawWeek !== null) {
        week = Number(rawWeek);
        if (!Number.isInteger(week)) return err("invalid_payload", "week must be an integer", 422);
      } else {
        week = await currentWeek(sport, season);
      }
      const user = await getUser(req);
      const entitled = await isEntitled(user?.id ?? null);
      const board = await buildGames(sport, season, week, entitled);
      type BoardGame = {
        game_id: string; label: string; kickoff_at: string; status: string;
        consensus: Record<string, unknown> | null;
      };
      const rows = (board.games as BoardGame[])
        .filter((g) => g.consensus !== null)
        .map((g) => {
          const c = g.consensus as Record<string, unknown>;
          if (c.locked) {
            return { game_id: g.game_id, label: g.label, kickoff_at: g.kickoff_at, status: g.status, n: c.n ?? null };
          }
          return { game_id: g.game_id, label: g.label, kickoff_at: g.kickoff_at, status: g.status, ...c };
        });
      if (entitled) return json({ entitled: true, rows }, 200, NO_STORE);
      return json({
        entitled: false,
        reason: (await buildMeta()).billing_live ? "subscription_required" : "billing_not_live",
        rows,
      }, 200, FREE_CACHE);
    }

    // ------------------------------------------------------- dashboard
    if (path === "/v1/dashboard" && req.method === "GET") {
      const ctx = await requireCreator(req);
      if (ctx instanceof Response) return ctx;
      const { creator } = ctx;
      const wall = await buildWall();
      const mine = wall.filter((w) => w.creator_slug === creator.slug);
      interface KeyRow { key_prefix: string; kind: string; status: string; created_at: string; last_used_at: string | null }
      interface OriginRow { id: string; origin: string; status: string }
      interface EarnRow {
        period_month: string; earned_cents: number | null; balance_cents: number | null; available_cents: number | null;
      }
      const [keys, origins, earnings, referredTotal, referredActive] = await Promise.all([
        viewGet<KeyRow>("api_keys", `select=key_prefix,kind,status,created_at,last_used_at&creator_id=eq.${creator.id}&order=created_at.desc`),
        viewGet<OriginRow>("embed_installs", `select=id,origin,status&creator_id=eq.${creator.id}&order=created_at.asc`),
        viewGet<EarnRow>("creator_earnings_monthly", `select=period_month,earned_cents,balance_cents,available_cents&creator_id=eq.${creator.id}&order=period_month.desc`),
        (await viewGet<{ id: string }>("attributions", `select=id&creator_id=eq.${creator.id}`)).length,
        (await viewGet<{ id: string }>("subscribers", `select=id,attributions!inner(creator_id)&attributions.creator_id=eq.${creator.id}&status=in.(active,past_due)`)).length,
      ]);
      const thisMonth = new Date().toISOString().slice(0, 7);
      const meta = await buildMeta();
      const balance = earnings.reduce((s, e) => s + (e.balance_cents ?? 0), 0);
      const available = earnings.reduce((s, e) => s + (e.available_cents ?? 0), 0);
      const models = await viewGet<{ id: string; slug: string; name: string; sport_code: string }>(
        "models", `select=id,slug,name,sport_code&creator_id=eq.${creator.id}`);
      const pinned = models.find((x) => x.id === creator.pinned_model_id)?.slug ?? null;
      return json({
        creator: {
          ...pub(creator, mine[0]?.membership ?? "MEMBER", mine[0]?.monogram ?? "", pinned),
          billing_mode: creator.billing_mode, referral_share_bps: creator.referral_share_bps,
        },
        models: models.map((x) => ({ model_slug: x.slug, model_name: x.name, sport: x.sport_code })),
        keys: keys.map((k) => ({
          prefix: `mck_${k.kind}_${k.key_prefix}`, status: k.status,
          created_at: k.created_at, last_used_at: k.last_used_at,
        })),
        origins,
        earnings: {
          this_month_cents: earnings.find((e) => e.period_month?.startsWith(thisMonth))?.earned_cents ?? 0,
          balance_cents: balance, available_cents: available,
          referred_active: referredActive, referred_total: referredTotal,
          note: meta.billing_live
            ? null
            : "Billing is not live yet. Attribution is being recorded now and pays out when billing turns on.",
        },
        embed_snippet: `<script src="${BASE_URL}/collective/embed.js" data-collective-host="${creator.slug}" async></script>`,
        prompt_available: true,
      }, 200, NO_STORE);
    }

    if (path === "/v1/dashboard/profile" && req.method === "POST") {
      const ctx = await requireCreator(req);
      if (ctx instanceof Response) return ctx;
      const body = await req.json().catch(() => null) as Record<string, unknown> | null;
      if (!body) return err("invalid_payload", "Body must be JSON.", 422);
      const patch: Record<string, unknown> = {};
      // Creators edit identity fields only; records, rates, and flags are
      // never editable from here. Values must be strings; URLs must parse
      // as http(s) so a profile can never publish a javascript: link.
      for (const k of ["display_name", "description", "website_url", "x_handle", "logo_url"]) {
        if (!(k in body)) continue;
        const v = body[k];
        if (v !== null && typeof v !== "string") {
          return err("invalid_payload", `${k} must be a string.`, 422);
        }
        patch[k] = v === "" ? null : v;
      }
      for (const k of ["website_url", "logo_url"]) {
        const v = patch[k];
        if (typeof v !== "string") continue;
        try {
          const uu = new URL(v.startsWith("http") ? v : `https://${v}`);
          if (uu.protocol !== "https:" && uu.protocol !== "http:") throw new Error("scheme");
          patch[k] = uu.toString();
        } catch {
          return err("invalid_payload", `${k} is not a usable URL.`, 422);
        }
      }
      if (typeof patch.x_handle === "string") patch.x_handle = patch.x_handle.replace(/^@/, "");
      if (typeof body.pinned_model_slug === "string" && /^[a-z0-9-]{1,40}$/.test(body.pinned_model_slug)) {
        const mrows = await viewGet<{ id: string }>(
          "models", `select=id&creator_id=eq.${ctx.creator.id}&slug=eq.${body.pinned_model_slug}&limit=1`);
        if (mrows[0]) patch.pinned_model_id = mrows[0].id;
      }
      if (typeof patch.display_name === "string" &&
        ((patch.display_name as string).length < 2 || (patch.display_name as string).length > 60)) {
        return err("invalid_payload", "Display name must be 2 to 60 characters.", 422);
      }
      const updated = await tableWrite("creators", "PATCH", `id=eq.${ctx.creator.id}`, patch) as CreatorRow[];
      const c = updated[0];
      return json({ ok: true, creator: pub(c, "", "", null) }, 200, NO_STORE);
    }

    // Browser slate submission: the signed-in creator posts an envelope from
    // the dashboard (CSV or Excel upload, or manual entry) without ever
    // handling their API key. Same validation pipeline as the key path: the
    // envelope goes verbatim into the ingest RPC under the creator's own
    // active key identity, so rate limits and attribution behave identically.
    if (path === "/v1/dashboard/submit" && req.method === "POST") {
      const ctx = await requireCreator(req);
      if (ctx instanceof Response) return ctx;
      const body = await req.json().catch(() => null) as Record<string, unknown> | null;
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return err("invalid_payload", "Body must be a JSON envelope.", 422);
      }
      const rows = body.rows;
      if (!Array.isArray(rows) || rows.length === 0) {
        return err("invalid_payload", "Envelope must include a non-empty rows array.", 422);
      }
      if (rows.length > 500) {
        return err("invalid_payload", `${rows.length} rows exceeds the 500 row maximum.`, 422);
      }
      interface ModelRow { id: string; slug: string; name: string; sport_code: string }
      const models = await viewGet<ModelRow>(
        "models", `select=id,slug,name,sport_code&creator_id=eq.${ctx.creator.id}`);
      if (models.length === 0) return err("not_found", "This account has no model yet.", 404);
      let model = models[0];
      if (typeof body.model === "string" && body.model) {
        const found = models.find((x) => x.slug === body.model);
        if (!found) return err("invalid_payload", `No model named "${body.model}" on this account.`, 422);
        model = found;
      } else if (models.length > 1) {
        return err("invalid_payload", "This account has several models; set \"model\" to one of: " +
          models.map((x) => x.slug).join(", "), 422);
      }
      const keys = await viewGet<{ id: string }>(
        "api_keys", `select=id&creator_id=eq.${ctx.creator.id}&status=eq.active&order=created_at.desc&limit=1`);
      if (!keys[0]) return err("conflict", "No active API key on this account. Rotate a key from the dashboard first.", 409);
      const allowed = await rpc<boolean>("rate_check", { p_key_id: keys[0].id, p_endpoint: "/v1/dashboard/submit" });
      if (allowed === false) return err("rate_limited", "Hourly submission limit reached. Try again later.", 429);
      const pKey = {
        key_id: keys[0].id, kind: "live",
        creator_id: ctx.creator.id, creator_slug: ctx.creator.slug, creator_name: ctx.creator.display_name,
        model_id: model.id, model_slug: model.slug, model_name: model.name, sport: model.sport_code,
      };
      const envelope = { ...body, model: model.slug, sport: model.sport_code };
      delete (envelope as Record<string, unknown>).dry_run;
      const dry = body.dry_run === true;
      const result = await rpc<Record<string, unknown> | null>("ingest_submission", {
        p_key: pKey, p_envelope: envelope, p_dry: dry,
      });
      if (!result || result.ok === false) {
        const code = typeof result?.code === "string" ? result.code : "server_error";
        if (code === "server_error") {
          console.error("collective_public dashboard submit failed:", result);
          return err("server_error", "Something went wrong on our side.", 500);
        }
        return err(code, String(result?.message ?? "The submission was rejected."), 422);
      }
      const out = { ...result } as Record<string, unknown>;
      delete out.ok;
      if (dry) { out.dry_run = true; out.submission_id = null; }
      return json(out, 200, NO_STORE);
    }

    // The submission center: every slate this creator has ever posted, newest
    // first, with the stored per-slate counts. Answers "did my model actually
    // submit?" without the creator hunting through the public surfaces.
    if (path === "/v1/dashboard/submissions" && req.method === "GET") {
      const ctx = await requireCreator(req);
      if (ctx instanceof Response) return ctx;
      interface SubListRow {
        id: string; received_at: string; data_origin: string;
        n_rows: number; n_resolved: number; n_quarantined: number; n_late: number;
        models: { slug: string; name: string; sport_code: string };
      }
      const rows = await viewGet<SubListRow>("submissions",
        `select=id,received_at,data_origin,n_rows,n_resolved,n_quarantined,n_late,` +
        `models!inner(slug,name,sport_code,creator_id)` +
        `&models.creator_id=eq.${ctx.creator.id}&order=received_at.desc&limit=40`);
      return json({
        rows: rows.map((s) => ({
          id: s.id, received_at: s.received_at, data_origin: s.data_origin,
          model_slug: s.models.slug, model_name: s.models.name, sport: s.models.sport_code,
          rows: s.n_rows, resolved: s.n_resolved, quarantined: s.n_quarantined, late: s.n_late,
        })),
      }, 200, NO_STORE);
    }

    if (path === "/v1/dashboard/keys/rotate" && req.method === "POST") {
      const ctx = await requireCreator(req);
      if (ctx instanceof Response) return ctx;
      const fresh = await newApiKey("live");
      const out = await rpc<{ ok: boolean }>("rotate_key", {
        p_creator_id: ctx.creator.id, p_new_prefix: fresh.prefix, p_new_hash: fresh.hash, p_kind: "live",
      });
      if (!out?.ok) return err("server_error", "Rotation failed.", 500);
      return json({ key: fresh.raw, prefix: `mck_live_${fresh.prefix}`, shown_once: true }, 200, NO_STORE);
    }

    if (path === "/v1/dashboard/origins" && req.method === "POST") {
      const ctx = await requireCreator(req);
      if (ctx instanceof Response) return ctx;
      const body = await req.json().catch(() => null) as { add?: string; remove?: string } | null;
      if (!body) return err("invalid_payload", "Body must be JSON.", 422);
      if (typeof body.add === "string") {
        let origin: string;
        try {
          const u = new URL(body.add);
          if (u.protocol !== "https:" && u.hostname !== "localhost") throw new Error("https required");
          origin = `${u.protocol}//${u.host}`;
        } catch {
          return err("invalid_payload", "Origins must be full https:// URLs.", 422);
        }
        await tableWrite("embed_installs", "POST", "", { creator_id: ctx.creator.id, origin })
          .catch(() => { /* already listed: adding again is a no-op */ });
      } else if (typeof body.remove === "string" && /^[0-9a-f-]{36}$/.test(body.remove)) {
        await tableWrite("embed_installs", "DELETE", `id=eq.${body.remove}&creator_id=eq.${ctx.creator.id}`);
      } else {
        return err("invalid_payload", "Pass add or remove.", 422);
      }
      const origins = await viewGet("embed_installs",
        `select=id,origin,status&creator_id=eq.${ctx.creator.id}&order=created_at.asc`);
      return json({ ok: true, origins }, 200, NO_STORE);
    }

    if (["/v1/dashboard/profile", "/v1/dashboard/keys/rotate", "/v1/dashboard/origins", "/v1/dashboard/submit"].includes(path) ||
      ["/v1/meta", "/v1/wall", "/v1/rules", "/v1/rankings", "/v1/activity", "/v1/games", "/v1/consensus",
        "/v1/dashboard", "/v1/dashboard/submissions", "/v1/me"].includes(path)) {
      return err("method_not_allowed", "Wrong method for this route.", 405);
    }
    return err("not_found", `No such route: ${req.method} ${path}`, 404);
  } catch (e) {
    if (e instanceof RpcError) console.error("collective_public rpc failure:", e.message, e.body);
    else console.error("collective_public failure:", e);
    return err("server_error", "Something went wrong on our side.", 500);
  }
});
