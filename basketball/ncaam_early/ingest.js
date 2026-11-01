#!/usr/bin/env node
'use strict';
/* ===========================================================================
   NCAAM-EARLY — the T0 sync: CBBD (and the hand-entered files) in, the
   ncaam_es_* tables out.

     node basketball/ncaam_early/ingest.js --parts <list|hourly|daily|weekly|all>
          [--season <2019-2027|current>] [--mode scheduled|backfill|manual]
          [--max-calls N] [--dry-run] [--offline] [--manifest <file>]

   Parts (config.js PARTS):
     teams conferences venues games box_team player_seasons rosters portal
     recruits lines        one CBBD endpoint each (cbbd.js)
     coaches availability  the hand-entered files (manual.js), no call
     moves                 derived from the cached rosters, player seasons,
                           teams, portal and recruits (moves.js), no call
     features              the preseason T2 features of every D-I team
                           (features.js), from the cache and the engine's
                           prior-season ratings (ratings.js), no call
     project               prospective projections of the games in the next
                           48 h (model.js, project.js): ESPN finals and
                           schedule from the NCAAM forecast dataset, no call
     quotes                NCAAB prices from the boards the odds gateway has
                           already bought (ncaam_es_ncaab_board; no purchase,
                           no CBBD call), kept as a history in
                           ncaam_es_market_quotes (marketjoin.js)
     market                the market comparison and Conviction of this run's
                           projections against those prices, stored before
                           tip in ncaam_es_market_comparisons (needs project)
   Schedules: `daily` = rosters games coaches availability moves features project quotes market;
              `weekly` = daily + teams box_team player_seasons lines portal recruits;
              `hourly` = quotes.

   Every raw response is written gzipped to /.cache/ncaam_early/raw (never
   committed: CBBD's terms forbid publishing its data in bulk), normalised,
   and, unless --dry-run or no SB_URL/SB_SERVICE_ROLE, stored through the
   service-role RPCs with one ncaam_es_runs row per part and season (and an
   alert for every failure or refusal). A run manifest (counts, hashes, the
   quota the provider reported, checks; no data) is written to --manifest.

   Exit status: 1 when any part failed or was refused (a missing key, the
   call cap, the shared-quota reserve); the parts that did run are stored.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const cp = require('child_process');
const C = require('./config');
const N = require('./normalise');
const CB = require('./cbbd');
const MV = require('./moves');
const MAN = require('./manual');
const FE = require('./features');
const RT = require('./ratings');
const MD = require('./model');
const PJ = require('./project');
const MJ = require('./marketjoin');

const DAILY = ['rosters', 'games', 'coaches', 'availability', 'moves', 'features', 'project', 'quotes', 'market'];
const WEEKLY = ['teams', 'games', 'box_team', 'player_seasons', 'rosters', 'portal', 'recruits', 'lines', 'coaches', 'availability', 'moves', 'features', 'project', 'quotes', 'market'];
const HOURLY = ['quotes'];
const ALL = ['conferences', 'venues'].concat(WEEKLY);
const ORDER = ['conferences', 'venues', 'teams', 'games', 'box_team', 'player_seasons', 'rosters', 'portal', 'recruits', 'lines', 'coaches', 'availability', 'moves', 'features', 'project', 'quotes', 'market'];
const ONCE_PER_RUN = ['conferences', 'venues', 'quotes'];
const BOARD_HOURS = 48;
const BATCH = 500;

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
function codeSha() { try { return cp.execSync('git rev-parse HEAD', { cwd: C.ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch (_) { return null; } }

function cacheWrite(season, part, body) {
  const f = C.PATHS.raw(season, part);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const buf = zlib.gzipSync(Buffer.from(JSON.stringify(body)));
  fs.writeFileSync(f, buf);
  return sha(Buffer.from(JSON.stringify(body)));
}
function cacheRead(season, part) {
  const f = C.PATHS.raw(season, part);
  if (!fs.existsSync(f)) return null;
  return { body: JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString('utf8')), at: fs.statSync(f).mtime.toISOString() };
}
/* the season's date range for windowed endpoints: 1 October to 30 April */
const seasonRange = (S) => [(S - 1) + '-10-01T00:00:00Z', S + '-04-30T23:59:59Z'];
const countReasons = (rej) => rej.reduce((o, r) => { const k = String(r.reason).replace(/\d+/g, 'N'); o[k] = (o[k] || 0) + 1; return o; }, {});

