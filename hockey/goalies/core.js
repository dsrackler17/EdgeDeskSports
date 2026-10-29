'use strict';
/* ===========================================================================
   EdgeDesk NHL — starting goalies as an Observed (T0) input, and the game
   card built on them. docs/engine/NHL_GOALIES.md is the narrative; this file
   is the contract.

   ONE FILE, THREE RUNTIMES. Everything between BEGIN and END below is copied
   VERBATIM into supabase/functions/nhl_goalie_sync/index.ts by
     node tools/hockey/inline_goalie_core.js
   because an edge function deploys one folder and an import that cannot
   resolve fails the bundle while the old version keeps serving (the NBA
   injury and circa rule). tools/hockey/nhl_goalie_core.test.js fails if the
   copy drifts. Plain JavaScript on purpose: Deno runs it as-is, Node tests
   load it as-is, and the browser loads this file as a script (the footer
   publishes window.EDNHLGoalieCore).

   WHAT IS IN IT
     T0  observations   Daily Faceoff's starting-goalies page (its embedded
                        __NEXT_DATA__ JSON), the NHL's own game boxscore (the
                        `starter` flag, once lineups post), the manual file
                        hockey/data/confirmed_starters.json. Team identity and
                        goalie-name matching. Nothing is estimated: a name that
                        does not match is kept as unmatched, a page that does
                        not read is a DRIFT, never a guess.
     T2  fallback       EdgeDesk's usage projection (hockey/model/ratings.js
                        projectStarters), carried in hockey/goalie_inputs.json.
                        Used only when no source names a starter, and always
                        labelled Projected · EdgeDesk usage projection.
     merge              one status per team per game: the higher status when
                        the sources agree; when they name different goalies,
                        both are kept, the LOWER status is shown (never
                        Confirmed) and the conflict is flagged.
     pricing            any goalie pairing, priced exactly as the slate prices
                        its goalie scenarios: the goalie-aware variant of the
                        production model (xg_goalie_confirmed), the same pair
                        calibration, the same distribution
                        (hockey/model/distribution.js, passed in as DIST). The
                        headline price (xg_core) carries no goalie term and is
                        copied from the slate unchanged.
     the card           a versioned record: the pairing used, each side's
                        status and source, the full range over every realistic
                        pairing, the edge gate, the Known Limitations, and the
                        change note when a starter changed after first posting.
     the edge gate      no EDGE on a moneyline, puck line or total unless both
                        starters are Confirmed, or the edge holds under every
                        realistic pairing.
     cadence            when the sync runs: every two hours from 8 AM Eastern,
                        every 15 minutes in the final three hours before each
                        puck drop, a final pass at T-30, and every 5 minutes
                        after it until puck drop (the lineup-lock window).
     lineup lock        once the NHL boxscore lists both dressed lineups (at
                        least 12 skaters a side) and both starters are
                        Confirmed, the card's HEADLINE is re-priced by the
                        variant that knows tonight's lineups and goalies
                        (xg_all_confirmed: each skater's recent time on ice,
                        against the club's typical lineup, from
                        hockey/model/lineups.js, carried in the inputs). Before
                        lock the headline is the slate's production price,
                        copied unchanged. The owner's decision of 2026-10-29
                        (docs/engine/NHL_GOALIES.md §11).

   It never changes a goalie effect weight, the xG core or how edges are
   ranked: those live in hockey/model/ and lib/edgedesk_nhl_market.js.
   =========================================================================== */

// ── BEGIN NHL GOALIE CORE ─────────────────────────────────────────────────
const NHLG_CORE_VERSION = 'edgedesk_nhl_goalie_core_v1';
const NHLG_STATUSES = ['unknown', 'projected', 'likely', 'confirmed'];
const NHLG_BADGE = { confirmed: 'Confirmed', likely: 'Likely', projected: 'Projected', unknown: 'Unknown' };
/* rank: which source leads when sources disagree (the league's own lineup first) */
const NHLG_SOURCES = {
  nhl_api_boxscore: { label: 'NHL.com game boxscore', tier: 'T0', rank: 4, observed: true },
  manual: { label: 'Manual entry (hockey/data/confirmed_starters.json)', tier: 'T0', rank: 3, observed: true },
  daily_faceoff: { label: 'Daily Faceoff', tier: 'T0', rank: 2, observed: true },
  edgedesk_projection: { label: 'EdgeDesk usage projection', tier: 'T2', rank: 1, observed: false },
  consensus: { label: 'EdgeDesk merge of the sources above', tier: 'T0', rank: 0, observed: false },
};
const NHLG_DEFAULTS = {
  min_ev: 0.02,              /* the EV an edge needs (lib/edgedesk_nhl_market.js DEFAULTS.min_ev) */
  alt_min_p: 0.15,           /* a projected alternate below this start probability is not a realistic pairing */
  max_per_side: 3,
  puck_lines: [-2.5, -1.5, 1.5, 2.5],
  total_lines: [5, 5.5, 6, 6.5, 7],
  first_et_hour: 8,          /* the two-hour cadence starts at 8 AM Eastern */
  every_hours: 2,
  pre_window_min: 180,       /* the final three hours before each puck drop... */
  pre_step_min: 15,          /* ...every 15 minutes */
  final_pass_min: 30,        /* and a final pass at T-30 */
  lookback_min: 90,          /* a slot missed by more than this is not chased */
  heartbeat_min: 55,         /* a declined poke is recorded at most this often */
  lock_window_min: 30,       /* after the final pass, every lock_step_min until puck drop: lineups post late */
  lock_step_min: 5,          /* pg_cron pokes every 5 minutes, the finest step there is */
  lock_min_skaters: 12,      /* a lineup with fewer listed skaters is not a lineup yet (hockey/model/lineups.js) */
};
const NHLG_TEAMS = [
  ['ANA', 'Anaheim Ducks', 'Anaheim', 'Ducks'], ['BOS', 'Boston Bruins', 'Boston', 'Bruins'], ['BUF', 'Buffalo Sabres', 'Buffalo', 'Sabres'],
  ['CAR', 'Carolina Hurricanes', 'Carolina', 'Hurricanes'], ['CBJ', 'Columbus Blue Jackets', 'Columbus', 'Blue Jackets'], ['CGY', 'Calgary Flames', 'Calgary', 'Flames'],
  ['CHI', 'Chicago Blackhawks', 'Chicago', 'Blackhawks'], ['COL', 'Colorado Avalanche', 'Colorado', 'Avalanche'], ['DAL', 'Dallas Stars', 'Dallas', 'Stars'],
  ['DET', 'Detroit Red Wings', 'Detroit', 'Red Wings'], ['EDM', 'Edmonton Oilers', 'Edmonton', 'Oilers'], ['FLA', 'Florida Panthers', 'Florida', 'Panthers'],
  ['LAK', 'Los Angeles Kings', 'Los Angeles', 'Kings', 'LA Kings', 'LA'], ['MIN', 'Minnesota Wild', 'Minnesota', 'Wild'],
  ['MTL', 'Montréal Canadiens', 'Montreal Canadiens', 'Montréal', 'Montreal', 'Canadiens'], ['NJD', 'New Jersey Devils', 'New Jersey', 'Devils', 'NJ'],
  ['NSH', 'Nashville Predators', 'Nashville', 'Predators'], ['NYI', 'New York Islanders', 'NY Islanders', 'Islanders'], ['NYR', 'New York Rangers', 'NY Rangers', 'Rangers'],
  ['OTT', 'Ottawa Senators', 'Ottawa', 'Senators'], ['PHI', 'Philadelphia Flyers', 'Philadelphia', 'Flyers'], ['PIT', 'Pittsburgh Penguins', 'Pittsburgh', 'Penguins'],
  ['SEA', 'Seattle Kraken', 'Seattle', 'Kraken'], ['SJS', 'San Jose Sharks', 'San Jose', 'Sharks', 'SJ'], ['STL', 'St. Louis Blues', 'St Louis Blues', 'St. Louis', 'St Louis', 'Blues'],
  ['TBL', 'Tampa Bay Lightning', 'Tampa Bay', 'Lightning', 'TB'], ['TOR', 'Toronto Maple Leafs', 'Toronto', 'Maple Leafs'],
  ['UTA', 'Utah Mammoth', 'Utah Hockey Club', 'Utah HC', 'Utah', 'Mammoth'], ['VAN', 'Vancouver Canucks', 'Vancouver', 'Canucks'],
  ['VGK', 'Vegas Golden Knights', 'Vegas', 'Golden Knights'], ['WPG', 'Winnipeg Jets', 'Winnipeg', 'Jets'], ['WSH', 'Washington Capitals', 'Washington', 'Capitals', 'WAS'],
];

