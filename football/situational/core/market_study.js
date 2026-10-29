/* ============================================================================
   FSIE — the 2026 prop-market study over what the props pipeline captured.

   For every captured event in football/props/<lg>/<season>/closes.jsonl and
   every pass-attempts / rush-attempts / receptions prop on it:
     model input time  the latest kickoff among both teams' earlier games,
                       plus a 24-hour publication allowance (nflverse and the
                       ESPN mirror post a game's plays within a day)
     entry             the first consensus snapshot AT OR AFTER that time and
                       before kickoff — the first line the model could have
                       met. An event whose every snapshot precedes the
                       model's inputs is excluded with that reason.
     game line         NFL: EdgeDesk's own opener capture
                       (football/pricing/openers_nfl.json) as last seen at or
                       before the entry; college: none is captured for 2026,
                       so the market-free ('opponent') variant is used and
                       the row says so
     availability      NOT applied: the game-week injury report postdates
                       most entries; a player who then sits produces a VOID
                       outcome, and his line CLV is still measured
     close             the last consensus snapshot before kickoff
   Flags use the preregistered thresholds (core/market.js FLAG). CLV is the
   project's own (lib/edgedesk_props.js clv). Outcomes are reported apart
   from CLV: a favourable close is not a correct result.
   ========================================================================== */
'use strict';
const path = require('path');
const U = require(path.join(__dirname, 'util.js'));
const I = require(path.join(__dirname, 'ingest.js'));
const R = require(path.join(__dirname, 'research.js'));
const VM = require(path.join(__dirname, 'volume_model.js'));
const PM = require(path.join(__dirname, 'player_model.js'));
const MK = require(path.join(__dirname, 'market.js'));
const EDP = require(path.join(__dirname, '..', '..', '..', 'lib', 'edgedesk_props.js'));

const ROOT = path.join(__dirname, '..', '..', '..');
const DAY = 86400000;