/* ── fetch + normalise one part ────────────────────────────────────────────── */
async function fetchPart(api, part, S, ctx) {
  const now = ctx.now;
  const ask = async (p, params) => { const r = await api.get(p, params); if (!r.ok) throw Object.assign(new Error(r.refused || r.error), { refused: !!r.refused }); return r.body; };
  const win = async (p, params) => { const [a, b] = seasonRange(S); const r = await api.windowed(p, params, a, b); if (!r.ok) throw Object.assign(new Error(r.refused || r.error), { refused: !!r.refused }); return { body: r.rows, windows: r.windows, split: r.split }; };
  let body, extra = {};
  const cached = ctx.offline ? cacheRead(S, part) : null;
  if (ctx.offline && !cached && !['coaches', 'availability', 'moves'].includes(part)) throw Object.assign(new Error('offline and nothing cached for ' + part + ' ' + S), { refused: true });
  switch (part) {
    case 'conferences': body = cached ? cached.body : await ask('/conferences/history', {}); break;
    case 'venues': body = cached ? cached.body : await ask('/venues', {}); break;
    case 'teams': body = cached ? cached.body : await ask('/teams', { season: S }); break;
    case 'games': if (cached) body = cached.body; else { const w = await win('/games', { season: S }); body = w.body; extra = { windows: w.windows, split: w.split }; } break;
    case 'box_team': if (cached) body = cached.body; else { const w = await win('/games/teams', { season: S }); body = w.body; extra = { windows: w.windows, split: w.split }; } break;
    case 'lines': if (cached) body = cached.body; else { const w = await win('/lines', { season: S }); body = w.body; extra = { windows: w.windows, split: w.split }; } break;
    case 'player_seasons': body = cached ? cached.body : await ask('/stats/player/season', { season: S }); break;
    case 'rosters': body = cached ? cached.body : await ask('/teams/roster', { season: S }); break;
    case 'portal': body = cached ? cached.body : [].concat(await ask('/recruiting/portal', { year: S - 1 }), await ask('/recruiting/portal', { year: S })); break;
    case 'recruits': body = cached ? cached.body : [].concat(await ask('/recruiting/players', { year: S - 1 }), await ask('/recruiting/players', { year: S })); break;
    default: throw new Error('unknown CBBD part ' + part);
  }
  const capturedAt = cached ? cached.at : now;
  const rawSha = cached ? sha(Buffer.from(JSON.stringify(body))) : cacheWrite(S, part, body);
  let n;
  switch (part) {
    case 'conferences': n = N.conferences(body); break;
    case 'venues': n = N.venues(body); break;
    case 'teams': n = N.teams(body, S); break;
    case 'games': n = N.games(body); ctx.games.set(S, n.rows); break;
    case 'box_team': n = N.boxTeam(body); break;
    case 'player_seasons': n = N.playerSeasons(body, null); break;
    case 'rosters': n = N.rosters(body, S, capturedAt, firstTip(ctx, S)); break;
    case 'portal': n = N.portal(body, capturedAt); break;
    case 'recruits': n = N.recruits(body, capturedAt); break;
    case 'lines': n = N.lines(body, capturedAt, new Map((gamesOf(ctx, S) || []).map((g) => [g.game_id, g.start_utc]))); break;
  }
  if (n.refusal) throw new Error(part + ' ' + S + ': ' + n.refusal);
  return { n, meta: Object.assign({ raw_sha256: rawSha, captured_at: capturedAt, from_cache: !!cached, rows_received: Array.isArray(body) ? body.length : null }, extra) };
}

function gamesOf(ctx, S) {
  if (ctx.games.has(S)) return ctx.games.get(S);
  const c = cacheRead(S, 'games'); if (!c) return null;
  const rows = N.games(c.body).rows; ctx.games.set(S, rows); return rows;
}
/* the season's first regular-season tip; a roster captured before it is LIVE */
function firstTip(ctx, S) {
  const g = (gamesOf(ctx, S) || []).filter((x) => x.season_type === 'regular').map((x) => x.start_utc).sort()[0];
  return g || null;
}

