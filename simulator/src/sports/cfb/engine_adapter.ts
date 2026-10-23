/* ===========================================================================
   THE SERVED COLLEGE FOOTBALL GAME MODEL, loaded as the board loads it.

   football/cfb_p4/engine.js (edgedesk_cfb_p4) with its generated parameters
   football/cfb_p4/params.js: the engine the board, the exports and the
   graded record price every FBS game with. It is ES5 + UMD and reads its
   parameters from window.EDCfbP4Params, so it is required through Node's
   CommonJS loader with a window global, exactly as
   football/fbs/build_coverage.js and football/cfb_p4/research/backtest_engine.js do.

   The engine's win probability is derived from its margin: P(home) =
   Phi(fair_spread / sigma_margin), sigma from its volatility layer
   (docs/cfb-calibration/README.md, Phase 1). A college game cannot end tied.
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { sha256Hex } from '../../core/canonical.ts';
import { parseCsv, num } from '../../core/csv.ts';

export const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const require = createRequire(import.meta.url);

export interface CfbEngine { E: any; P: any; model_version: string; trained_through: number }
let loaded: CfbEngine | null = null;
export function loadCfbEngine(): CfbEngine {
  if (loaded) return loaded;
  const g = globalThis as any;
  g.window = g.window || g;
  require(path.join(REPO, 'football', 'cfb_p4', 'params.js'));
  const E = require(path.join(REPO, 'football', 'cfb_p4', 'engine.js'));
  const P = g.window.EDCfbP4Params;
  if (!P || !E || typeof E.projectGame !== 'function') throw new Error('football/cfb_p4 engine did not load');
  /* the engine requires football/cfb_p4/home_field.js itself in Node; once
     promoted, projections carry ITS version (edgedesk_cfb_p4_v1.0.1), not params.js's */
  const hf = typeof E.meta === 'function' ? (E.meta() || {}).home_field : null;
  loaded = { E, P, model_version: String((hf && hf.model_version) || P.model_version), trained_through: Number(P.trained_through_season) };
  return loaded;
}

/** the files whose content decides a CFB price (the snapshot's code identity) */
export const CFB_CODE_FILES = ['football/cfb_p4/engine.js', 'football/cfb_p4/params.js', 'football/fbs/fbs.js', 'football/matchup/inputs.js'];
export function cfbCodeIdentity(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of CFB_CODE_FILES) out[f] = sha256Hex(fs.readFileSync(path.join(REPO, f)));
  return out;
}

/* ------------------------------------------------------------ schedule feed */
export const CFB_FEED_CACHE = path.join(REPO, 'simulator', '.cache', 'feeds', 'cfb');
export const schedUrl = (y: number) => 'https://raw.githubusercontent.com/sportsdataverse/cfbfastR-data/main/schedules/csv/cfb_schedules_' + y + '.csv';

export interface FeedGame {
  game_id: string; season: number; week: number; season_type: string; start_date: string; kick: number;
  completed: boolean; neutral: boolean; conference_game: boolean; notes: string | null; venue_id: number | null;
  home: string; away: string; home_division: string; away_division: string; home_conference: string; away_conference: string;
  home_points: number | null; away_points: number | null;
}
const TRUE = (v: unknown) => /^(true|1|t|yes)$/i.test(String(v == null ? '' : v).trim());
export function feedRows(text: string): FeedGame[] {
  return parseCsv(text).map((r) => {
    const hp = num(r.home_points), ap = num(r.away_points);
    return {
      game_id: String(r.game_id), season: Number(r.season), week: Number(r.week), season_type: String(r.season_type || ''),
      start_date: String(r.start_date || ''), kick: Date.parse(String(r.start_date || '')) || 0,
      completed: TRUE(r.completed) && hp != null && ap != null, neutral: TRUE(r.neutral_site), conference_game: TRUE(r.conference_game),
      notes: r.notes && r.notes !== 'NA' ? String(r.notes) : null, venue_id: num(r.venue_id),
      home: String(r.home_team), away: String(r.away_team),
      home_division: String(r.home_division || '').toLowerCase(), away_division: String(r.away_division || '').toLowerCase(),
      home_conference: String(r.home_conference || ''), away_conference: String(r.away_conference || ''),
      home_points: hp, away_points: ap
    };
  });
}
/** a season's feed from the cache, or fetched (bounded retries) into it */
export async function loadSeasonFeed(season: number, offline: boolean): Promise<{ text: string; url: string; sha256: string; bytes: number }> {
  const file = path.join(CFB_FEED_CACHE, 'sched_' + season + '.csv'), url = schedUrl(season);
  let text: string | null = null;
  if (!offline) {
    for (let attempt = 1; attempt <= 4 && text == null; attempt++) {
      try {
        const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(60000) });
        if (!r.ok) throw Object.assign(new Error('HTTP ' + r.status + ' ' + url), { permanent: r.status >= 400 && r.status < 500 });
        text = await r.text();
        fs.mkdirSync(CFB_FEED_CACHE, { recursive: true });
        fs.writeFileSync(file, text);
      } catch (e) {
        if ((e as any).permanent || attempt === 4) break;
        await new Promise((res) => setTimeout(res, 2000 * 2 ** (attempt - 1)));
      }
    }
  }
  if (text == null) {
    if (!fs.existsSync(file)) throw new Error('schedule feed for ' + season + ' unavailable (' + (offline ? 'offline, not cached' : 'fetch failed, not cached') + '): ' + url);
    text = fs.readFileSync(file, 'utf8');
  }
  return { text, url, sha256: sha256Hex(text), bytes: Buffer.byteLength(text) };
}
export function loadSeasonFeedSync(season: number): FeedGame[] {
  const file = path.join(CFB_FEED_CACHE, 'sched_' + season + '.csv');
  if (!fs.existsSync(file)) throw new Error('missing ' + file + ' (fetch it: node simulator/src/research/cfb_calibration.ts --fetch)');
  return feedRows(fs.readFileSync(file, 'utf8'));
}

/* --------------------------------------------------------------- pricing */
export interface Priced { fair: number; sigma: number; p_home: number; status: string; reason?: string }
/** one game from a state, as the walk-forward backtest asks it (no enrichment) */
export interface PriceInjury { player: string; athlete_id?: string | null; position: string; starter: boolean; status: string; source: string }
export function priceBare(eng: CfbEngine, st: any, season: number, week: number, g: { home: string; away: string; home_fbs: boolean; away_fbs: boolean; neutral: boolean; home_conference: string; away_conference: string },
  injuries?: { home?: PriceInjury[]; away?: PriceInjury[] }): Priced & { total: number | null } {
  const out = eng.E.projectGame({
    season, week, state: st,
    game: { home: g.home, away: g.away, home_fbs: g.home_fbs, away_fbs: g.away_fbs, neutral_site: g.neutral },
    teams: { home: { conference: g.home_conference, ...(injuries && injuries.home ? { injuries: injuries.home } : {}) },
             away: { conference: g.away_conference, ...(injuries && injuries.away ? { injuries: injuries.away } : {}) } }
  });
  if (out.status !== 'PREDICTED') return { fair: NaN, sigma: NaN, p_home: NaN, total: null, status: out.status, reason: out.reason };
  return { fair: out.model.fair_spread, sigma: out.model.sigma_margin, p_home: out.model.home_win_prob, total: Number.isFinite(out.model.fair_total) ? out.model.fair_total : null, status: 'PREDICTED' };
}