function nhlgR(v, k) { if (v == null || !isFinite(v)) return null; const f = Math.pow(10, k == null ? 4 : k); return Math.round(v * f) / f; }
function nhlgIso(v) { if (v == null || v === '') return null; const t = typeof v === 'number' ? v : Date.parse(v); return isFinite(t) ? new Date(t).toISOString() : null; }
function nhlgStatusRank(s) { const i = NHLG_STATUSES.indexOf(s); return i < 0 ? 0 : i; }
function nhlgMinStatus(a, b) { return nhlgStatusRank(a) <= nhlgStatusRank(b) ? a : b; }
function nhlgSourceRank(s) { return (NHLG_SOURCES[s] && NHLG_SOURCES[s].rank) || 0; }
function nhlgSourceLabel(s) { return (NHLG_SOURCES[s] && NHLG_SOURCES[s].label) || String(s || 'no source'); }

/** a source's wording → one of the four statuses (unknown when it says nothing usable) */
function nhlgStatus(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!s) return 'unknown';
  if (/^confirm/.test(s) || s === 'starter' || s === 'starting') return 'confirmed';
  if (/^(likely|expected|probable)/.test(s)) return 'likely';
  if (/^(unconfirmed|projected|projection|tbd|tentative|possible|unknown starter)/.test(s)) return 'projected';
  return 'unknown';
}

function nhlgKey(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
}
let NHLG_TEAM_INDEX = null;
/** an abbreviation, a full name, a city, a nickname or a URL slug → the slate's abbreviation */
function nhlgTeam(x) {
  if (x == null || x === '') return null;
  if (!NHLG_TEAM_INDEX) {
    NHLG_TEAM_INDEX = {};
    for (const row of NHLG_TEAMS) for (const n of row) NHLG_TEAM_INDEX[nhlgKey(n)] = row[0];
  }
  const raw = String(x).trim();
  if (/^[A-Z]{2,3}$/.test(raw) && NHLG_TEAMS.some((r) => r[0] === raw)) return raw;
  return NHLG_TEAM_INDEX[nhlgKey(raw)] || null;
}

/** "Kevin Lankinen", "K. Lankinen", "Lankinen, Kevin" → { first, last } (accents and case folded) */
function nhlgNameParts(s) {
  let raw = String(s == null ? '' : s).trim();
  if (!raw) return null;
  if (raw.indexOf(',') > 0) { const [a, b] = raw.split(','); raw = (b || '').trim() + ' ' + a.trim(); }
  const toks = nhlgKey(raw).split(' ').filter((t) => t && !/^(jr|sr|ii|iii|iv)$/.test(t));
  if (!toks.length) return null;
  if (toks.length === 1) return { first: '', last: toks[0] };
  return { first: toks[0], last: toks[toks.length - 1] };
}
/**
 * One reported name → a goalie id from the inputs' rated pool. Exact on the
 * surname and the first initial, first within the club (the goalies who have
 * played for it), then league-wide when exactly one goalie fits (a trade or
 * a call-up the club's history does not show yet). Anything else is
 * unmatched or ambiguous: kept, never guessed.
 */
function nhlgMatchGoalie(name, team, inputs) {
  const p = nhlgNameParts(name);
  if (!p) return { goalie_id: null, method: 'unmatched' };
  const pool = (inputs && inputs.goalies) || {};
  const fits = [];
  for (const id of Object.keys(pool)) {
    const g = pool[id], q = nhlgNameParts(g.name);
    if (!q || q.last !== p.last) continue;
    if (p.first && q.first && p.first[0] !== q.first[0]) continue;
    fits.push({ id, g, full: !!(p.first && q.first && p.first === q.first) });
  }
  const inTeam = fits.filter((x) => (x.g.teams || []).indexOf(team) >= 0);
  const pick = (list, scope) => {
    if (list.length === 1) return { goalie_id: list[0].id, method: scope + (list[0].full ? '_exact' : '_initial'), rated_name: list[0].g.name };
    const full = list.filter((x) => x.full);
    if (full.length === 1) return { goalie_id: full[0].id, method: scope + '_exact', rated_name: full[0].g.name };
    return null;
  };
  if (inTeam.length) return pick(inTeam, 'team') || { goalie_id: null, method: 'ambiguous' };
  if (fits.length) return pick(fits, 'league') || { goalie_id: null, method: 'ambiguous' };
  return { goalie_id: null, method: 'unmatched' };
}

/* ---------------------------------------------------------------- the sources */
function nhlgDailyFaceoffUrl(etDate) { return 'https://www.dailyfaceoff.com/starting-goalies/' + etDate; }
function nhlgBoxscoreUrl(gameId) { return 'https://api-web.nhle.com/v1/gamecenter/' + gameId + '/boxscore'; }