/* ── the derived moves of season S, from the cache ─────────────────────────── */
function derivePart(S, ctx) {
  const need = { rosters: cacheRead(S, 'rosters'), prevPlayers: cacheRead(S - 1, 'player_seasons'), curTeams: cacheRead(S, 'teams'), prevTeams: cacheRead(S - 1, 'teams') };
  const missing = Object.keys(need).filter((k) => !need[k]);
  if (missing.length) throw Object.assign(new Error('moves ' + S + ' needs cached ' + missing.join(', ') + ' (sync those parts first)'), { refused: true });
  const rosters = N.rosters(need.rosters.body, S, need.rosters.at, firstTip(ctx, S)).rows;
  const prevRosterC = cacheRead(S - 1, 'rosters');
  const rosAll = rosters.concat(prevRosterC ? N.rosters(prevRosterC.body, S - 1, prevRosterC.at, firstTip(ctx, S - 1)).rows : []);
  const portalC = cacheRead(S, 'portal'); const recC = cacheRead(S, 'recruits');
  const portal = portalC ? N.portal(portalC.body, portalC.at).rows : [];
  const recruits = recC ? N.recruits(recC.body, recC.at).rows : [];
  const idx = MV.rosterNameIndex(rosAll);
  const po = MV.verifyOffset(portal, idx, (e) => e.dest_team_id, (e) => (e.first_name || '') + ' ' + (e.last_name || ''));
  const ro = MV.verifyOffset(recruits, idx, (e) => e.committed_team_id, (e) => e.name);
  const levels = MAN.validateSchoolLevels(JSON.parse(fs.readFileSync(C.PATHS.schoolLevels, 'utf8')));
  const d = MV.derive({ season: S, rosters, prevPlayers: N.playerSeasons(need.prevPlayers.body, null).rows, curTeams: N.teams(need.curTeams.body, S).rows, prevTeams: N.teams(need.prevTeams.body, S - 1).rows,
    portal, recruits, schoolLevels: levels.ok ? { entries: levels.entries } : { entries: [] }, portalOffset: po.offset, recruitOffset: ro.offset });
  return { moves: d.moves, departed: d.departed, checks: { portal_offset: po, recruit_offset: ro, counts: d.counts } };
}

/* ── the preseason features of season S (features.js), from the cache ─────────
   Prior-season ratings and conference strength come from the existing engine
   walked over the committed hoopR/ESPN dataset (ratings.js), crosswalked to
   CBBD ids by each team's sourceId; coach tempo from the engine's tempo of the
   coach's earlier head-coaching seasons. */
function featuresPart(S, ctx) {
  const cfg = FE.loadConfig();
  const d = derivePart(S, ctx);
  const prevC = cacheRead(S - 1, 'player_seasons'), curT = cacheRead(S, 'teams'), prevT = cacheRead(S - 1, 'teams'), rosC = cacheRead(S, 'rosters');
  const prevPlayers = N.playerSeasons(prevC.body, null).rows;
  const curTeams = N.teams(curT.body, S).rows, prevTeams = N.teams(prevT.body, S - 1).rows;
  const rosters = rosC ? N.rosters(rosC.body, S, rosC.at, firstTip(ctx, S)).rows : [];
  if (!ctx.states) ctx.states = (ctx.ratingStates || RT.seasonStates)(Array.from({ length: S - 1 - 2010 + 1 }, (_, i) => 2010 + i));
  const prevState = ctx.states[S - 1];
  const prevRating = RT.crosswalk(prevTeams, prevState);
  const confStrength = RT.conferenceStrength(prevTeams, prevRating);
  const lc = FE.leagueContext(prevPlayers, cfg);
  const teamsBySeason = new Map();
  const tempoOf = (teamId, y) => {
    if (!teamsBySeason.has(y)) { const c = cacheRead(y, 'teams'); teamsBySeason.set(y, c ? RT.crosswalk(N.teams(c.body, y).rows, ctx.states[y]) : new Map()); }
    const r = teamsBySeason.get(y).get(teamId); return r && r.tempo != null ? r.tempo : null;
  };
  const coaches = MAN.loadAll(ctx.now).coaches;
  const curConf = new Map(curTeams.map((t) => [t.team_id, t.conference_id]));
  const moves = d.moves.map((m) => Object.assign({}, m, { to_conference_id: m.to_conference_id != null ? m.to_conference_id : curConf.get(m.to_team_id) }));
  const rows = [];
  for (const t of curTeams) {
    if (t.conference_id == null) continue;   // D-I only
    const coach = coaches.ok ? MAN.coachFacts(coaches.entries, S, t.team_id) : null;
    const r = FE.teamFeatures(t.team_id, S, { moves, departed: d.departed, prevPlayers, rosters, coach,
      coachTempo: coach ? FE.coachTempo(coach.career, S, tempoOf) : null,
      ctx: Object.assign({}, lc, { confStrength, prevRating }) }, cfg);
    if (r) rows.push(r);
  }
  return { rows, checks: { teams: curTeams.filter((t) => t.conference_id != null).length, with_features: rows.length,
    prior_ratings_crosswalked: prevRating.size, conferences_with_strength: confStrength.size, d1_avg_off: lc.avg_off, d1_avg_def: lc.avg_def, config_sha256: cfg._sha256 } };
}