function norm(s) { return EDP.normName(String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\u2018\u2019\u02bb\u02bc']/g, '')); }
/* The Odds API's school names that do not start with the schedule's name */
const CFB_ALIAS = { 'umass': 'massachusetts', 'southern mississippi': 'southern miss', 'appalachian state': 'app state', 'ul monroe': 'louisiana monroe', 'miami fl': 'miami', 'miami oh': 'miami (oh)', 'sam houston state': 'sam houston', 'connecticut': 'uconn' };
function cfbName(s) { let n = norm(s); Object.keys(CFB_ALIAS).forEach((k) => { if (n === k || n.indexOf(k + ' ') === 0) n = norm(CFB_ALIAS[k]) + n.slice(k.length); }); return n; }

/* event -> game. NFL: full team names via the props pipeline's own TEAM_NAMES. */
function nflEventMap(d) {
  const TN = require(path.join(ROOT, 'football', 'props', 'sources', 'nfl.js')).TEAM_NAMES;
  const N = require(path.join(__dirname, '..', 'nfl', 'source.js'));
  const byName = {}; Object.keys(TN).forEach((code) => { byName[norm(TN[code])] = N.team(code); });
  return (ev) => {
    const h = byName[norm(ev.home_team)], a = byName[norm(ev.away_team)];
    if (!h || !a) return null;
    const t = Date.parse(ev.commence_time);
    const g = (d.schedule || []).find((x) => x.home === h && x.away === a && Math.abs(Date.parse(x.kickoff_at) - t) < 1.5 * DAY);
    return g || null;
  };
}
/* college: the longest schedule name that prefixes the provider's name, same day */
function cfbEventMap(d) {
  return (ev) => {
    const t = Date.parse(ev.commence_time); const H = cfbName(ev.home_team), A = cfbName(ev.away_team);
    let best = null, score = -1;
    (d.schedule || []).forEach((g) => {
      if (!g.kickoff_at || Math.abs(Date.parse(g.kickoff_at) - t) > 1.5 * DAY) return;
      const h = cfbName(g.home_name), a = cfbName(g.away_name);
      if (!h || !a) return;
      const ok = (H === h || H.indexOf(h + ' ') === 0) && (A === a || A.indexOf(a + ' ') === 0);
      if (ok && h.length + a.length > score) { score = h.length + a.length; best = g; }
    });
    return best;
  };
}

/* player name -> id within the game's two teams */
function playerMap(sport, d, rosterRows) {
  const by = {};
  if (sport === 'nfl') (rosterRows || []).forEach((r) => { const k = r.team + '|' + norm(r.full_name); if (r.gsis_id) by[k] = r.gsis_id; });
  else d.player_games.forEach((p) => { if (p.name) by[p.team + '|' + norm(p.name)] = p.player_id; });
  return (team, name) => by[team + '|' + norm(name)] || null;
}

function openerAt(openers, gid, at) {
  const g = openers && openers.games && openers.games[gid]; if (!g) return null;
  let pick = null;
  ['open', 'latest'].forEach((k) => { const x = g[k]; if (x && x.seen_at && x.seen_at <= at && U.isNum(x.home_line)) { if (!pick || x.seen_at > pick.seen_at) pick = x; } });
  return pick ? { home_margin: -pick.home_line, total: pick.total, seen_at: pick.seen_at } : null;
}

async function study(sport, season, P, opts) {
  opts = opts || {};
  const d = I.loadDerived(sport, season, opts); if (!d) throw new Error('no derived ' + sport + ' ' + season);
  const sp = await R.seasonPanel(sport, season, P.shrinkage_k, opts);
  const rowsBy = {}; sp.rows.forEach((r) => { rowsBy[r.game_id + '|' + r.team] = r; });
  const pstates = PM.playerStates(sport, d, sp.prev);
  const actual = {}; d.player_games.forEach((p) => { actual[p.game_id + '|' + p.player_id] = p; });
  const lastBefore = {}; /* team -> sorted kickoff list */
  d.team_games.forEach((r) => { (lastBefore[r.team] = lastBefore[r.team] || []).push(r.kickoff_at); });
  Object.values(lastBefore).forEach((a) => a.sort());
  const prevKick = (team, k) => { const a = lastBefore[team] || []; let p = null; for (const x of a) { if (x < k) p = x; else break; } return p; };
  const closes = MK.readCloses(path.join(ROOT, 'football', 'props', sport, String(season), 'closes.jsonl'));
  const map = sport === 'nfl' ? nflEventMap(d) : cfbEventMap(d);
  let roster = null;
  if (sport === 'nfl') { const N = require(path.join(__dirname, '..', 'nfl', 'source.js')); roster = await N.loadRosters(season, Object.assign({ current_season: season }, opts)); }
  const pid = playerMap(sport, d, roster && roster.rows);
  const openers = sport === 'nfl' ? U.readJson(path.join(ROOT, 'football', 'pricing', 'openers_nfl.json')) : null;
  const out = []; const events = { total: closes.length, mapped: 0, unmapped: [] };
  for (const ev of closes) {
    const g = map(ev);
    if (!g) { events.unmapped.push(ev.home_team + ' vs ' + ev.away_team + ' ' + ev.commence_time); continue; }
    events.mapped++;
    const a = rowsBy[g.game_id + '|' + g.home], b = rowsBy[g.game_id + '|' + g.away];
    const props = MK.propsOf(ev);
    if (!a || !b) { props.forEach((p) => out.push({ game_id: g.game_id, market: p.market, player_name: p.player_name, exclusion: 'game not in the accepted play-by-play' })); continue; }
    const pk = [prevKick(g.home, g.kickoff_at), prevKick(g.away, g.kickoff_at)].filter(Boolean).sort().pop();
    const modelAt = pk ? new Date(Date.parse(pk) + DAY).toISOString() : null;
    for (const p of props) {
      const team = [g.home, g.away].find((t) => pid(t, p.player_name));
      const base = { sport, game_id: g.game_id, event_id: ev.event_id, market: p.market, player_name: p.player_name, model_as_of: modelAt, commence_time: ev.commence_time };
      if (!team) { out.push(Object.assign(base, { exclusion: 'player not matched to either roster' })); continue; }
      const id = pid(team, p.player_name);
      const snaps = MK.snapshotsAfter(p.books, modelAt, ev.commence_time);
      if (!snaps.length) { out.push(Object.assign(base, { player_id: id, exclusion: 'no line observed after the model inputs were available' })); continue; }
      const entryAt = snaps[0];
      const entry = MK.consensusAt(p.books, entryAt);
      const lastPre = MK.snapshotsAfter(p.books, null, ev.commence_time).pop();
      const close = lastPre && lastPre > entryAt ? MK.consensusAt(p.books, lastPre) : null;
      /* the team's row with the line known at entry */
      const row = Object.assign({}, team === g.home ? a : b);
      let variant = P.primary_variant;
      const op = openerAt(openers, g.game_id, entryAt);
      if (op) { const isHome = team === g.home; row.m = isHome ? op.home_margin : -op.home_margin; row.total = op.total; row.m_source = 'line'; }
      else variant = 'opponent';
      const other = Object.assign({}, team === g.home ? b : a);
      if (op) { other.m = -row.m; other.total = op.total; other.m_source = 'line'; }
      const sim = VM.simulateGame(P.team, row, other, { variant, draws: opts.draws || 1500, keep_draws: true, seed: 'study|' + g.game_id + '|' + team, phi: P.team.phi });
      const st = pstates.get(g.game_id + '|' + team);
      const pl = st && st.players.find((x) => x.player_id === id);
      if (!pl) { out.push(Object.assign(base, { player_id: id, exclusion: 'player not eligible for a projection (fewer than two active games, or inactive in the team\'s last two)' })); continue; }
      const tm = R.teamMeanForPlayers(P.team, variant, row, P.player.targeted_ratio, P.player.starter_share, P.player.rates);
      const players = PM.applyAvailability(sport, st.players, null);
      const means = PM.projectMeans(tm, players, sport);
      const k = players.findIndex((x) => x.player_id === id);
      const kmul = P.player.kappa_multiplier || {};
      const kap = { pass: PM.CFG.kappa.pass * (kmul.pass_att || 1), rush: PM.CFG.kappa.rush * (kmul.rush_att || 1), target: PM.CFG.kappa.target * (kmul.targets || 1) };
      const ps = PM.simulatePlayers(tm, sim.a.draws, [players[k]], { kappa: kap, seed: 'studyp|' + g.game_id + '|' + id, keep_draws: true })[0];
      if (p.market === 'pass_att' && players[k].role !== 'QB') { out.push(Object.assign(base, { player_id: id, exclusion: 'not the projected quarterback' })); continue; }
      const proj = ps[p.market];
      const cmp = MK.compare(proj, entry, { sport, game_id: g.game_id, event_id: ev.event_id, player_id: id, player_name: p.player_name, market: p.market, model_version: P.model_version, model_as_of: modelAt, draws: ps.draws[p.market] });
      cmp.entry_at = entryAt; cmp.variant = variant; cmp.game_line = op ? 'opener_at_entry' : 'none_market_free_variant';
      cmp.direction = MK.direction(p.market, cmp.difference);
      const a2 = actual[g.game_id + '|' + id];
      const played = !!(a2 && a2.pass_att + a2.dropbacks + a2.rush_att + a2.targets > 0);
      if (cmp.direction) {
        cmp.clv = MK.clvRow(cmp.direction, entry, close, entryAt, lastPre);
        cmp.outcome = played ? MK.outcome(cmp.direction, entry.line, a2[p.market]) : 'VOID';
      }
      cmp.actual = played ? a2[p.market] : null;
      out.push(cmp);
    }
  }
  const valid = out.filter((r) => !r.exclusion);
  return {
    schema: 'edgedesk_fsie_market_study_v1', sport, season, model_version: P.model_version, built_at: opts.now || new Date().toISOString(),
    method: 'entry = first consensus line at or after model inputs were available; close = last consensus before kickoff; CLV per lib/edgedesk_props.js; flags at |median - line| >= ' + JSON.stringify(MK.FLAG),
    events, rows_total: out.length, comparisons: valid.length,
    exclusions: out.filter((r) => r.exclusion).reduce((o, r) => { o[r.exclusion] = (o[r.exclusion] || 0) + 1; return o; }, {}),
    summary: MK.summarize(valid), model_vs_actual: mae(valid),
    rows: valid.map((r) => { const o = Object.assign({}, r); return o; })
  };
}
function mae(rows) {
  const by = {};
  rows.forEach((r) => { if (!U.isNum(r.actual)) return; const s = by[r.market] || (by[r.market] = { n: 0, model_abs: 0, line_abs: 0 }); s.n++; s.model_abs += Math.abs(r.model_median - r.actual); s.line_abs += Math.abs(r.market_line - r.actual); });
  Object.values(by).forEach((s) => { s.model_mae = U.round(s.model_abs / s.n, 3); s.entry_line_mae = U.round(s.line_abs / s.n, 3); delete s.model_abs; delete s.line_abs; });
  return by;
}

module.exports = { study, nflEventMap, cfbEventMap, playerMap, openerAt };