function nhlgWalk(x, fn, depth) {
  if (depth > 12 || x == null || typeof x !== 'object') return;
  if (Array.isArray(x)) { for (const y of x) nhlgWalk(y, fn, depth + 1); return; }
  fn(x);
  for (const k of Object.keys(x)) nhlgWalk(x[k], fn, depth + 1);
}
function nhlgFirst(o, keys) { for (const k of keys) if (o[k] != null && o[k] !== '') return o[k]; return null; }
/**
 * Daily Faceoff's starting-goalies page. The page is a Next.js render whose
 * __NEXT_DATA__ script carries every game as an object with
 * home/awayGoalieName, home/awayNewsStrengthName (Confirmed, Likely,
 * Unconfirmed), the team names and the news times. A page with no such
 * object is a DRIFT (the layout changed), never an empty slate.
 */
function nhlgParseDailyFaceoff(html, ctx) {
  ctx = ctx || {};
  const out = { ok: false, source: 'daily_faceoff', url: ctx.url || null, fetched_at: nhlgIso(ctx.fetched_at), rows: [], games: 0, unread: [], drift: null };
  const m = /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i.exec(String(html || ''));
  if (!m) { out.drift = 'the page has no __NEXT_DATA__ block'; return out; }
  let j;
  try { j = JSON.parse(m[1]); } catch (e) { out.drift = 'the __NEXT_DATA__ block is not JSON'; return out; }
  const games = [];
  nhlgWalk(j, (o) => { if (!Array.isArray(o) && ('homeGoalieName' in o || 'awayGoalieName' in o)) games.push(o); }, 0);
  if (!games.length) { out.drift = 'no game object with homeGoalieName / awayGoalieName'; return out; }
  out.ok = true; out.games = games.length;
  for (const o of games) {
    const home = nhlgTeam(nhlgFirst(o, ['homeTeamAbbreviation', 'homeTeamAbbr', 'homeTeamName', 'homeTeamSlug', 'homeTeam']));
    const away = nhlgTeam(nhlgFirst(o, ['awayTeamAbbreviation', 'awayTeamAbbr', 'awayTeamName', 'awayTeamSlug', 'awayTeam']));
    const start = nhlgIso(nhlgFirst(o, ['dateGmt', 'dateUtc', 'startTimeUTC', 'gameTimeUtc']));
    const date = nhlgFirst(o, ['date', 'gameDate']);
    if (!home || !away) { out.unread.push({ why: 'teams did not read', home: nhlgFirst(o, ['homeTeamName', 'homeTeamSlug']), away: nhlgFirst(o, ['awayTeamName', 'awayTeamSlug']) }); continue; }
    for (const side of ['home', 'away']) {
      const nm = o[side + 'GoalieName'] != null ? String(o[side + 'GoalieName']).trim() : '';
      const raw = nhlgFirst(o, [side + 'NewsStrengthName', side + 'StrengthName', side + 'GoalieStatus', side + 'Status']);
      out.rows.push({
        side, team: side === 'home' ? home : away, home, away, game_date: date ? String(date).slice(0, 10) : null, start_utc: start,
        goalie_name: nm || null, source_status: raw == null ? null : String(raw), status: nm ? nhlgStatus(raw) : 'unknown',
        source_updated_at: nhlgIso(nhlgFirst(o, [side + 'NewsUpdatedAt', side + 'NewsCreatedAt', 'updatedAt', 'modifiedAt'])),
        details: o[side + 'NewsDetails'] ? String(o[side + 'NewsDetails']).slice(0, 280) : null,
      });
    }
  }
  return out;
}
/**
 * The NHL's game boxscore (api-web.nhle.com/v1/gamecenter/{id}/boxscore).
 * playerByGameStats appears once lineups post; a goalie flagged
 * `starter: true` is the confirmed starter. Before that the boxscore says
 * nothing about starters, which is not a failure.
 */
function nhlgParseNhlBoxscore(json, ctx) {
  ctx = ctx || {};
  const out = { ok: false, source: 'nhl_api_boxscore', url: ctx.url || null, fetched_at: nhlgIso(ctx.fetched_at), game_id: null, state: null, rows: [], drift: null };
  if (!json || typeof json !== 'object' || json.id == null || !json.homeTeam || !json.awayTeam) { out.drift = 'not a boxscore (no id, homeTeam, awayTeam)'; return out; }
  out.ok = true; out.game_id = String(json.id); out.state = json.gameState || null;
  const pb = json.playerByGameStats || null;
  /* the dressed skaters (forwards and defence, never the goalies), once lineups post: null until then */
  out.lineups = { home: null, away: null };
  for (const side of ['home', 'away']) {
    const t = pb && pb[side + 'Team'];
    if (!t) continue;
    const ids = [].concat(Array.isArray(t.forwards) ? t.forwards : [], Array.isArray(t.defense) ? t.defense : []).map((x) => (x && x.playerId != null ? String(x.playerId) : null)).filter(Boolean);
    out.lineups[side] = ids.filter((id, i) => ids.indexOf(id) === i);
  }
  for (const side of ['home', 'away']) {
    const team = nhlgTeam(json[side + 'Team'].abbrev);
    const gs = pb && pb[side + 'Team'] && Array.isArray(pb[side + 'Team'].goalies) ? pb[side + 'Team'].goalies : [];
    const st = gs.filter((g) => g && g.starter === true);
    if (st.length !== 1) continue;
    const g = st[0], nm = g.name && typeof g.name === 'object' ? g.name.default : g.name;
    out.rows.push({ side, team, goalie_id: g.playerId != null ? String(g.playerId) : null, goalie_name: nm ? String(nm) : null, status: 'confirmed', source_status: 'starter', source_updated_at: null });
  }
  return out;
}

/* ---------------------------------------------------------------- the merge */
function nhlgIdentity(o) { return o && o.goalie_id ? 'id:' + o.goalie_id : o && o.goalie_name ? 'nm:' + nhlgKey(o.goalie_name) : null; }
function nhlgSummary(o) { return { source: o.source, goalie_id: o.goalie_id || null, goalie_name: o.goalie_name || null, status: o.status, source_updated_at: o.source_updated_at || null, fetched_at: o.fetched_at || null, row_id: o.id != null ? o.id : (o.row_id != null ? o.row_id : null) }; }
/**
 * One team's starter from every source's current observation.
 *   obs   [{ source, goalie_id, goalie_name, status, source_updated_at, fetched_at, id }]
 *   proj  the usage projection's likeliest goalie { goalie_id, goalie_name, p }, or null
 * Sources that name the same goalie: the highest status wins. Sources that
 * name different goalies: the lead source's goalie (NHL > manual > Daily
 * Faceoff), the LOWER of their statuses, capped at Likely (two sources naming
 * different starters is never a confirmation), conflict = true.
 */