/* ── prospective projections of season S (model.js, project.js) ─────────────
   Priors from the features of S and the engine's season S-1 state; this
   season's finals and schedule from the NCAAM forecast's committed hoopR/ESPN
   dataset (updated daily, free: no CBBD call), crosswalked to CBBD ids. Only
   games tipping in the next `horizon` hours, and only D-I v D-I, are projected;
   each is computed from the finals known 30 minutes before its tip. */
function projectPart(S, ctx, o) {
  o = o || {};
  const cfg = FE.loadConfig();
  const fe = featuresPart(S, ctx);
  const st = ctx.states[S - 1];
  if (!st) throw Object.assign(new Error('no engine state for season ' + (S - 1)), { refused: true });
  const prevTeams = N.teams(cacheRead(S - 1, 'teams').body, S - 1).rows, curTeams = N.teams(cacheRead(S, 'teams').body, S).rows;
  const prevRating = RT.crosswalk(prevTeams, st);
  const engine = RT.engineParams();
  const priors = new Map(); const features = new Map();
  for (const f of fe.rows) { const p = MD.preseasonPrior(f, prevRating.get(f.team_id) || null, st, cfg, engine); if (p) { priors.set(f.team_id, p); features.set(f.team_id, f); } }
  const espnToCbbd = new Map(curTeams.filter((t) => t.source_id).map((t) => [String(t.source_id), t.team_id]));
  const D = ctx.dataset || require(path.join(C.ROOT, 'basketball', 'ncaam_forecast', 'dataset.js'));
  const nowMs = Date.parse(ctx.now), horizon = (o.horizonHours || 48) * 3600e3;
  const eg = D.engineGames(D.load([S]), { scheduledFrom: nowMs });
  const finals = eg.filter((g) => !g.scheduled && g.regime === 'D1_D1' && espnToCbbd.has(String(g.home)) && espnToCbbd.has(String(g.away)))
    .map((g) => ({ game_id: g.game_id, home: espnToCbbd.get(String(g.home)), away: espnToCbbd.get(String(g.away)), neutral: g.neutral, yH: g.yH, yA: g.yA, poss: g.poss, tempo: g.tempo, start_ms: g.start_ms, known_ms: g.start_ms + C.AVAILABLE_AFTER_MS }));
  const targets = eg.filter((g) => g.scheduled && g.start_ms > nowMs && g.start_ms <= nowMs + horizon)
    .map((g) => ({ game_id: String(g.game_id), season: S, home_team_id: espnToCbbd.get(String(g.home)), away_team_id: espnToCbbd.get(String(g.away)), neutral: g.neutral, start_utc: new Date(g.start_ms).toISOString(),
      home_espn: String(g.home), away_espn: String(g.away) }));
  const league = { mu: st.mu, eta: st.eta, tau: st.tau };
  const espnOf = new Map(targets.map((t) => [t.game_id, t]));
  const rows = PJ.projectGames(targets, { priors, finals, league, features }, cfg, { projection: true })
    .map((r) => Object.assign(r, { home_espn: espnOf.get(String(r.game_id)).home_espn, away_espn: espnOf.get(String(r.game_id)).away_espn }));
  const version = JSON.parse(fs.readFileSync(path.join(C.PATHS.BASE, 'research', 'registration.json'), 'utf8')).version;
  const stored = rows.filter((r) => r.status === 'PROJECTED').map((r) => ({
    projection_id: (o.runId || 'dry') + ':' + r.game_id, espn_game_id: String(r.game_id), season: S, home_team_id: r.home_team_id, away_team_id: r.away_team_id, neutral: r.neutral, start_utc: r.start_utc,
    projected_for: r.projected_for, model_id: C.MODEL_ID, model_version: version, config_sha256: cfg._sha256, code_sha: o.codeSha || null,
    inputs_known_through: r.inputs_known_through, finals_used: r.finals_used, home_games: r.home_games, away_games: r.away_games, home_prior_weight: r.home_prior_weight, away_prior_weight: r.away_prior_weight,
    home_off: r.home_off, home_allow: r.home_allow, home_tempo: r.home_tempo, away_off: r.away_off, away_allow: r.away_allow, away_tempo: r.away_tempo, home_var: r.home_var, away_var: r.away_var,
    fair_spread_home: r.fair_spread_home, fair_total: r.fair_total, win_prob_home: r.win_prob_home, margin: r.margin, total: r.total, possessions: r.possessions, sd_margin: r.sd_margin, sd_total: r.sd_total,
    angles: r.angles, continuity: r.continuity, flags: r.flags }));
  return { rows: stored, raw: rows, checks: { targets: targets.length, projected: stored.length, not_projected: rows.filter((r) => r.status !== 'PROJECTED').map((r) => ({ game_id: r.game_id, reason: r.reason })).slice(0, 20),
    finals_known: finals.length, teams_with_prior: priors.size, horizon_hours: o.horizonHours || 48, model_version: version, config_sha256: cfg._sha256 } };
}

