'use strict';
/* ===========================================================================
   EdgeDesk slate — which research each game already has.

   The slate creates no research. For every event it looks up what EdgeDesk's
   own artifacts already hold for that game and records the reference:

     where the research lives   module + entity  → #research/<module>/<entity>
     a free published article   articles/data/published.json
     the model's own number     the sport's slate (status, tier, fair prices)
     the board's read           the CFB terminal's status (RESEARCH, PASS …)
     an actionable signal       ONLY a decision the existing validation
                                certified: the CFB decision engine's BET, or
                                the cross-sport engine's BEST_SUPPORTED pick.
                                Nothing else is ever marked actionable here,
                                and no threshold is restated: the slate reads
                                the verdict the owning engine already wrote.

   A game with nothing gets research: { module: null } and the page says
   "Research not available yet". It is still on the slate.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const G = require(path.join(__dirname, '..', '..', 'lib', 'edgedesk_games.js'));
const NHLC = require(path.join(__dirname, '..', '..', 'lib', 'edgedesk_nhl_compare.js'));
const ROOT = path.join(__dirname, '..', '..');

function readJson(rel) {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')); } catch (_) { return null; }
}
const num = (v) => (v === null || v === undefined || v === '' || !isFinite(Number(v)) ? null : Number(v));
const ms = (t) => G.toMs(t);

/* Load every artifact once. `files` overrides a path (tests). */
function loadSources(files) {
  files = files || {};
  const r = (k, rel) => (files[k] !== undefined ? files[k] : readJson(rel));
  return {
    nfl: r('nfl', 'football/nfl/slate.json'),
    cfb: r('cfb', 'football/cfb_terminal/board.json'),
    home: r('home', 'football/home/schedule.json'),
    nhl: r('nhl', 'hockey/slate.json'),
    nhlTeams: r('nhlTeams', 'hockey/data/teams.json'),
    basketball: r('basketball', 'basketball/slate.json'),
    soccer: r('soccer', 'soccer/slate.json'),
    engine: r('engine', 'engine/board.json'),
    published: r('published', 'articles/data/published.json')
  };
}

function articles(pub) {
  const pre = {}, post = {};
  ((pub && pub.articles) || []).forEach((a) => {
    if (!a || !a.game_id || !a.url) return;
    (a.type === 'postgame' ? post : pre)[String(a.game_id)] = { url: a.url, type: a.type || 'pregame', title: a.title || null };
  });
  return { pre, post };
}
/* the article a reader wants now: the postgame once the game is over */
function articleFor(arts, id, e) {
  const done = e.status === 'FINAL';
  return (done && arts.post[id]) || arts.pre[id] || (done ? null : null);
}

/* ------------------------------------------------------------- per sport */
function nflIndex(src) {
  const rows = (src.nfl && src.nfl.games) || [];
  const pr = (src.nfl && src.nfl.pricing) || {};
  const tier = pr.tier || null;
  const priced = {};
  (pr.rows || []).forEach((x) => { if (x && x.game_id) priced[String(x.game_id)] = x; });
  return rows.map((g) => ({ g, tier, price: priced[String(g.game_id)] || null, ev: { sport: 'nfl', start_utc: g.kickoff, home: { name: g.home_team, abbr: g.home_code }, away: { name: g.away_team, abbr: g.away_code } } }));
}
function cfbIndex(src) {
  const by = {};
  ((src.cfb && src.cfb.rows) || []).forEach((r) => { if (r && r.game_id != null) by[String(r.game_id)] = r; });
  return { by, statuses: (src.cfb && src.cfb.statuses) || {} };
}
function nhlIndex(src) {
  const t = (src.nhlTeams && src.nhlTeams.teams) || {};
  const val = src.nhl && src.nhl.readiness && src.nhl.readiness.model ? src.nhl.readiness.model : {};
  return ((src.nhl && src.nhl.games) || []).map((g) => ({ g, val, ev: { sport: 'nhl', start_utc: g.start_utc,
    home: { name: (t[g.home] && t[g.home].name) || g.home, abbr: g.home }, away: { name: (t[g.away] && t[g.away].name) || g.away, abbr: g.away } } }));
}
function basketballIndex(src) {
  const by = {};
  const L = (src.basketball && src.basketball.leagues) || {};
  [['nba', 'nba'], ['ncaam', 'ncaam']].forEach(([lk, sid]) => {
    ((L[lk] && L[lk].games) || []).forEach((g) => { if (g.game_id != null) by[sid + ':' + g.game_id] = { g, L: L[lk] }; });
  });
  return by;
}
function soccerIndex(src) {
  const out = [];
  const L = (src.soccer && src.soccer.leagues) || {};
  Object.keys(L).forEach((lk) => (L[lk].games || []).forEach((g) => out.push({ g, lk, L: L[lk] })));
  return out;
}