function nhlgMergeSide(obs, proj) {
  const named = (obs || []).filter((o) => o && NHLG_SOURCES[o.source] && NHLG_SOURCES[o.source].observed && o.goalie_name && o.status && o.status !== 'unknown');
  if (!named.length) {
    if (proj && (proj.goalie_id || proj.goalie_name)) {
      return { goalie_id: proj.goalie_id ? String(proj.goalie_id) : null, goalie_name: proj.goalie_name || null, status: 'projected', source: 'edgedesk_projection', source_updated_at: nhlgIso(proj.as_of), as_of: nhlgIso(proj.as_of),
        p_start: proj.p != null ? nhlgR(proj.p) : null, conflict: false, conflict_detail: null, sources: [], basis: 'projection' };
    }
    return { goalie_id: null, goalie_name: null, status: 'unknown', source: null, source_updated_at: null, as_of: null, conflict: false, conflict_detail: null, sources: [], basis: 'none' };
  }
  const ids = {};
  for (const o of named) ids[nhlgIdentity(o)] = true;
  const byLead = named.slice().sort((a, b) => nhlgSourceRank(b.source) - nhlgSourceRank(a.source) || nhlgStatusRank(b.status) - nhlgStatusRank(a.status));
  if (Object.keys(ids).length === 1) {
    const best = named.slice().sort((a, b) => nhlgStatusRank(b.status) - nhlgStatusRank(a.status) || nhlgSourceRank(b.source) - nhlgSourceRank(a.source))[0];
    const withId = named.filter((o) => o.goalie_id)[0];
    return { goalie_id: best.goalie_id || (withId ? withId.goalie_id : null), goalie_name: best.goalie_name, status: best.status, source: best.source, source_updated_at: best.source_updated_at || null,
      as_of: nhlgIso(best.source_updated_at || best.fetched_at), conflict: false, conflict_detail: null, sources: named.map(nhlgSummary), basis: named.length > 1 ? 'sources_agree' : 'one_source' };
  }
  const lead = byLead[0];
  let st = named.map((o) => o.status).reduce(nhlgMinStatus);
  if (st === 'confirmed') st = 'likely';
  const alt = [];
  const seen = {}; seen[nhlgIdentity(lead)] = true;
  for (const o of byLead) { const k = nhlgIdentity(o); if (!seen[k]) { seen[k] = true; alt.push({ goalie_id: o.goalie_id || null, goalie_name: o.goalie_name, source: o.source, status: o.status }); } }
  return { goalie_id: lead.goalie_id || null, goalie_name: lead.goalie_name, status: st, source: lead.source, source_updated_at: lead.source_updated_at || null,
    as_of: nhlgIso(lead.source_updated_at || lead.fetched_at), conflict: true, conflict_detail: byLead.map(nhlgSummary), alternates: alt, sources: named.map(nhlgSummary), basis: 'sources_disagree' };
}

/**
 * The card names a matched goalie as EdgeDesk's goalie registry does
 * (hockey/data/goalies.json: "L. Meriläinen"), so a projection and a report
 * read alike; the source's own spelling is kept as reported_name.
 */
function nhlgDisplay(m, inputs) {
  const out = Object.assign({}, m);
  const g = m && m.goalie_id && inputs && inputs.goalies ? inputs.goalies[String(m.goalie_id)] : null;
  if (g && g.name) { if (m.goalie_name && m.goalie_name !== g.name) out.reported_name = m.goalie_name; out.goalie_name = g.name; }
  const named = (a) => { const x = a && a.goalie_id && inputs && inputs.goalies ? inputs.goalies[String(a.goalie_id)] : null; return x && x.name ? Object.assign({}, a, { goalie_name: x.name, reported_name: a.goalie_name }) : a; };
  if (Array.isArray(m && m.alternates)) out.alternates = m.alternates.map(named);
  if (Array.isArray(m && m.conflict_detail)) out.conflict_detail = m.conflict_detail.map(named);
  return out;
}

/* ---------------------------------------------------------------- pricing a pairing */
/**
 * A goalie's rating: the game's own (the slate's goalieRating at the game
 * date, for each club's recent starters and its projection), else the
 * league-wide pool's (a starter the club's history does not show), else the
 * replacement-level prior, flagged unrated.
 */
function nhlgRate(inputs, id, gi) {
  if (id != null && gi && gi.rates && gi.rates[String(id)] != null && isFinite(gi.rates[String(id)])) {
    const p = inputs.goalies && inputs.goalies[String(id)];
    return { rate: gi.rates[String(id)], rated: true, name: p ? p.name : null };
  }
  const g = id != null && inputs.goalies ? inputs.goalies[String(id)] : null;
  return g && isFinite(g.rate) ? { rate: g.rate, rated: true, name: g.name } : { rate: inputs.goalie_prior_rate, rated: false, name: null };
}
/** hockey/model/glm.js applyPairCalibration, verbatim in behaviour (tools/hockey/nhl_goalie_core.test.js holds the parity) */
function nhlgCalibrate(lh, la, cal) {
  if (!cal || (cal.a === 1 && cal.b === 1) || !cal.c) return { lh, la };
  const T = cal.c * Math.pow((lh + la) / cal.c, cal.a);
  const pi0 = lh / (lh + la); const z = cal.b * Math.log(pi0 / (1 - pi0)); const pi = 1 / (1 + Math.exp(-z));
  return { lh: T * pi, la: T * (1 - pi) };
}
/** the goalie-aware variant's expected regulation goals: each club scores against the OTHER club's goalie */
function nhlgLambdas(gi, model, rateHomeGoalie, rateAwayGoalie) {
  const lh = Math.exp(gi.eta.home + model.goalie_beta * rateAwayGoalie);
  const la = Math.exp(gi.eta.away + model.goalie_beta * rateHomeGoalie);
  return nhlgCalibrate(lh, la, model.pair_calibration);
}
/** every market the card and the edge gate read, from one distribution */
function nhlgMarkets(D, DIST, o) {
  o = Object.assign({}, NHLG_DEFAULTS, o || {});
  const pl = {}, tot = {};
  for (const L of o.puck_lines) { const x = DIST.spread(D, L); pl[L] = [nhlgR(x.win), nhlgR(x.push)]; }
  for (const L of o.total_lines) { const x = DIST.total(D, L); tot[L] = [nhlgR(x.over), nhlgR(x.push)]; }
  return { p_home: nhlgR(D.p_home), fair_home: DIST.probToAmerican(D.p_home), fair_away: DIST.probToAmerican(D.p_away), exp_total: nhlgR(DIST.expectedTotal(D), 2), fair_total_line: DIST.fairTotalLine(D).line, puck_line: pl, total: tot };
}
function nhlgPrice(gi, inputs, homeGoalie, awayGoalie, DIST, o) {
  const rh = nhlgRate(inputs, homeGoalie, gi), ra = nhlgRate(inputs, awayGoalie, gi);
  const lam = nhlgLambdas(gi, inputs.model, rh.rate, ra.rate);
  const D = DIST.game({ lamH: lam.lh, lamA: lam.la, effects: inputs.distribution.effects, ot: gi.type === 'P' ? { format: 'PO' } : inputs.distribution.ot, periods: false });
  return Object.assign(nhlgMarkets(D, DIST, o), { lambda: { home: nhlgR(lam.lh), away: nhlgR(lam.la) }, rated: { home: rh.rated, away: ra.rated } });
}