/* ESPN team names (the NCAAM forecast's committed team list), for the match */
function espnNames(ctx) {
  if (ctx.espnNames) return ctx.espnNames;
  const t = JSON.parse(fs.readFileSync(path.join(C.ROOT, 'basketball', 'ncaam_forecast', 'data', 'teams.json'), 'utf8')).teams || {};
  return new Map(Object.entries(t).map(([id, x]) => [String(id), x.name]));
}
const SIDE = { spread: { a: 'home', b: 'away' }, moneyline: { a: 'home', b: 'away' }, total: { a: 'over', b: 'under' } };

/* the gateway's NCAAB boards, read once per run (a read, never a purchase) */
async function readBoard(db, ctx) {
  if (!db || ctx.board) return;
  ctx.board = await db.rpc('ncaam_es_ncaab_board', { p_from: ctx.now, p_to: new Date(Date.parse(ctx.now) + BOARD_HOURS * 3600e3).toISOString() });
}

/* the quotes of the boards the gateway holds for the next BOARD_HOURS hours */
function quotesPart(ctx) {
  const parsed = MJ.parseBoard((ctx.board && ctx.board.boards) || []);
  return { rows: parsed.quotes, rejected: parsed.rejected, checks: { board_read: !!ctx.board, board_available: ctx.board ? ctx.board.available !== false : null,
    boards: ctx.board ? (ctx.board.boards || []).length : 0, events: new Set(parsed.quotes.map((q) => q.event_id)).size, books: [...new Set(parsed.quotes.map((q) => q.book))].sort() } };
}

/* the market comparison of this run's projections of season S: every
   projected game gets one row per market (a game with no matched board is
   PASS with its reason); a game at or past tip is not compared */
function marketPart(S, ctx, o) {
  o = o || {};
  const P = ctx.projected && ctx.projected[S];
  if (!P) throw Object.assign(new Error('the market part needs the project part of the same run (season ' + S + ')'), { refused: true });
  const cfg = FE.loadConfig();
  const nowMs = Date.parse(ctx.now);
  const parsed = MJ.parseBoard((ctx.board && ctx.board.boards) || []);
  const raw = P.raw.filter((r) => r.status === 'PROJECTED' && Date.parse(r.start_utc) > nowMs);
  const events = [...new Map(parsed.quotes.map((q) => [q.event_id, { event_id: q.event_id, home_team: q.home_team, away_team: q.away_team, commence_time: q.commence_time }])).values()];
  const { matches, unresolved_names } = MJ.matchEvents(raw.map((r) => ({ game_id: r.game_id, home_espn: r.home_espn, away_espn: r.away_espn, start_utc: r.start_utc })), events, espnNames(ctx), ctx.oddsAliases);
  const quotes = MJ.quotesFor(parsed.quotes, matches);
  const compared = PJ.compareAll(raw, { quotes }, ctx.now, cfg);
  const version = JSON.parse(fs.readFileSync(path.join(C.PATHS.BASE, 'research', 'registration.json'), 'utf8')).version;
  const rows = [];
  for (const r of compared) {
    const m = matches.get(String(r.game_id)) || { status: 'UNMATCHED' };
    for (const c of r.markets) {
      const b = c.best;
      rows.push({ comparison_id: (o.runId || 'dry') + ':' + r.game_id + ':' + c.market, projection_id: P.runId + ':' + r.game_id, espn_game_id: String(r.game_id), season: S,
        market: c.market, start_utc: r.start_utc, compared_at: ctx.now, odds_event_id: m.event_id || null, match_basis: m.basis || m.status,
        side: b ? SIDE[c.market][b.side] : null, book: b ? b.book : null, line: b ? b.line : null, price_decimal: b ? b.decimal : null, p_model: b ? b.p_model : null, edge: b ? b.edge : null,
        reference: c.reference || null, books_fresh: c.books_fresh || 0, variance_cap: r.variance_cap, angles: r.angles, conviction: c.conviction,
        flags: [].concat(c.flags || [], m.status === 'MATCHED' ? [] : ['NO_MARKET_MATCH: ' + m.status]), model_version: version, config_sha256: cfg._sha256 });
    }
  }
  const tally = (f) => rows.reduce((a, x) => { const k = f(x); a[k] = (a[k] || 0) + 1; return a; }, {});
  const st = [...matches.values()].reduce((a, x) => { a[x.status] = (a[x.status] || 0) + 1; return a; }, {});
  return { rows, checks: { games: raw.length, match: st, unresolved_odds_names: unresolved_names.slice(0, 30), quotes: parsed.quotes.length,
    conviction: tally((x) => x.market + ':' + x.conviction), board_read: !!ctx.board } };
}