function modelFromNfl(row, tier) {
  if (!row) return null;
  const st = String(row.model_status || '').toUpperCase();
  return {
    status: st || null, tier: tier || null, data_quality: row.data_quality && row.data_quality.status ? String(row.data_quality.status).toUpperCase() : (typeof row.data_quality === 'string' ? row.data_quality.toUpperCase() : null),
    home_line: num(row.model_home_line), source: 'football/nfl/slate.json',
    fair: { spread_home: num(row.model_home_line), total: num(row.model_fair_total), ml_home: num(row.model_fair_home_ml), ml_away: num(row.model_fair_away_ml), home_win: num(row.model_home_win_prob) }
  };
}
function modelFromCfb(row) {
  if (!row) return null;
  const m = num(row.fair_home_margin);
  return {
    status: m != null ? 'PREDICTED' : 'NO_PROJECTION', tier: null,
    data_quality: row.status === 'DATA_FAULT' ? 'FAULT' : 'OK',
    home_line: m != null ? (m === 0 ? 0 : -m) : null, source: 'football/cfb_terminal/board.json',
    fair: { spread_home: m != null ? (m === 0 ? 0 : -m) : null, total: num(row.fair_total), home_win: num(row.win_prob && (row.win_prob.home != null ? row.win_prob.home : row.win_prob)) }
  };
}
/* `view` is EdgeDesk's NHL probabilities in the compact shape
   lib/edgedesk_nhl_compare.js reads, so the matchup view can set them against
   the captured price without loading the NHL slate */
function modelFromNhl(row, val, slate) {
  if (!row || !row.prices) return null;
  const ml = row.prices.moneyline || {}, pl = row.prices.puck_line || {}, tot = row.prices.total || {};
  const mlStatus = val.moneyline && val.moneyline.status ? val.moneyline.status : null;
  return {
    status: 'PREDICTED', tier: mlStatus, data_quality: 'OK', home_line: num(ml.fair_home), source: 'hockey/slate.json',
    fair: { ml_home: num(ml.fair_home), ml_away: num(ml.fair_away), total: num(tot.fair_line), puck_home_minus_1_5: num(pl.fair_home_minus_1_5), puck_away_plus_1_5: num(pl.fair_away_plus_1_5) },
    note: 'value claims are off until the NHL model is tested against the closing market',
    view: NHLC.view(row, slate, { compact: true })
  };
}
function modelFromLab(g, L, src) {
  if (!g || !g.prices) return null;
  const p = g.prices;
  const tw = p.three_way || null, ml = p.moneyline || null, sp = p.spread || null, tot = p.total || null;
  const st = (L && L.validation) || {};
  return {
    status: 'PREDICTED', tier: (tw && tw.status) || st.moneyline || st.three_way || null, data_quality: L && L.data && L.data.state === 'STALE' ? 'LIMITED' : 'OK',
    home_line: num(tw ? tw.fair_home : (ml ? ml.fair_home : null)), source: src,
    fair: tw ? { ml_home: num(tw.fair_home), ml_draw: num(tw.fair_draw), ml_away: num(tw.fair_away), total_over_2_5: num(tot && tot.fair_over_2_5), expected_total: num(tot && tot.expected) }
      : { ml_home: num(ml && ml.fair_home), ml_away: num(ml && ml.fair_away), spread_home: num(sp && (sp.fair_line != null ? sp.fair_line : sp.home_line)), total: num(tot && (tot.fair_line != null ? tot.fair_line : tot.expected)) },
    note: L && L.value_reason ? 'value claims are off: ' + L.value_reason : null
  };
}