/* ---------------------------------------------------------------- the lineup-lock price */
/** ln(tonight's lineup value / the club's typical): each skater's recent time on ice per game, summed (hockey/model/lineups.js) */
function nhlgLineupDelta(ids, inputs, typical, o) {
  o = Object.assign({}, NHLG_DEFAULTS, o || {});
  if (!Array.isArray(ids) || ids.length < o.lock_min_skaters || !(typical > 0)) return null;
  const vals = (inputs && inputs.skater_values) || {}, prior = inputs && inputs.skater_prior_s != null ? inputs.skater_prior_s : 600;
  let v = 0; for (const id of ids) v += vals[String(id)] != null ? vals[String(id)] : prior;
  return Math.log(v / typical);
}
/**
 * The headline at lineup lock: both dressed lineups listed (lineups:
 * { home: [skater ids], away: [...] }) and both starters Confirmed, priced by
 * the variant that knows tonight's lineups and goalies (inputs.model.all_*).
 * null when any of it is missing: the headline then stays the slate's.
 */
function nhlgLockPrice(gi, inputs, merged, lineups, DIST, o) {
  o = Object.assign({}, NHLG_DEFAULTS, o || {});
  const M = inputs && inputs.model, L = gi && gi.lineup;
  if (!M || !M.all_beta || !M.all_pair_calibration || !L || !L.eta || !L.typical || !lineups || !nhlgBothConfirmed(merged)) return null;
  const dH = nhlgLineupDelta(lineups.home, inputs, L.typical.home, o), dA = nhlgLineupDelta(lineups.away, inputs, L.typical.away, o);
  if (dH == null || dA == null) return null;
  const rh = nhlgRate(inputs, merged.home.goalie_id, gi), ra = nhlgRate(inputs, merged.away.goalie_id, gi);
  const B = M.all_beta;
  const lam = nhlgCalibrate(Math.exp(L.eta.home + B.goalie * ra.rate + B.lu_own * dH + B.lu_opp * dA), Math.exp(L.eta.away + B.goalie * rh.rate + B.lu_own * dA + B.lu_opp * dH), M.all_pair_calibration);
  const D = DIST.game({ lamH: lam.lh, lamA: lam.la, effects: inputs.distribution.effects, ot: gi.type === 'P' ? { format: 'PO' } : inputs.distribution.ot, periods: false });
  const mk = nhlgMarkets(D, DIST, o), pl = mk.puck_line;
  const awayMinus = pl['1.5'] ? Math.max(0, 1 - pl['1.5'][0] - pl['1.5'][1]) : null;
  const before = gi.headline || {};
  return {
    basis: 'lineup_lock', model_id: M.all_model_id || null, p_home: mk.p_home, p_away: nhlgR(1 - D.p_home), fair_home: mk.fair_home, fair_away: mk.fair_away,
    exp_total: mk.exp_total, fair_total_line: mk.fair_total_line,
    puck_line: { home_minus_1_5: pl['-1.5'] ? pl['-1.5'][0] : null, away_minus_1_5: nhlgR(awayMinus), fair_home_minus_1_5: pl['-1.5'] ? DIST.probToAmerican(pl['-1.5'][0]) : null, fair_away_minus_1_5: awayMinus != null ? DIST.probToAmerican(awayMinus) : null },
    markets: { puck_line: pl, total: mk.total }, settles: before.settles || null, goalie_free: false, lambda: { home: nhlgR(lam.lh), away: nhlgR(lam.la) },
    lineup: { skaters: { home: lineups.home.length, away: lineups.away.length }, delta: { home: nhlgR(dH), away: nhlgR(dA) }, goalies: { home: merged.home.goalie_id || null, away: merged.away.goalie_id || null }, rated: { home: rh.rated, away: ra.rated } },
    before: { model_id: before.model_id || null, p_home: before.p_home != null ? before.p_home : null, fair_home: before.fair_home != null ? before.fair_home : null, fair_away: before.fair_away != null ? before.fair_away : null },
  };
}

/* ---------------------------------------------------------------- realistic pairings */
/**
 * The goalies who could realistically start for one side: the confirmed
 * starter alone; otherwise the current pick, any goalie another source names,
 * and the usage projection's alternates with at least alt_min_p.
 */
function nhlgCandidates(merged, proj, o) {
  o = Object.assign({}, NHLG_DEFAULTS, o || {});
  const out = [], seen = {};
  const add = (g, why) => {
    if (!g || (!g.goalie_id && !g.goalie_name)) return;
    const k = nhlgIdentity(g);
    if (seen[k] || out.length >= o.max_per_side) return;
    seen[k] = true; out.push({ goalie_id: g.goalie_id ? String(g.goalie_id) : null, goalie_name: g.goalie_name || null, why });
  };
  if (merged && merged.status === 'confirmed' && !merged.conflict && merged.goalie_name) { add(merged, 'confirmed'); return out; }
  if (merged) add(merged, merged.basis === 'projection' ? 'projected' : 'reported');
  for (const a of (merged && merged.alternates) || []) add(a, 'named by ' + nhlgSourceLabel(a.source));
  for (const p of (proj || []).slice().sort((a, b) => b.p - a.p)) if (p.p >= o.alt_min_p) add(p, 'usage projection ' + Math.round(p.p * 100) + '%');
  if (!out.length) out.push({ goalie_id: null, goalie_name: null, why: 'no starter known: the replacement-level prior' });
  return out;
}
function nhlgPairings(gi, inputs, merged, DIST, o) {
  const cH = nhlgCandidates(merged.home, (gi.projection && gi.projection.home) || [], o);
  const cA = nhlgCandidates(merged.away, (gi.projection && gi.projection.away) || [], o);
  const pickH = nhlgIdentity(merged.home), pickA = nhlgIdentity(merged.away);
  const out = [];
  for (const h of cH) for (const a of cA) {
    const pr = nhlgPrice(gi, inputs, h.goalie_id, a.goalie_id, DIST, o);
    out.push(Object.assign({ home_goalie_id: h.goalie_id, home_goalie_name: h.goalie_name, away_goalie_id: a.goalie_id, away_goalie_name: a.goalie_name,
      used: nhlgIdentity(h) === pickH && nhlgIdentity(a) === pickA }, pr));
  }
  if (!out.some((p) => p.used) && out.length) out[0].used = true;
  return out;
}