/* ── storage ───────────────────────────────────────────────────────────────── */
const TABLE = { conferences: 'ncaam_es_conferences', venues: 'ncaam_es_venues', teams: 'ncaam_es_teams', games: 'ncaam_es_games', box_team: 'ncaam_es_box_team',
  player_seasons: 'ncaam_es_player_seasons', portal: 'ncaam_es_portal', recruits: 'ncaam_es_recruits', lines: 'ncaam_es_lines', coaches: 'ncaam_es_coaches', availability: 'ncaam_es_availability',
  quotes: 'ncaam_es_market_quotes', market: 'ncaam_es_market_comparisons' };

async function store(db, run, table, rows) {
  let stored = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const r = table === 'rosters' ? await db.rpc('ncaam_es_put_rosters', { p_run: run, p_rows: rows.slice(i, i + BATCH) }) : await db.rpc('ncaam_es_put', { p_run: run, p_table: table, p_rows: rows.slice(i, i + BATCH) });
    stored += (r && (r.inserted || 0) + (r.updated || 0)) || 0;
  }
  return stored;
}
/* rosters go one whole team per call, so a team's capture is never split */
function rosterBatches(rows) {
  const by = new Map(); for (const r of rows) { if (!by.has(r.team_id)) by.set(r.team_id, []); by.get(r.team_id).push(r); }
  const out = []; let cur = [];
  for (const team of by.values()) { if (cur.length && cur.length + team.length > BATCH) { out.push(cur); cur = []; } cur = cur.concat(team); }
  if (cur.length) out.push(cur);
  return out;
}

