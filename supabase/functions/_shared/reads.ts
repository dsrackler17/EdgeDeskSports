// Shared read paths over the collective views via PostgREST, plus the
// response builders used by both the public API and the embed API. The
// embed and the site MUST render from identical data (Section 4 of the
// build prompt), so the builders live here once.

import { SB_URL, SERVICE_KEY, BASE_URL } from "./env.ts";
import { rpc } from "./db.ts";

export async function viewGet<T = unknown>(view: string, query: string): Promise<T[]> {
  const res = await fetch(`${SB_URL}/rest/v1/${view}?${query}`, {
    headers: {
      "apikey": SERVICE_KEY,
      "Authorization": `Bearer ${SERVICE_KEY}`,
      "Accept-Profile": "collective",
    },
  });
  if (!res.ok) {
    throw new Error(`view ${view} read failed: ${res.status} ${await res.text()}`);
  }
  return await res.json() as T[];
}

export async function viewCount(view: string, query: string): Promise<number> {
  const res = await fetch(`${SB_URL}/rest/v1/${view}?select=id&${query}`, {
    method: "HEAD",
    headers: {
      "apikey": SERVICE_KEY,
      "Authorization": `Bearer ${SERVICE_KEY}`,
      "Accept-Profile": "collective",
      "Prefer": "count=exact",
    },
  });
  const range = res.headers.get("content-range") ?? "";
  const total = Number(range.split("/")[1]);
  return Number.isFinite(total) ? total : 0;
}