/* The cross-sport engine's verdict for a game: actionable only when the
   engine itself chose it (BEST_SUPPORTED) — never a candidate it passed on. */
function engineSignal(src, e) {
  const b = src.engine;
  if (!b || b.verdict !== 'BEST_SUPPORTED' || !b.best || !b.best.event) return null;
  const be = b.best.event;
  const cand = { sport: e.sport, start_utc: be.start_utc, home: { name: be.home }, away: { name: be.away } };
  if (!G.sameEvent(e, cand, 36)) return null;
  return { actionable: true, status: 'BEST_SUPPORTED', label: 'Best supported: ' + (b.best.label || ''), why: (b.why || []).join(' '), source: 'engine/board.json' };
}

/* ---------------------------------------------------------------- join */
function join(events, src, o) {
  o = o || {};
  src = src || loadSources();
  const arts = articles(src.published);
  const nfl = nflIndex(src), cfb = cfbIndex(src), nhl = nhlIndex(src), bb = basketballIndex(src), soc = soccerIndex(src);
  const homeKeys = {};
  ((src.home && src.home.games) || []).forEach((g) => { homeKeys[g.key] = true; });
  const stats = { joined: {}, unmatched: {} };
  const bump = (k, sport) => { stats[k][sport] = (stats[k][sport] || 0) + 1; };

  events.forEach((e) => {
    const r = { module: null, entity: null, game_key: null, article: null, model: null, metrics: false, read: null, signal: null };
    const sp = G.sport(e.sport);
    if (e.sport === 'nfl') {
      let hit = e.provider === 'nflverse' ? nfl.find((x) => String(x.g.game_id) === e.provider_id) : null;
      if (!hit) { const c = nfl.filter((x) => G.sameEvent(e, x.ev, 36)); if (c.length === 1) hit = c[0]; }
      const gid = hit ? String(hit.g.game_id) : null;
      if (gid) {
        r.module = 'football'; r.entity = 'nfl|' + gid; r.game_key = 'nfl|' + gid;
        r.model = modelFromNfl(hit.g, hit.tier); r.metrics = !!(hit.g.features);
        r.article = articleFor(arts, gid, e);
        /* the NFL pricer's own status for the game. Only PLAY under a
           VALIDATED tier is a certified signal; LEAN_PLAY is "the record
           cleared break-even, not a profit" and stays a read */
        const px = hit.price;
        if (px) {
          r.read = { status: px.status, label: String(px.status || '').replace(/_/g, ' '), means: px.why || null, tier: px.tier || hit.tier || null };
          r.signal = px.status === 'PLAY' && String(px.tier || hit.tier || '').toUpperCase() === 'VALIDATED'
            ? { actionable: true, status: 'PLAY', label: 'Validated: ' + (px.selection || '') + (px.bet_to_line != null ? ' to ' + px.bet_to_line : ''), why: px.why || null, source: 'football/nfl/slate.json' }
            : { actionable: false, status: px.status || null, why: px.why || null, source: 'football/nfl/slate.json' };
        }
      }
    } else if (e.sport === 'cfb') {
      const id = e.provider === 'espn' ? e.provider_id : null;
      const row = id ? cfb.by[id] : null;
      if (id && (row || homeKeys['cfb|' + id])) {
        r.module = 'football'; r.entity = id; r.game_key = 'cfb|' + id;
        r.article = articleFor(arts, id, e);
      }
      if (row) {
        r.model = modelFromCfb(row); r.metrics = true;
        const def = cfb.statuses[row.status] || {};
        r.read = { status: row.status, label: def.label || row.status_label || row.status, means: def.means || null, reason: row.status_reason || null };
        /* the decision engine's own certification is the only CFB signal */
        r.signal = row.decision_status === 'BET'
          ? { actionable: true, status: 'BET', label: 'Certified: ' + (row.decision_label || 'BET'), why: row.decision_reason || null, source: 'football/cfb_terminal/board.json' }
          : { actionable: false, status: row.decision_status || null, why: row.decision_reason || null, source: 'football/cfb_terminal/board.json' };
      }
    } else if (e.sport === 'nhl') {
      let hit = e.provider === 'nhl' ? nhl.find((x) => String(x.g.game_id) === e.provider_id) : null;
      const byId = !!hit;
      if (!hit) { const c = nhl.filter((x) => G.sameEvent(e, x.ev, 6)); if (c.length === 1) hit = c[0]; }
      if (hit) {
        r.module = 'nhl'; r.entity = String(hit.g.game_id); r.model = modelFromNhl(hit.g, hit.val, src.nhl); r.metrics = true;
        /* a match by teams that the two sources list the other way round
           keeps its research link, but EdgeDesk's numbers are never set
           against this event's prices: the comparison is refused, not repaired */
        if (!byId && !(G.sameSide('nhl', e.home, hit.ev.home) && G.sameSide('nhl', e.away, hit.ev.away))) { r.sides_swapped = true; if (r.model) r.model.view = null; }
      }
    } else if (e.sport === 'mlb') {
      /* the MLB card keys a game by its Eastern date, both clubs and the game
         number (app.html mlbbKey); the card holds today and tomorrow */
      const t = ms(e.start_utc);
      const day = t != null ? G.etDay(t) : null;
      const nowDay = G.etDay(o.now != null ? o.now : Date.now());
      if (day && (day === nowDay || day === G.addDays(nowDay, 1) || day === G.addDays(nowDay, -1))) {
        const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        r.module = 'baseball';
        r.entity = 'g:mlb:' + day + '|' + norm(e.away.name) + '|' + norm(e.home.name) + '|' + (e.game_number || (e.doubleheader && e.doubleheader.game) || 1);
        r.note = 'Opens the MLB card for this game; the brief needs the card row EdgeDesk loads for today and tomorrow.';
      }
    } else if (e.sport === 'ncaabase') {
      if (e.provider === 'espn') { r.module = 'baseball'; r.entity = 'g:cbb:' + e.provider_id; }
    } else if (e.sport === 'mma') {
      /* the UFC panel researches fighters and runs the live fight center; it
         has no per-card route, so the link opens the panel itself */
      r.module = 'ufc'; r.entity = null; r.note = 'Opens UFC research: fighter records and the live fight center.';
    } else if (e.sport === 'nba' || e.sport === 'ncaam') {
      const hit = e.provider === 'espn' ? bb[e.sport + ':' + e.provider_id] : null;
      if (hit) { r.model = modelFromLab(hit.g, hit.L, 'basketball/slate.json'); r.metrics = true; }
    } else if (e.sport === 'soccer') {
      const c = soc.filter((x) => {
        if (e.model_league && x.lk !== e.model_league) return false;
        const cand = { sport: 'soccer', start_utc: x.g.date + 'T12:00:00Z', home: { name: x.g.home }, away: { name: x.g.away } };
        return G.sameEvent(e, cand, 36);
      });
      if (c.length === 1) { r.model = modelFromLab(c[0].g, c[0].L, 'soccer/slate.json'); r.metrics = true; r.model_key = c[0].g.event_key; }
    }
    const eng = engineSignal(src, e);
    if (eng) r.signal = eng;
    if (!sp) r.module = null;
    e.research = r;
    bump(r.module || r.model ? 'joined' : 'unmatched', e.sport);
  });
  return stats;
}

module.exports = { loadSources, join, articles };