async function run(o) {
  const ctx = { now: o.now || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), games: new Map(), offline: !!o.offline, ratingStates: o.ratingStates || null, dataset: o.dataset || null,
    board: o.board || null, espnNames: o.espnNames || null, oddsAliases: o.oddsAliases || null, projected: {} };
  const api = o.api || CB.client({ key: o.key, fetch: o.fetch, maxCalls: o.maxCalls });
  const db = o.db || null;
  const sha0 = o.codeSha === undefined ? codeSha() : o.codeSha;
  const manifest = { schema: 'edgedesk_ncaam_early_run_v1', model_id: C.MODEL_ID, started_at: ctx.now, mode: o.mode, seasons: o.seasons, parts: o.parts, dry_run: !db,
    note: 'Run metadata only: counts, hashes, checks and the quota the provider reported. No CollegeBasketballData.com row is in this file.', results: [] };
  const parts = ORDER.filter((p) => o.parts.includes(p));
  let failed = 0;
  const manual = MAN.loadAll(ctx.now);
  for (const S of o.seasons) {
    for (const part of parts) {
      if (ONCE_PER_RUN.includes(part) && S !== o.seasons[o.seasons.length - 1]) continue;   // once per run
      const res = { part, season: S, status: null };
      let runId = null;
      try {
        if (db) runId = await db.rpc('ncaam_es_begin_run', { p_part: part, p_season: S, p_mode: o.mode, p_code_sha: sha0 });
        let rows = [], rejected = [], stored = 0, meta = {};
        if (part === 'coaches' || part === 'availability') {
          const v = manual[part];
          if (!v.ok) throw new Error('manual/' + part + '.json does not validate: ' + v.errors.slice(0, 5).join('; '));
          rows = v.entries.filter((e) => e.season === S);
          if (db && rows.length) stored = await store(db, runId, TABLE[part], rows);
        } else if (part === 'features') {
          const f = featuresPart(S, ctx);
          rows = f.rows; meta = { checks: f.checks };
          if (db) {
            stored = await store(db, runId, 'ncaam_es_team_features', rows);
            meta.replaced = await db.rpc('ncaam_es_replace_derived', { p_run: runId, p_season: S });
          }
        } else if (part === 'project') {
          const f = projectPart(S, ctx, { runId: runId || 'dry', codeSha: sha0 });
          rows = f.rows; meta = { checks: f.checks };
          if (db && rows.length) stored = await store(db, runId, 'ncaam_es_projections', rows);
          ctx.projected[S] = { raw: f.raw, runId: runId || 'dry' };
        } else if (part === 'quotes') {
          await readBoard(db, ctx);
          const f = quotesPart(ctx);
          rows = f.rows; rejected = f.rejected; meta = { checks: f.checks };
          if (db && rows.length) stored = await store(db, runId, TABLE.quotes, rows);
        } else if (part === 'market') {
          await readBoard(db, ctx);
          const f = marketPart(S, ctx, { runId: runId || 'dry' });
          rows = f.rows; meta = { checks: f.checks };
          if (db && rows.length) stored = await store(db, runId, TABLE.market, rows);
        } else if (part === 'moves') {
          const d = derivePart(S, ctx);
          rows = d.moves; meta = { checks: d.checks, departed: d.departed.length };
          if (db) {
            stored = await store(db, runId, 'ncaam_es_player_moves', d.moves) + await store(db, runId, 'ncaam_es_departed', d.departed);
            meta.replaced = await db.rpc('ncaam_es_replace_derived', { p_run: runId, p_season: S });
          }
        } else {
          const f = await fetchPart(api, part, S, ctx);
          rows = f.n.rows; rejected = f.n.rejected; meta = f.meta;
          if (part === 'conferences') meta.memberships = f.n.memberships.length;
          if (part === 'teams') meta.crosswalk_espn = crosswalk(rows);
          if (db) {
            if (part === 'rosters') { for (const b of rosterBatches(rows)) stored += await store(db, runId, 'rosters', b); }
            else stored = await store(db, runId, TABLE[part], rows);
            if (part === 'conferences') stored += await store(db, runId, 'ncaam_es_conference_members', f.n.memberships);
          }
        }
        const rejRate = rows.length + rejected.length ? rejected.length / (rows.length + rejected.length) : 0;
        res.status = rejRate > 0.02 ? 'warn' : 'ok';
        Object.assign(res, { rows: rows.length, rejected: rejected.length, rejected_by_reason: countReasons(rejected), stored, meta });
        if (db) {
          if (res.status === 'warn') await db.rpc('ncaam_es_alert', { p_run: runId, p_severity: 'DEGRADED', p_code: 'REJECTED_ROWS', p_message: part + ' ' + S + ': ' + rejected.length + ' of ' + (rows.length + rejected.length) + ' rows rejected ' + JSON.stringify(res.rejected_by_reason) });
          await db.rpc('ncaam_es_finish_run', { p_run: runId, p_status: res.status, p_rows_in: rows.length + rejected.length, p_rows_rejected: rejected.length, p_rows_stored: stored, p_calls: api.state.calls, p_quota_remaining: api.state.remaining, p_detail: { meta, rejected_by_reason: res.rejected_by_reason } });
        }
      } catch (e) {
        failed++;
        res.status = 'error'; res.error = String(e && e.message || e); res.refused = !!(e && e.refused);
        if (db && runId) {
          try {
            await db.rpc('ncaam_es_alert', { p_run: runId, p_severity: 'FAILURE', p_code: res.refused ? 'REFUSED' : 'SYNC_FAILED', p_message: part + ' ' + S + ': ' + res.error });
            await db.rpc('ncaam_es_finish_run', { p_run: runId, p_status: 'error', p_rows_in: null, p_rows_rejected: null, p_rows_stored: 0, p_calls: api.state.calls, p_quota_remaining: api.state.remaining, p_detail: { error: res.error } });
          } catch (e2) { res.db_error = String(e2 && e2.message || e2); }
        }
      }
      manifest.results.push(res);
      console.log('[ncaam_early] ' + part + ' ' + S + ': ' + res.status + (res.error ? ' — ' + res.error : ' — ' + res.rows + ' rows, ' + res.rejected + ' rejected, ' + res.stored + ' stored') + ' (calls ' + api.state.calls + (api.state.remaining != null ? ', provider reports ' + api.state.remaining + ' remaining' : '') + ')');
    }
  }
  manifest.finished_at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  manifest.calls = api.state.calls; manifest.quota_remaining = api.state.remaining; manifest.failed = failed;
  manifest.call_log = api.state.log.map((l) => ({ path: l.path, params: l.params, status: l.status, remaining: l.remaining }));
  return manifest;
}

