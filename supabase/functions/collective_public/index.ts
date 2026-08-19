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
  buildGames, buildMeta, buildWall, isEntitled, RULES, tableWrite, viewGet,
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
        creator: { slug: payload.creator.slug, display_name: payload.creator.display_name },
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
      const week = u.searchParams.get("week") ? Number(u.searchParams.get("week")) : null;
      if (!Number.isFinite(season)) return err("invalid_payload", "season must be a number", 422);
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
      const week = u.searchParams.get("week") ? Number(u.searchParams.get("week")) : null;
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
      const models = await viewGet<{ slug: string; name: string; sport_code: string }>(
        "models", `select=slug,name,sport_code&creator_id=eq.${creator.id}`);
      const pinned = mine.length ? null : null;
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
      // never editable from here.
      for (const k of ["display_name", "description", "website_url", "x_handle", "logo_url"]) {
        if (k in body) patch[k] = body[k] === "" ? null : body[k];
      }
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

    if (["/v1/dashboard/profile", "/v1/dashboard/keys/rotate", "/v1/dashboard/origins"].includes(path) ||
      ["/v1/meta", "/v1/wall", "/v1/rules", "/v1/rankings", "/v1/activity", "/v1/games", "/v1/consensus", "/v1/dashboard"].includes(path)) {
      return err("method_not_allowed", "Wrong method for this route.", 405);
    }
    return err("not_found", `No such route: ${req.method} ${path}`, 404);
  } catch (e) {
    if (e instanceof RpcError) console.error("collective_public rpc failure:", e.message, e.body);
    else console.error("collective_public failure:", e);
    return err("server_error", "Something went wrong on our side.", 500);
  }
});
