'use strict';
/* ===========================================================================
   NCAAM-EARLY — prior-season ratings, from the EXISTING engine (T2/T3 input).

   NCAAM-EARLY does not fit a second rating system. The season-end state of
   the NCAAM-FORECAST ratings engine (basketball/ncaam_research/team_model.js,
   parameters basketball/ncaam_forecast/config/selection_v1.json `chosen`,
   chosen on 2012-2019 only), walked over the committed hoopR/ESPN dataset
   (basketball/ncaam_forecast/data), gives for every D-I team and season:

     off     points scored per 100 possessions above the league mean (mu)
     allow   points allowed per 100 possessions above the mean (+ = worse D)
     net     off - allow
     tempo   possessions per game above the league mean pace (tau)

   The engine keys teams by ESPN id; CBBD lists each team's ESPN id as its
   `sourceId`, so crosswalk(teams) maps one to the other. The crosswalk rate is
   measured per run (ingest.js crosswalk), never assumed.

   Conference strength (transfer translation, config/model_v0.json): the mean
   `net` of a conference's D-I members in that season, expressed as
   100 + net, a positive points-per-100 scale, so a ratio of two strengths
   is defined (a raw net rating can be negative).

     seasonStates(seasons)            -> { [season]: { mu, tau, eta (home term), s2 (residual variance), lambda, teams: Map(espnId -> rating) } }
     crosswalk(cbbdTeams, state)      -> Map(cbbdTeamId -> rating & espn_id)
     conferenceStrength(cbbdTeams, byCbbd) -> Map(conference_id -> { strength, teams })
   =========================================================================== */
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

function engineParams() {
  return require(path.join(ROOT, 'basketball', 'ncaam_forecast', 'config', 'selection_v1.json')).chosen;
}

/** season-end engine states; every season the walk needs is loaded (the
    first season listed has no prior and is a warm-up) */
function seasonStates(seasons, o) {
  o = o || {};
  const D = o.dataset || require(path.join(ROOT, 'basketball', 'ncaam_forecast', 'dataset.js'));
  const TM = o.engine || require(path.join(ROOT, 'basketball', 'ncaam_research', 'team_model.js'));
  const ss = seasons.slice().sort((a, b) => a - b);
  const W = TM.walk(D.engineGames(D.load(ss)), o.params || engineParams(), null, ss);
  const out = {};
  for (const s of ss) {
    const st = W.states[s] && W.states[s].state;
    if (!st) continue;
    const teams = new Map();
    for (const [id, r] of st.eff) {
      const t = st.tempo.get(id);
      teams.set(String(id), { off: r.off, allow: r.allow, net: r.off - r.allow, tempo: t ? (t.off + t.allow) / 2 : null });
    }
    const E = W.states[s].E;
    out[s] = { season: s, mu: st.mu, tau: st.tau, eta: st.eta, s2: E && Number.isFinite(E.s2) ? E.s2 : null, lambda: (o.params || engineParams()).lambda, teams };
  }
  return out;
}

/** CBBD team rows (season S) -> ratings of season S keyed by CBBD team id */
function crosswalk(cbbdTeams, state) {
  const m = new Map();
  if (!state) return m;
  for (const t of cbbdTeams || []) {
    const r = t.source_id != null ? state.teams.get(String(t.source_id)) : null;
    if (r) m.set(t.team_id, Object.assign({ espn_id: String(t.source_id) }, r));
  }
  return m;
}

function conferenceStrength(cbbdTeams, byCbbd) {
  const acc = new Map();
  for (const t of cbbdTeams || []) {
    if (t.conference_id == null) continue;
    const r = byCbbd.get(t.team_id); if (!r) continue;
    if (!acc.has(t.conference_id)) acc.set(t.conference_id, { sum: 0, n: 0 });
    const a = acc.get(t.conference_id); a.sum += r.net; a.n++;
  }
  const out = new Map();
  for (const [k, a] of acc) out.set(k, { strength: 100 + a.sum / a.n, teams: a.n });
  return out;
}

module.exports = { seasonStates, crosswalk, conferenceStrength, engineParams };