/* CBBD sourceId vs the ESPN team ids the existing NCAAM engine uses */
function crosswalk(rows) {
  let espn = {};
  try { espn = JSON.parse(fs.readFileSync(path.join(C.ROOT, 'basketball', 'ncaam_forecast', 'data', 'teams.json'), 'utf8')).teams || {}; } catch (_) { return { checked: 0, note: 'no ESPN team list to check against' }; }
  const withSrc = rows.filter((r) => r.source_id);
  const hit = withSrc.filter((r) => espn[r.source_id]).length;
  return { teams: rows.length, with_source_id: withSrc.length, source_id_is_known_espn_id: hit, rate: withSrc.length ? Math.round((hit / withSrc.length) * 1000) / 1000 : null };
}

function parseArgs(a) {
  const val = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
  const cur = C.currentSeason();
  const ps = val('--parts') || 'daily';
  const parts = ps === 'daily' ? DAILY : ps === 'weekly' ? WEEKLY : ps === 'hourly' ? HOURLY : ps === 'all' ? ALL : ps.split(',').map((s) => s.trim()).filter(Boolean);
  const bad = parts.filter((p) => !ORDER.includes(p));
  if (bad.length) throw new Error('unknown part(s): ' + bad.join(', ') + ' (known: ' + ORDER.join(' ') + ')');
  const sv = val('--season') || 'current';
  const seasons = sv === 'current' ? [cur] : sv.split(',').flatMap((s) => { const m = /^(\d{4})-(\d{4})$/.exec(s); if (m) { const x = []; for (let y = +m[1]; y <= +m[2]; y++) x.push(y); return x; } return [+s]; });
  if (seasons.some((s) => !Number.isInteger(s) || s < C.FIRST_SEASON || s > cur)) throw new Error('seasons must be within ' + C.FIRST_SEASON + '-' + cur);
  const mode = val('--mode') || 'manual';
  if (!['scheduled', 'backfill', 'manual'].includes(mode)) throw new Error('--mode must be scheduled, backfill or manual');
  const mc = val('--max-calls');
  return { parts, seasons, mode, maxCalls: mc == null ? undefined : Math.min(250, Math.max(0, parseInt(mc, 10))), dryRun: a.includes('--dry-run'), offline: a.includes('--offline'), manifestFile: val('--manifest') };
}

module.exports = { run, parseArgs, fetchPart, derivePart, featuresPart, projectPart, quotesPart, marketPart, rosterBatches, crosswalk, DAILY, WEEKLY, HOURLY, ALL, ORDER };

if (require.main === module) {
  (async () => {
    const o = parseArgs(process.argv.slice(2));
    let db = null;
    if (!o.dryRun) {
      if (process.env.SB_URL || process.env.SB_SERVICE_ROLE) db = require('./db').postgrestDb(process.env);
      else console.log('[ncaam_early] SB_URL / SB_SERVICE_ROLE not set: NOTHING IS STORED (as --dry-run)');
    }
    const m = await run(Object.assign({}, o, { key: process.env.CBBD_API_KEY, db }));
    const out = o.manifestFile || path.join(C.PATHS.cache, 'runs', m.started_at.replace(/[:]/g, '') + '.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(m, null, 1) + '\n');
    console.log('[ncaam_early] manifest ' + path.relative(C.ROOT, out) + ' — ' + m.results.length + ' part runs, ' + m.failed + ' failed, ' + m.calls + ' CBBD calls');
    if (m.failed) process.exit(1);
  })().catch((e) => { console.error(String(e && e.stack || e).split(String(process.env.CBBD_API_KEY || '\u0000')).join('[redacted]')); process.exit(1); });
}