export async function tableWrite(
  table: string,
  method: "POST" | "PATCH" | "DELETE",
  query: string,
  body?: unknown,
): Promise<unknown> {
  const res = await fetch(`${SB_URL}/rest/v1/${table}${query ? "?" + query : ""}`, {
    method,
    headers: {
      "apikey": SERVICE_KEY,
      "Authorization": `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      "Content-Profile": "collective",
      "Prefer": "return=representation",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${table} failed: ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

// ------------------------------------------------------------ shapes

export interface WallRow {
  creator_slug: string; creator_name: string; logo_url: string | null; monogram: string;
  founding: boolean; membership: string; model_slug: string; model_name: string; sport: string;
  record: {
    graded: number; wins: number; losses: number; pushes: number;
    win_pct: number | null; margin_mae: number | null; brier: number | null;
  } | null;
  coverage_pct: number | null; last_submission_at: string | null;
  website_url: string | null; x_handle: string | null;
}

interface WallViewRow {
  creator_slug: string; creator_name: string; logo_url: string | null; monogram: string;
  founding: boolean; website_url: string | null; x_handle: string | null; membership: string;
  model_slug: string; model_name: string; sport: string;
  graded: number | null; wins: number | null; losses: number | null; pushes: number | null;
  win_pct: number | null; margin_mae: number | null; brier: number | null;
  coverage_pct: number | null; last_submission_at: string | null;
}

const MEMBER_RANK: Record<string, number> = { "ACTIVE CONTRIBUTOR": 0, "MEMBER": 1, "INACTIVE": 2 };

function toWallRow(v: WallViewRow): WallRow {
  return {
    creator_slug: v.creator_slug, creator_name: v.creator_name, logo_url: v.logo_url,
    monogram: v.monogram, founding: v.founding, membership: v.membership,
    model_slug: v.model_slug, model_name: v.model_name, sport: v.sport,
    record: v.graded && v.graded > 0
      ? { graded: v.graded, wins: v.wins ?? 0, losses: v.losses ?? 0, pushes: v.pushes ?? 0,
          win_pct: v.win_pct, margin_mae: v.margin_mae, brier: v.brier }
      : null,
    coverage_pct: v.coverage_pct, last_submission_at: v.last_submission_at,
    website_url: v.website_url, x_handle: v.x_handle,
  };
}

// Canonical order everywhere: membership rank, then graded desc, then name.
// One ordering for every host and every surface (Section 4 hard rule).
export async function buildWall(): Promise<WallRow[]> {
  const rows = await viewGet<WallViewRow>("model_wall", "select=*");
  return rows.map(toWallRow).sort((a, b) =>
    (MEMBER_RANK[a.membership] ?? 9) - (MEMBER_RANK[b.membership] ?? 9) ||
    ((b.record?.graded ?? 0) - (a.record?.graded ?? 0)) ||
    a.creator_name.localeCompare(b.creator_name));
}

export interface MetaShape {
  name: string;
  pricing: { monthly_cents: number; annual_cents: number; currency: string };
  billing_live: boolean;
  sports: { code: string; name: string; season: number; in_season: boolean }[];
  counts: { creators: number; models: number; graded_games: number; live_projections: number };
  urls: { site: string; join_info: string; rules: string };
}

export async function buildMeta(): Promise<MetaShape> {
  const [monthly, annual, billing, sports, seasons] = await Promise.all([
    rpc<unknown>("get_config", { p_key: "pricing.monthly_cents" }),
    rpc<unknown>("get_config", { p_key: "pricing.annual_cents" }),
    rpc<unknown>("get_config", { p_key: "billing.enabled" }),
    viewGet<{ code: string; name: string; active: boolean }>("sports", "select=code,name,active&active=is.true"),
    viewGet<{ sport_code: string; season: number; starts_on: string; ends_on: string }>(
      "sport_seasons", "select=*&order=season.desc"),
  ]);
  const [creators, models, settled, liveRows] = await Promise.all([
    viewCount("creators", "is_listed=is.true&status=eq.active"),
    viewCount("models", "is_listed=is.true"),
    viewCount("games", "status=eq.final"),
    viewCount("projections", "data_origin=eq.live&resolution_status=eq.resolved"),
  ]);
  const today = new Date().toISOString().slice(0, 10);
  const site = `${BASE_URL}/collective/`;
  return {
    name: "Model Collective",
    pricing: { monthly_cents: Number(monthly ?? 2000), annual_cents: Number(annual ?? 20000), currency: "usd" },
    billing_live: billing === true,
    sports: sports.map((s) => {
      const season = seasons.find((x) => x.sport_code === s.code);
      return {
        code: s.code, name: s.name, season: season?.season ?? new Date().getFullYear(),
        in_season: !!season && season.starts_on <= today && today <= season.ends_on,
      };
    }),
    counts: { creators, models, graded_games: settled, live_projections: liveRows },
    urls: { site, join_info: site + "#about", rules: site + "#rules" },
  };
}

// ------------------------------------------------------------ the board

interface GameDetailRow {
  game_id: string; sport: string; season: number; week: number | null; kickoff_at: string;
  status: string; home: string; away: string; label: string;
  home_score: number | null; away_score: number | null;
  closing_spread: number | null; closing_total: number | null;
}
interface BoardModelRow {
  game_id: string; model_id: string; creator_slug: string; model_slug: string;
  pick_side: string | null; projected_spread: number | null; projected_total: number | null;
  home_win_prob: number | null; received_at: string; is_late: boolean;
  pick_result: string | null; margin_error: number | null; brier: number | null;
}
interface ConsensusRow {
  game_id: string; n: number; spread_mean: number | null; spread_median: number | null;
  spread_stdev: number | null; spread_min: number | null; spread_max: number | null;
  total_mean: number | null; total_median: number | null; home_win_prob_mean: number | null;
  n_picks: number; pct_picks_home: number | null; agreement: number | null;
}

export interface GamesPayload {
  sport: string; season: number; week: number | null; entitled: boolean;
  games: unknown[];
}

// The paid gate lives here, in the response body: a locked row carries no
// projection numbers at all (Section 5: the gate is in the API, not the DOM).
export async function buildGames(
  sport: string, season: number, week: number | null, entitled: boolean,
): Promise<GamesPayload> {
  const wq = week === null ? "" : `&week=eq.${week}`;
  const games = await viewGet<GameDetailRow>(
    "game_detail", `select=*&sport=eq.${sport}&season=eq.${season}${wq}&order=kickoff_at.asc`);
  if (games.length === 0) return { sport, season, week, entitled, games: [] };
  const ids = games.map((g) => `"${g.game_id}"`).join(",");
  const [models, consensus] = await Promise.all([
    viewGet<BoardModelRow>("board_models", `select=*&game_id=in.(${ids})&order=received_at.asc`),
    viewGet<ConsensusRow>("consensus", `select=*&game_id=in.(${ids})`),
  ]);
  const now = Date.now();
  return {
    sport, season, week, entitled,
    games: games.map((g) => {
      const settled = g.status === "final" || (g.home_score !== null);
      const open = !settled && new Date(g.kickoff_at).getTime() > now;
      const unlocked = entitled || settled || !open;
      const c = consensus.find((x) => x.game_id === g.game_id) ?? null;
      return {
        game_id: g.game_id, label: g.label, home: g.home, away: g.away,
        kickoff_at: g.kickoff_at, status: g.status,
        result: settled && g.home_score !== null
          ? { home_score: g.home_score, away_score: g.away_score,
              closing_spread: g.closing_spread, closing_total: g.closing_total }
          : null,
        consensus: !c || c.n === 0
          ? (unlocked ? null : { locked: true })
          : (unlocked
            ? { locked: false, n: c.n, spread_mean: c.spread_mean, spread_median: c.spread_median,
                spread_stdev: c.spread_stdev, spread_min: c.spread_min, spread_max: c.spread_max,
                total_mean: c.total_mean, home_win_prob_mean: c.home_win_prob_mean,
                pct_picks_home: c.pct_picks_home, agreement: c.agreement }
            : { locked: true }),
        models: models.filter((m) => m.game_id === g.game_id).map((m) =>
          unlocked
            ? { creator_slug: m.creator_slug, model_slug: m.model_slug, locked: false,
                late: m.is_late, pick_side: m.pick_side, projected_spread: m.projected_spread,
                projected_total: m.projected_total, home_win_probability: m.home_win_prob,
                received_at: m.received_at,
                grade: m.pick_result !== null || m.margin_error !== null || m.brier !== null
                  ? { pick_result: m.pick_result, margin_error: m.margin_error, brier: m.brier }
                  : null }
            : { creator_slug: m.creator_slug, model_slug: m.model_slug, locked: true }),
      };
    }),
  };
}

// Entitlement: an active subscriber, or any creator (they contributed to
// the board), checked by the Collective and never by a host site.
export async function isEntitled(userId: string | null): Promise<boolean> {
  if (!userId) return false;
  const [subs, creators] = await Promise.all([
    viewCount("subscribers", `user_id=eq.${userId}&status=in.(active,past_due)`),
    viewCount("creators", `user_id=eq.${userId}&status=eq.active`),
  ]);
  return subs > 0 || creators > 0;
}

export const RULES = {
  version: 1,
  rules: [
    "Pick result: decided by the final score. The actual margin is measured against the Collective's own captured closing spread (home convention) on the pick side; the captured close is the yardstick so every model faces the same number, never the line a creator reports. Push on the exact number, excluded from win percentage. Never graded against a creator-supplied result column.",
    "Margin error: absolute difference between projected home margin and actual home margin. Projected home margin comes from projected scores when given, otherwise from the projected spread.",
    "Brier: squared error on the moneyline home win probability. 0.25 is a coin flip. Lower is better.",
    "First submission: each model is graded on its first pre-kickoff live submission per game, timestamped on server receipt. Later revisions are stored and shown as movement, never regraded. Post-kickoff receipts are stored, marked late, and excluded. Backfill and test data are stored, shown separately, and excluded from records, rankings, and consensus.",
    "Rankings: a model must cover at least 60 percent of the season slate to date and have at least 20 graded games. Win percentage, margin error, and Brier are ranked separately and never blended.",
  ],
};