/* ---------------------------------------------------------------- the card */
function nhlgBothConfirmed(merged) { return !!(merged && merged.home && merged.away && merged.home.status === 'confirmed' && merged.away.status === 'confirmed' && !merged.home.conflict && !merged.away.conflict); }
function nhlgShortName(n) { return n == null ? null : String(n); }
function nhlgSidePick(m, rated) {
  return { goalie_id: m.goalie_id || null, goalie_name: m.goalie_name || null, status: m.status, badge: NHLG_BADGE[m.status] || 'Unknown', source: m.source || null, source_label: m.source ? nhlgSourceLabel(m.source) : null,
    source_updated_at: m.source_updated_at || null, as_of: m.as_of || null, reported_name: m.reported_name || null, conflict: !!m.conflict, conflict_detail: m.conflict_detail || null, basis: m.basis || null, p_start: m.p_start != null ? m.p_start : null,
    rated: rated == null ? null : !!rated, starter_row_id: m.row_id != null ? m.row_id : null };
}
function nhlgLimitations(gi, merged, used) {
  const out = [];
  if (!nhlgBothConfirmed(merged)) out.push('Starter not confirmed. Numbers may change.');
  for (const side of ['home', 'away']) {
    const m = merged[side], team = gi[side];
    if (m.conflict) out.push('Sources disagree on the ' + team + ' starter (' + (m.conflict_detail || []).map((c) => (c.goalie_name || '?') + ' per ' + nhlgSourceLabel(c.source)).join(', ') + '): shown as ' + (NHLG_BADGE[m.status] || m.status) + ', not as fact.');
    if (m.basis === 'projection') out.push('No source has posted a ' + team + ' starter yet: ' + (m.goalie_name || 'the likeliest goalie') + ' is EdgeDesk’s usage projection' + (m.p_start != null ? ' (' + Math.round(m.p_start * 100) + '% to start)' : '') + '.');
    if (m.basis === 'none') out.push('No source names a ' + team + ' starter and EdgeDesk has no usage history for the club: the pairing uses the replacement-level prior.');
    if (used && used.rated && used.rated[side] === false && m.goalie_name) out.push(m.goalie_name + ' (' + team + ') has no EdgeDesk goalie rating: the pairing prices him at the replacement-level prior.');
  }
  return out;
}
/**
 * The change note against the FIRST version posted: which starter changed,
 * from whom to whom, and both versions' win probability for the home club
 * under the pairing each used (the goalie-aware variant).
 */
function nhlgChangeNote(first, card) {
  if (!first || !card) return null;
  const sides = [];
  for (const side of ['home', 'away']) {
    const a = first.goalie_pairing_used && first.goalie_pairing_used[side], b = card.goalie_pairing_used && card.goalie_pairing_used[side];
    if (!a || !b || !a.goalie_name || !b.goalie_name) continue;
    if (nhlgIdentity(a) !== nhlgIdentity(b)) sides.push({ side, team: card[side], from: a.goalie_name, to: b.goalie_name });
  }
  if (!sides.length) return null;
  const fp = first.pairing_price && first.pairing_price.p_home, cp = card.pairing_price && card.pairing_price.p_home;
  return {
    text: 'Updated: starter changed from ' + sides.map((s) => s.from).join(' and ') + ' to ' + sides.map((s) => s.to).join(' and '),
    sides, first_version: first.version != null ? first.version : 1, first_card_id: first.id != null ? first.id : null, first_generated_at: first.generated_at || null,
    first_p_home: fp == null ? null : fp, current_p_home: cp == null ? null : cp, basis: 'the home club’s win probability under the pairing each version used (goalie-aware variant)',
  };
}
function nhlgStable(x) {
  if (x == null || typeof x !== 'object') return x;
  if (Array.isArray(x)) return x.map(nhlgStable);
  const o = {}; for (const k of Object.keys(x).sort()) o[k] = nhlgStable(x[k]); return o;
}
/** FNV-1a over the stable JSON: a content hash that is the same in Node, Deno and the browser */
function nhlgHash(x) {
  const s = JSON.stringify(nhlgStable(x)); let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619) >>> 0; h2 = Math.imul(h2 ^ c, 2246822519) >>> 0; }
  return ('00000000' + h1.toString(16)).slice(-8) + ('00000000' + h2.toString(16)).slice(-8);
}
/**
 * One game's card. gi: the game from hockey/goalie_inputs.json; merged:
 * { home, away } from nhlgMergeSide; first: the first version posted (for
 * the change note), or null.
 */
function nhlgBuildCard(gi, inputs, merged, DIST, o) {
  o = o || {};
  const pairs = nhlgPairings(gi, inputs, merged, DIST, o);
  const used = pairs.filter((p) => p.used)[0] || null;
  const both = nhlgBothConfirmed(merged);
  const ps = pairs.map((p) => p.p_home).filter((v) => v != null), ts = pairs.map((p) => p.exp_total).filter((v) => v != null);
  const lock = nhlgLockPrice(gi, inputs, merged, o.lineups || null, DIST, o);
  const card = {
    core_version: NHLG_CORE_VERSION, game_id: String(gi.game_id), start_utc: gi.start_utc, home: gi.home, away: gi.away, type: gi.type || 'R',
    generated_at: nhlgIso(o.now != null ? o.now : Date.now()),
    goalie_pairing_used: { home: nhlgSidePick(merged.home, used ? used.rated.home : null), away: nhlgSidePick(merged.away, used ? used.rated.away : null) },
    goalie_status: { home: merged.home.status, away: merged.away.status },
    conflict: !!(merged.home.conflict || merged.away.conflict),
    headline: lock || gi.headline || null,
    lineup_locked: !!lock,
    pairing_price: used ? { home_goalie_id: used.home_goalie_id, home_goalie_name: used.home_goalie_name, away_goalie_id: used.away_goalie_id, away_goalie_name: used.away_goalie_name,
      p_home: used.p_home, fair_home: used.fair_home, fair_away: used.fair_away, exp_total: used.exp_total, fair_total_line: used.fair_total_line, puck_line: used.puck_line, total: used.total, lambda: used.lambda } : null,
    pairing_range: pairs,
    range: { p_home: ps.length ? [Math.min.apply(null, ps), Math.max.apply(null, ps)] : null, exp_total: ts.length ? [Math.min.apply(null, ts), Math.max.apply(null, ts)] : null, pairings: pairs.length },
    show_range: !both,
    edge_gate: both
      ? { state: 'OPEN', basis: 'BOTH_CONFIRMED', rule: 'both starters are Confirmed: an edge is judged as before (lib/edgedesk_nhl_market.js)' }
      : { state: 'GATED', basis: 'EVERY_PAIRING', rule: 'a starter is not Confirmed: no EDGE on the moneyline, puck line or total unless it holds under every realistic pairing (' + pairs.length + ')' },
    known_limitations: nhlgLimitations(gi, merged, used),
    notes: lock
      ? ['Priced at lineup lock: both dressed lineups are listed by the NHL and both starters are Confirmed, so the headline numbers come from the variant that knows tonight’s lineups and goalies (' + (lock.model_id || 'xg_all_confirmed') + '). '
        + 'Before lock the headline was the production model (' + (lock.before.model_id || 'edgedesk_nhl_v1') + ', ' + gi.home + ' ' + (lock.before.p_home != null ? Math.round(lock.before.p_home * 1000) / 10 + '%' : '—') + '). '
        + 'The pairing numbers come from the goalie-aware variant (' + ((inputs.model && inputs.model.goalie_variant) || 'xg_goalie_confirmed') + ').']
      : ['The headline numbers are the production model (' + ((inputs.model && inputs.model.id) || 'edgedesk_nhl_v1') + '), which carries no goalie term: a starter change does not move them until lineup lock. '
        + 'The pairing numbers come from its goalie-aware variant (' + ((inputs.model && inputs.model.goalie_variant) || 'xg_goalie_confirmed') + '), the one the slate’s goalie scenarios use.'],
    model_id: (inputs.model && inputs.model.id) || null, goalie_variant: (inputs.model && inputs.model.goalie_variant) || null,
    slate_generated_at: inputs.slate_generated_at || inputs.generated_at || null,
  };
  card.change_note = nhlgChangeNote(o.first || null, card);
  card.inputs_hash = nhlgHash({ g: gi, m: inputs.model, d: inputs.distribution, r: pairs.map((p) => [p.home_goalie_id, p.away_goalie_id]).map((k) => k.concat([nhlgRate(inputs, k[0], gi).rate, nhlgRate(inputs, k[1], gi).rate])) });
  return card;
}

/**
 * Does `next` need a new card version over `prev`? A new version when a
 * starter changes, a status changes, a conflict opens or closes, or the
 * numbers changed with a new slate. Same goalie, same status, same numbers:
 * no new version (the run still records that it checked).
 */
function nhlgCardChange(prev, next) {
  if (!prev) return { changed: true, trigger: 'initial', reasons: ['initial'] };
  const reasons = [];
  const pu = prev.goalie_pairing_used || {}, nu = next.goalie_pairing_used || {};
  for (const side of ['home', 'away']) {
    const a = pu[side] || {}, b = nu[side] || {};
    if (nhlgIdentity(a) !== nhlgIdentity(b)) reasons.push('starter_changed:' + side);
    else if ((a.status || null) !== (b.status || null)) reasons.push('status_changed:' + side);
    if (!!a.conflict !== !!b.conflict) reasons.push('conflict_changed:' + side);
  }
  const locked = (c) => !!(c && c.headline && c.headline.basis === 'lineup_lock');
  if (locked(prev) !== locked(next)) reasons.push(locked(next) ? 'lineup_locked' : 'lineup_unlocked');
  const num = (c) => JSON.stringify([c.headline && c.headline.p_home, c.headline && c.headline.exp_total, c.pairing_price && c.pairing_price.p_home, c.pairing_price && c.pairing_price.exp_total,
    (c.pairing_range || []).map((p) => [p.home_goalie_id, p.away_goalie_id, p.p_home, p.exp_total])]);
  if (!reasons.some((r) => !/^lineup_/.test(r)) && num(prev) !== num(next)) reasons.push('inputs_changed');
  /* a lock moves the headline's numbers: it is recorded as its own reason under the inputs_changed trigger (the table's five triggers) */
  const order = ['starter_changed', 'status_changed', 'conflict_changed', 'inputs_changed'];
  const trigger = reasons.length ? order.filter((t) => reasons.some((r) => r.indexOf(t) === 0 || (t === 'inputs_changed' && /^lineup_/.test(r))))[0] : null;
  return { changed: reasons.length > 0, trigger, reasons };
}

/* ---------------------------------------------------------------- the edge gate */
function nhlgDec(american) { const a = Number(american); if (!isFinite(a) || Math.abs(a) < 100) return null; return a > 0 ? 1 + a / 100 : 1 + 100 / -a; }
function nhlgEv(p, push, american) { const d = nhlgDec(american); if (p == null || d == null) return null; const lose = Math.max(0, 1 - p - (push || 0)); return p * (d - 1) - lose; }
/** the probability one side of one market wins (and pushes) under one priced pairing */
function nhlgSideProb(pr, market, side, line) {
  if (!pr) return null;
  if (market === 'moneyline') return pr.p_home == null ? null : { p: side === 'home' ? pr.p_home : 1 - pr.p_home, push: 0 };
  if (market === 'puck_line') {
    const homeLine = side === 'home' ? Number(line) : -Number(line);
    const x = pr.puck_line && pr.puck_line[String(homeLine)];
    if (!x) return null;
    return side === 'home' ? { p: x[0], push: x[1] } : { p: Math.max(0, 1 - x[0] - x[1]), push: x[1] };
  }
  if (market === 'total') {
    const x = pr.total && pr.total[String(Number(line))];
    if (!x) return null;
    return side === 'over' ? { p: x[0], push: x[1] } : { p: Math.max(0, 1 - x[0] - x[1]), push: x[1] };
  }
  return null;
}
/**
 * May an edge on this price be flagged? q: { market: 'moneyline' | 'puck_line'
 * | 'total', side: 'home' | 'away' | 'over' | 'under', line (puck line: the
 * side's own line; total: the total), american, min_ev }.
 *   both starters Confirmed  -> OPEN: the edge is judged as it always was
 *   otherwise                -> allowed only if EV >= min_ev under EVERY
 *                               realistic pairing; a line some pairing has no
 *                               price for cannot pass
 */
function nhlgEdgeGate(card, q) {
  const minEv = q && q.min_ev != null ? q.min_ev : NHLG_DEFAULTS.min_ev;
  const rows = ((card && card.pairing_range) || []).map((pr) => { const x = nhlgSideProb(pr, q.market, q.side, q.line); return x ? nhlgEv(x.p, x.push, q.american) : null; });
  const priced = rows.length > 0 && rows.every((v) => v != null);
  const evMin = priced ? Math.min.apply(null, rows) : null;
  const usedX = nhlgSideProb(card && card.pairing_price, q.market, q.side, q.line);
  const evUsed = usedX ? nhlgEv(usedX.p, usedX.push, q.american) : null;
  const base = { ev_by_pairing: rows.map((v) => nhlgR(v)), ev_min: nhlgR(evMin), ev_pairing_used: nhlgR(evUsed), min_ev: minEv };
  if (card && card.edge_gate && card.edge_gate.state === 'OPEN') return Object.assign(base, { flag_allowed: true, basis: 'BOTH_CONFIRMED', reason: 'both starters are Confirmed' });
  if (!priced) return Object.assign(base, { flag_allowed: false, basis: 'GATED', reason: 'a starter is not Confirmed and this line is not priced under every realistic pairing' });
  if (evMin >= minEv) return Object.assign(base, { flag_allowed: true, basis: 'HOLDS_EVERY_PAIRING', reason: 'the edge holds under all ' + rows.length + ' realistic pairings (worst EV ' + (evMin * 100).toFixed(1) + '%)' });
  return Object.assign(base, { flag_allowed: false, basis: 'GATED', reason: 'a starter is not Confirmed and the edge does not hold under every realistic pairing (worst EV ' + (evMin * 100).toFixed(1) + '%, needs ' + (minEv * 100).toFixed(1) + '%)' });
}

/* ---------------------------------------------------------------- cadence (US Eastern) */
let NHLG_ETF = null;
function nhlgEtParts(t) {
  if (!NHLG_ETF) NHLG_ETF = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = {}; for (const x of NHLG_ETF.formatToParts(new Date(t))) p[x.type] = x.value;
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second, date: p.year + '-' + p.month + '-' + p.day };
}
function nhlgEtDate(t) { return nhlgEtParts(t).date; }
/** the UTC instant of an Eastern wall-clock time on an Eastern date */
function nhlgEtToUtc(date, hour, minute) {
  const [y, m, d] = String(date).split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d, hour, minute || 0);
  let t = wall + 5 * 3600e3;
  for (let i = 0; i < 3; i++) { const p = nhlgEtParts(t); const seen = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi); t += wall - seen; }
  return t;
}
/**
 * Every instant the sync is due for these games. games: [{ game_id, start_utc }].
 *   two_hour     8:00, 10:00, ... Eastern on each Eastern date with a game, until its last puck drop
 *   pre_game     every 15 minutes in the three hours before each puck drop
 *   final_pass   T-30 for each game
 *   lineup_lock  every 5 minutes after the final pass until puck drop (T-25 ... T-5)
 */
function nhlgDueTimes(games, o) {
  o = Object.assign({}, NHLG_DEFAULTS, o || {});
  const out = [], lastByDate = {};
  for (const g of games || []) {
    const s = Date.parse(g.start_utc); if (!isFinite(s)) continue;
    const d = nhlgEtDate(s); if (!(d in lastByDate) || s > lastByDate[d]) lastByDate[d] = s;
    for (let k = o.pre_window_min; k > 0; k -= o.pre_step_min) out.push({ at: s - k * 60e3, kind: k === o.final_pass_min ? 'final_pass' : 'pre_game', game_id: String(g.game_id) });
    if (o.pre_window_min % o.pre_step_min !== 0 || o.final_pass_min % o.pre_step_min !== 0) out.push({ at: s - o.final_pass_min * 60e3, kind: 'final_pass', game_id: String(g.game_id) });
    for (let k = Math.min(o.lock_window_min, o.final_pass_min) - o.lock_step_min; k > 0; k -= o.lock_step_min) out.push({ at: s - k * 60e3, kind: 'lineup_lock', game_id: String(g.game_id) });
  }
  for (const d of Object.keys(lastByDate)) {
    for (let h = o.first_et_hour; h < 24; h += o.every_hours) { const t = nhlgEtToUtc(d, h, 0); if (t >= lastByDate[d]) break; out.push({ at: t, kind: 'two_hour', game_id: null }); }
  }
  return out.sort((a, b) => a.at - b.at || (a.kind < b.kind ? -1 : 1));
}
/**
 * Is a run due now? last: the last EXECUTED run's start time (ISO or ms), or
 * null. A slot older than lookback_min is not chased (the next one runs).
 * Returns { due, kinds, final_pass_games, next_due_at }.
 */
function nhlgIsDue(now, last, games, o) {
  o = Object.assign({}, NHLG_DEFAULTS, o || {});
  const lt = last == null ? null : (typeof last === 'number' ? last : Date.parse(last));
  const all = nhlgDueTimes(games, o);
  const hit = all.filter((x) => x.at <= now && x.at > now - o.lookback_min * 60e3 && (lt == null || !isFinite(lt) || x.at > lt));
  const next = all.filter((x) => x.at > now)[0] || null;
  const kinds = []; for (const x of hit) if (kinds.indexOf(x.kind) < 0) kinds.push(x.kind);
  return { due: hit.length > 0, kinds, final_pass_games: hit.filter((x) => x.kind === 'final_pass').map((x) => x.game_id), next_due_at: next ? new Date(next.at).toISOString() : null };
}
// ── END NHL GOALIE CORE ───────────────────────────────────────────────────

const EDNHLGoalieCore = {
  NHLG_CORE_VERSION, NHLG_STATUSES, NHLG_BADGE, NHLG_SOURCES, NHLG_DEFAULTS, NHLG_TEAMS, nhlgR, nhlgIso,
  nhlgStatus, nhlgStatusRank, nhlgMinStatus, nhlgSourceLabel, nhlgKey, nhlgTeam, nhlgNameParts, nhlgMatchGoalie,
  nhlgDailyFaceoffUrl, nhlgBoxscoreUrl, nhlgParseDailyFaceoff, nhlgParseNhlBoxscore,
  nhlgIdentity, nhlgMergeSide, nhlgDisplay, nhlgRate, nhlgCalibrate, nhlgLambdas, nhlgMarkets, nhlgPrice, nhlgLineupDelta, nhlgLockPrice, nhlgCandidates, nhlgPairings,
  nhlgBothConfirmed, nhlgLimitations, nhlgChangeNote, nhlgBuildCard, nhlgCardChange, nhlgStable, nhlgHash,
  nhlgDec, nhlgEv, nhlgSideProb, nhlgEdgeGate, nhlgEtParts, nhlgEtDate, nhlgEtToUtc, nhlgDueTimes, nhlgIsDue,
};
if (typeof module === 'object' && module && module.exports) module.exports = EDNHLGoalieCore;
if (typeof window !== 'undefined') window.EDNHLGoalieCore = EDNHLGoalieCore;
