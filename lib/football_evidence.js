/* ===========================================================================
   EdgeDesk — football evidence packets (EDFootballEvidence).

   WHY THIS EXISTS
     A publisher told us, correctly, that an article presented EdgeDesk's
     Ole Miss–Vanderbilt number as a near toss-up against a market that made
     Ole Miss a 9.5-point favourite, and gave no football reason for the
     disagreement. A projection is not evidence of its own explanation. This
     file turns what EdgeDesk already measures into FOOTBALL EVIDENCE, explains
     the model-versus-market gap in football terms (or says plainly that it
     cannot), and gates every article on that evidence.

   One file, no dependencies, three hosts (like lib/content_engine.js):
     · Node: tools/content/evidence.js builds one packet per matchup from the
       committed artifacts; tools/articles + tools/editorial read it for the
       first-party pages;
     · the owner's Content Engine page loads it before lib/content_engine.js;
     · the content_engine Edge Function carries a VERBATIM copy
       (tools/content/inline.js) so the gate runs on every AI rewrite.

   WHAT IT DOES
     build      one packet per matchup: CLAIMS, each with its source, the time
                its source was observed, a verification status and a scope
                (current season / historical / model / market / report), plus
                a COVERAGE list naming every research item the desk wanted and
                whether it was available. A missing statistic stays missing.
     explain    the model-versus-market explanation: thesis, supporting and
                contradicting evidence, the critical matchup, the game script
                each number needs, unresolved uncertainty, an input audit and a
                status — EXPLAINED / PARTIALLY_EXPLAINED / UNEXPLAINED. An
                unexplained gap is never actionable.
     gate       the editorial gate an article must pass: football evidence for
                every featured game, contrary evidence, quarterback and injury
                status as the evidence states it, no unsupported causal
                explanation of a gap, no edge language, historical facts dated,
                correct gap arithmetic, no repeated filler, no unknown sources.
                It returns checks for lib/content_engine.js validate() and an
                evidence record for every claim the article cites.

   VERIFICATION VOCABULARY (a claim's `verification`)
     VERIFIED_DATA    measured from EdgeDesk's committed play-by-play, box and
                      results artifacts, with the artifact's own timestamp
     OFFICIAL_REPORT  an official availability / injury report on file
     VERIFIED_REPORT  outside reporting a person confirmed at the source
     REPORTED         outside reporting recorded with outlet, URL and date but
                      NOT confirmed at the source — citable with attribution,
                      and an article that relies on it is held for review
     RATING           an EdgeDesk position-group or team rating (derived)
     MODEL_OUTPUT     a number the model produced. Never football evidence.
     MARKET_DATA      a captured sportsbook line
     CONFLICTING      two inputs disagree; cited only to disclose the conflict
   =========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDFootballEvidence = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  var SCHEMA = 'edgedesk_football_evidence_v1';
  var VERSION = 'football_evidence_v1';
  var SITE = 'https://edgedesksports.com';

  /* a gap under this is ordinary model disagreement, not a story */
  var MATERIAL_GAP = 2;
  var MAJOR_GAP = 7;
  var STALE_MINUTES = 180;

  var FOOTBALL = { VERIFIED_DATA: 1, OFFICIAL_REPORT: 1, VERIFIED_REPORT: 1, REPORTED: 1, RATING: 1 };
  var MEASURED = { VERIFIED_DATA: 1, OFFICIAL_REPORT: 1, VERIFIED_REPORT: 1, REPORTED: 1 };

  /* ---------------------------------------------------------------- utils */
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function r1(x) { return +(+x).toFixed(1); }
  function r2(x) { return +(+x).toFixed(2); }
  function f1(x) { return (+x).toFixed(1); }
  function pct1(p) { return (p * 100).toFixed(1) + '%'; }
  function pct0(p) { return Math.round(p * 100) + '%'; }
  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
  function ts(x) { var t = x ? Date.parse(x) : NaN; return isFinite(t) ? t : null; }
  function iso(t) { return new Date(t).toISOString(); }
  function uniq(a) { var s = {}, out = []; (a || []).forEach(function (x) { var k = typeof x === 'string' ? x : JSON.stringify(x); if (!s[k]) { s[k] = 1; out.push(x); } }); return out; }
  function hash(s) {
    s = String(s); var h1 = 5381, h2 = 52711;
    for (var i = 0; i < s.length; i++) { var c = s.charCodeAt(i); h1 = (h1 * 33) ^ c; h2 = (h2 * 33) ^ c; }
    return ((h1 >>> 0).toString(36) + (h2 >>> 0).toString(36));
  }
  /* a model term in words — never the code's own key (“net_pass”) */
  var NFL_TERMS = { net_pts: 'scoring margin', net_epa: 'overall efficiency', net_pass: 'passing efficiency', net_rush: 'rushing efficiency', qb_adj_diff: 'quarterback adjustment', rest_diff: 'rest', div_game: 'division game' };
  function termLabel(r) {
    var l = NFL_TERMS[r.key] || (r.label && !/_/.test(r.label) ? r.label : String(r.label || r.key || '').replace(/_/g, ' '));
    return String(l).replace(/\s*\(.*\)\s*/g, '');
  }
  function poss(team) { return /s$/.test(team) ? team + '’' : team + '’s'; }
  function lastName(n) { var p = String(n || '').replace(/\s+(Jr\.?|Sr\.?|II|III|IV)$/i, '').split(/\s+/); return p[p.length - 1] || n; }
  function sentenceList(arr, conj) {
    arr = (arr || []).filter(Boolean); conj = ' ' + (conj || 'and') + ' ';
    if (arr.length <= 1) return arr.join('');
    if (arr.length === 2) return arr[0] + conj + arr[1];
    return arr.slice(0, -1).join(', ') + conj + arr[arr.length - 1];
  }
  var NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
  function numWord(n) { return n >= 0 && n < NUMBER_WORDS.length ? NUMBER_WORDS[n] : String(n); }
  function thousands(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function score(a, b) { return Math.max(a, b) + '–' + Math.min(a, b); }
  function countWord(n, w) { return (n === 0 ? 'no ' + w + 's' : n + ' ' + w + (n === 1 ? '' : 's')); }
  /* a passer's yards per attempt against the FBS average (7.5) */
  function qbRel(ypa) { return (ypa - 7.49) / 7.49; }

  /* Dates the way a sports desk prints them, in Eastern time. */
  var MONTHS_AP = { Jan: 'Jan.', Feb: 'Feb.', Mar: 'March', Apr: 'April', May: 'May', Jun: 'June', Jul: 'July', Aug: 'Aug.', Sep: 'Sept.', Oct: 'Oct.', Nov: 'Nov.', Dec: 'Dec.' };
  function dayMonth(t) {
    if (t == null) return null;
    try {
      var parts = {};
      new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' })
        .formatToParts(new Date(t)).forEach(function (p) { parts[p.type] = p.value; });
      return (MONTHS_AP[parts.month] || parts.month) + ' ' + parts.day;
    } catch (e) {
      var d = new Date(t - 4 * 3600000);
      var mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
      return MONTHS_AP[mo] + ' ' + d.getUTCDate();
    }
  }

  /* ======================================================================
     CLAIMS
     ====================================================================== */
  /* cite: { nums: ['10.3'], words: ['sack'] } — an article cites the claim
     when ONE sentence carries every number and at least one of the words.
     With all: true, that sentence must carry EVERY word, where 'a|b' is a
     choice — how a claim with no number is told apart from any sentence that
     merely names the team or the player (“Vanderbilt’s availability report
     lists four players as out” is not cited by a sentence about Vanderbilt). */
  function claim(o) {
    var c = {
      id: 'c_' + hash([o.topic, o.key, o.team || '', o.subject || ''].join('|')).slice(0, 12),
      topic: o.topic, key: o.key, team: o.team || null, side: o.side || null, subject: o.subject || null,
      text: o.text, short: o.short || o.text, label: o.label || null,
      cite: { nums: (o.cite && o.cite.nums || []).map(String), words: (o.cite && o.cite.words || []).map(String), any: !!(o.cite && o.cite.any), all: !!(o.cite && o.cite.all) },
      values: o.values || null,
      scope: o.scope || 'current_season',
      source: o.source || null,
      observed_at: o.observed_at || null,
      verification: o.verification,
      football: !!FOOTBALL[o.verification],
      measured: !!MEASURED[o.verification],
      needs_confirmation: o.verification === 'REPORTED',
      leans: o.leans || null,
      strength: o.strength || null,
      sample: isNum(o.sample) ? Math.round(o.sample) : null,
      caveat: o.caveat || null,
      material: !!o.material,
      status: o.status || null
    };
    return c;
  }

  /* ---- unit metrics: football/matchup/metrics.json performance.*_detail ---- */
  var METRICS = {
    success_rate:        { side: 'off', topic: 'offense', unit: 'pct', better: 'high', pair: 'efficiency', words: ['succe'], phrase: 'succeeds on {v} of its offensive plays', label: 'Success rate' },
    early_down_success:  { side: 'off', topic: 'offense', unit: 'pct', better: 'high', pair: 'early_downs', words: ['early', 'first- and second', 'first and second'], phrase: 'succeeds on {v} of its first- and second-down plays', label: 'Early-down success' },
    explosive_pass_rate: { side: 'off', topic: 'offense', unit: 'pct', better: 'high', pair: 'explosive_pass', words: ['explosive', 'big play', 'big gain'], phrase: 'turns {v} of its pass plays into explosive gains', label: 'Explosive pass rate' },
    yards_per_attempt:   { side: 'off', topic: 'offense', unit: 'num', better: 'high', pair: 'pass', words: ['per attempt', 'per pass', 'yards a throw', 'per throw'], phrase: 'averages {v} yards per pass attempt', label: 'Yards per pass attempt' },
    explosive_rush_rate: { side: 'off', topic: 'offense', unit: 'pct', better: 'high', pair: 'explosive_rush', words: ['explosive', 'big run', 'big gain'], phrase: 'turns {v} of its runs into explosive gains', label: 'Explosive run rate' },
    sack_rate_allowed:   { side: 'off', topic: 'line', unit: 'pct', better: 'low', pair: 'protection', words: ['sack'], phrase: 'has allowed a sack on {v} of its dropbacks', label: 'Sack rate allowed' },
    yards_per_rush:      { side: 'off', topic: 'offense', unit: 'num', better: 'high', pair: 'rush', words: ['per carry', 'per rush', 'per run'], phrase: 'averages {v} yards per carry', label: 'Yards per carry' },
    third_success:       { side: 'off', topic: 'offense', unit: 'pct', better: 'high', pair: 'third_down', words: ['third'], phrase: 'converts {v} of its third downs', label: 'Third-down conversion' },
    stuff_rate:          { side: 'off', topic: 'line', unit: 'pct', better: 'low', pair: 'run_blocking', words: ['behind the line', 'stuffed', 'stopped'], phrase: 'is stopped at or behind the line on {v} of its runs', label: 'Runs stuffed' },
    rz_success:          { side: 'off', topic: 'offense', unit: 'pct', better: 'high', pair: 'red_zone', words: ['red zone', 'red-zone'], phrase: 'succeeds on {v} of its red-zone plays', label: 'Red-zone success' },
    turnover_rate:       { side: 'off', topic: 'offense', unit: 'pct', better: 'low', pair: 'turnovers', words: ['turn', 'giveaway'], phrase: 'turns the ball over on {v} of its plays', label: 'Turnover rate', unreliable: 'the play-by-play feed does not attribute fumbles reliably (football/matchup/profiles_2026.json column gates)' },
    def_success_allowed:        { side: 'def', topic: 'defense', unit: 'pct', better: 'low', pair: 'efficiency', words: ['succe'], phrase: 'allows opponents to succeed on {v} of their plays', label: 'Success allowed' },
    def_early_down_allowed:     { side: 'def', topic: 'defense', unit: 'pct', better: 'low', pair: 'early_downs', words: ['early', 'first- and second', 'first and second'], phrase: 'allows success on {v} of first- and second-down plays', label: 'Early-down success allowed' },
    def_explosive_pass_allowed: { side: 'def', topic: 'defense', unit: 'pct', better: 'low', pair: 'explosive_pass', words: ['explosive', 'big play', 'big gain'], phrase: 'gives up explosive gains on {v} of opponent pass plays', label: 'Explosive passes allowed' },
    def_yards_per_attempt:      { side: 'def', topic: 'defense', unit: 'num', better: 'low', pair: 'pass', words: ['per attempt', 'per pass', 'per throw'], phrase: 'allows {v} yards per pass attempt', label: 'Yards per pass attempt allowed' },
    def_explosive_rush_allowed: { side: 'def', topic: 'defense', unit: 'pct', better: 'low', pair: 'explosive_rush', words: ['explosive', 'big run', 'big gain'], phrase: 'gives up explosive gains on {v} of opponent runs', label: 'Explosive runs allowed' },
    def_sack_rate:              { side: 'def', topic: 'pressure', unit: 'pct', better: 'high', pair: 'protection', words: ['sack'], phrase: 'sacks the quarterback on {v} of opponent dropbacks', label: 'Sack rate' },
    def_yards_per_rush:         { side: 'def', topic: 'defense', unit: 'num', better: 'low', pair: 'rush', words: ['per carry', 'per rush', 'per run'], phrase: 'allows {v} yards per carry', label: 'Yards per carry allowed' },
    def_third_allowed:          { side: 'def', topic: 'defense', unit: 'pct', better: 'low', pair: 'third_down', words: ['third'], phrase: 'allows opponents to convert {v} of their third downs', label: 'Third downs allowed' },
    def_stuff_rate:             { side: 'def', topic: 'defense', unit: 'pct', better: 'high', pair: 'run_blocking', words: ['behind the line', 'stuff', 'stop'], phrase: 'stops {v} of opponent runs at or behind the line', label: 'Runs stuffed (defense)' },
    def_rz_allowed:             { side: 'def', topic: 'defense', unit: 'pct', better: 'low', pair: 'red_zone', words: ['red zone', 'red-zone'], phrase: 'allows success on {v} of opponent red-zone plays', label: 'Red-zone success allowed' },
    def_turnovers_forced:       { side: 'def', topic: 'defense', unit: 'pct', better: 'high', pair: 'turnovers', words: ['turnover', 'takeaway', 'force'], phrase: 'forces a turnover on {v} of opponent plays', label: 'Takeaway rate', unreliable: 'the play-by-play feed does not attribute fumbles reliably (football/matchup/profiles_2026.json column gates)' }
  };
  /* How one side's offence meets the other's defence, and the football
     question each collision asks. {O} offence, {D} defence, {QB} O's passer. */
  var PAIRS = {
    protection:     { off: 'sack_rate_allowed', def: 'def_sack_rate', label: 'pass protection against the pass rush', q: 'Can {D}’s Pass Rush Get to {QB}?', watch: 'whether {D} can get pressure on {QB}' },
    pass:           { off: 'yards_per_attempt', def: 'def_yards_per_attempt', label: 'the passing game against the pass defense', q: 'Can {D}’s Pass Defense Slow {O}’s Passing Game?', watch: 'how many yards {O} gains per throw against {D}’s secondary' },
    rush:           { off: 'yards_per_rush', def: 'def_yards_per_rush', label: 'the run game against the run defense', q: 'Can {D} Stop {O}’s Run Game?', watch: 'whether {O} can run on {D}' },
    early_downs:    { off: 'early_down_success', def: 'def_early_down_allowed', label: 'early downs', q: 'Can {D} Keep {O} Behind Schedule?', watch: 'whether {D} keeps {O} behind schedule on first and second down' },
    third_down:     { off: 'third_success', def: 'def_third_allowed', label: 'third down', q: 'Can {D} Get {O} Off the Field on Third Down?', watch: 'third-down conversions when {O} has the ball' },
    red_zone:       { off: 'rz_success', def: 'def_rz_allowed', label: 'the red zone', q: 'Can {D} Hold {O} to Field Goals?', watch: 'touchdowns versus field goals when {O} reaches the red zone' },
    explosive_pass: { off: 'explosive_pass_rate', def: 'def_explosive_pass_allowed', label: 'big plays through the air', q: 'Can {D} Take Away {O}’s Big Plays?', watch: 'explosive pass plays by {O}' },
    explosive_rush: { off: 'explosive_rush_rate', def: 'def_explosive_rush_allowed', label: 'big plays on the ground', q: 'Can {D} Contain {O}’s Explosive Runs?', watch: 'long runs by {O}' },
    turnovers:      { off: 'turnover_rate', def: 'def_turnovers_forced', label: 'ball security against takeaways', q: 'Can {D} Force {O} Into Mistakes?', watch: 'turnovers' },
    run_blocking:   { off: 'stuff_rate', def: 'def_stuff_rate', label: 'the line of scrimmage on running plays', q: 'Can {D} Win at the Line of Scrimmage?', watch: 'how often {D} stops {O}’s runs at or behind the line' },
    efficiency:     { off: 'success_rate', def: 'def_success_allowed', label: 'down-to-down efficiency', q: 'Can {D}’s Defense Slow {O}’s Offense?', watch: 'down-to-down success when {O} has the ball' }
  };

  function metricText(id, v) { var m = METRICS[id]; return m.unit === 'pct' ? pct1(v) : f1(v); }
  function metricNum(id, v) { var m = METRICS[id]; return m.unit === 'pct' ? f1(v * 100) : f1(v); }
  /* goodness of a value for its own team, relative to the league: +0.3 = 30% better */
  function goodness(id, v, lg) {
    var m = METRICS[id]; if (!isNum(v) || !isNum(lg) || lg === 0) return null;
    return clamp(m.better === 'high' ? (v - lg) / lg : (lg - v) / lg, -1, 1);
  }
  function strengthOf(g) { var a = Math.abs(g); return a >= 0.35 ? 'large' : a >= 0.2 ? 'moderate' : a >= 0.1 ? 'small' : null; }
  /* The lean a reader can SEE: the printed (raw) number and the
     opponent-adjusted one must agree in direction, and the smaller of the two
     sets the size — so a claim never "leans" on a number the text hides. */
  function leanOf(id, u) {
    var gr = goodness(id, u.raw, u.league), ga = isNum(u.adjusted) ? goodness(id, u.adjusted, u.league) : gr;
    if (gr == null || ga == null) return null;
    if (gr * ga <= 0) return 0;
    return gr > 0 ? Math.min(gr, ga) : Math.max(gr, ga);
  }
  function metricIndex(team) {
    var out = {};
    var p = team && team.performance || {};
    ['offense_detail', 'defense_detail'].forEach(function (k) {
      ((p[k] && p[k].used) || []).forEach(function (u) { if (u && METRICS[u.id]) out[u.id] = u; });
    });
    return out;
  }

  /* ======================================================================
     BUILD — CFB
     x: { game (cfb_terminal record), keys {home, away}, metrics {home, away},
          profiles {home, away}, qbs {home: [players], away: [players]},
          reports {home, away}, forecast, h2h [lines archive games], finals
          {game_id: {...}}, rankings {teams}, record (first-party), facts [],
          notes [], as_of {metrics, profiles, qbs, record, lines, rankings,
          forecasts, terminal} }
     ====================================================================== */
  function buildCfb(x, opts) {
    opts = opts || {};
    var g = x.game || {}, gm = g.game || {};
    var home = gm.home, away = gm.away;
    var now = isNum(opts.now) ? opts.now : Date.now();
    var A = x.as_of || {};
    var claims = [], cov = {};
    function add(c) { if (c && claims.every(function (y) { return y.id !== c.id; })) claims.push(c); return c; }
    function covered(item, c) { (cov[item] = cov[item] || []).push(c.id); }
    var teams = { home: home, away: away };
    var keys = x.keys || {};
    var M = { home: metricIndex(x.metrics && x.metrics.home), away: metricIndex(x.metrics && x.metrics.away) };
    var lg = 'FBS average';
    var srcMetrics = { id: 'matchup_metrics', label: 'EdgeDesk play-by-play unit metrics (2026 season)', path: 'football/matchup/metrics.json' };

    /* ---- cross-check: sack figures. EdgeDesk's play-by-play feed under-
       attributes sacks (profiles_2026.json column_gates), so the unit metric
       is checked against the quarterback logs (offence) and the ESPN box
       (defence). Where they disagree the corroborated figure is used and the
       metric is kept only as a CONFLICTING claim. ---- */
    var over = { home: {}, away: {} }, dataConflicts = [];
    ['home', 'away'].forEach(function (side) {
      var qs = (x.qbs && x.qbs[side]) || [], sk = 0, db = 0;
      qs.forEach(function (p) { (p.season_log || []).forEach(function (l) { if (l.team_key === keys[side]) { sk += l.sacks || 0; db += l.dropbacks || 0; } }); });
      var mu = M[side].sack_rate_allowed;
      if (db >= 60 && mu && isNum(mu.raw) && Math.abs(sk / db - mu.raw) > 0.015) {
        over[side].sack_rate_allowed = { raw: sk / db, adjusted: null, league: mu.league, n_obs: db, count: sk, base: db,
          source: { id: 'qb_epa', label: 'EdgeDesk play-by-play quarterback logs (2026)', path: 'football/fbs_epa/qb_epa_2026.json' }, observed_at: A.qbs, unit: 'dropbacks' };
        dataConflicts.push({ side: side, id: 'sack_rate_allowed', metric: mu.raw, used: sk / db, why: 'unit metrics ' + pct1(mu.raw) + ' against quarterback logs ' + pct1(sk / db) + ' (' + sk + ' of ' + db + ')' });
      }
      var bt = x.box && x.box[side], pa = x.profiles && x.profiles[side] && x.profiles[side].allowed, md = M[side].def_sack_rate;
      if (bt && isNum(bt.sacks) && pa && isNum(pa.dropbacks) && pa.dropbacks >= 60 && md && isNum(md.raw) && Math.abs(bt.sacks / pa.dropbacks - md.raw) > 0.02) {
        over[side].def_sack_rate = { raw: bt.sacks / pa.dropbacks, adjusted: null, league: md.league, n_obs: pa.dropbacks, count: bt.sacks, base: pa.dropbacks,
          source: { id: 'box', label: 'ESPN box scores (sacks) over play-by-play opponent dropbacks', path: 'football/data/box/2026.json' }, observed_at: A.box, unit: 'opponent dropbacks' };
        dataConflicts.push({ side: side, id: 'def_sack_rate', metric: md.raw, used: bt.sacks / pa.dropbacks, why: 'unit metrics ' + pct1(md.raw) + ' against box-score sacks ' + pct1(bt.sacks / pa.dropbacks) + ' (' + bt.sacks + ' of ' + pa.dropbacks + ')' });
      }
    });
    function U(side, id) { return over[side][id] || M[side][id]; }

    /* ---- team unit metrics ---- */
    ['home', 'away'].forEach(function (side) {
      var team = teams[side];
      Object.keys(M[side]).forEach(function (id) {
        var m = METRICS[id], ov = over[side][id], u = U(side, id);
        if (!isNum(u.raw) || !isNum(u.league) || m.unreliable) return;
        if (ov) {
          var mu0 = M[side][id];
          add(claim({
            topic: 'data', key: 'metric_conflict:' + id + ':' + side, team: team, side: side, label: m.label + ' (sources disagree)',
            text: 'EdgeDesk’s sources disagree on ' + poss(team) + ' ' + m.label.toLowerCase() + ': the play-by-play unit metric says ' + metricText(id, mu0.raw) + ', the ' + (id === 'def_sack_rate' ? 'box scores' : 'quarterback logs') + ' say ' + metricText(id, ov.raw) + '.',
            short: poss(team) + ' ' + m.label.toLowerCase() + ' is disputed between EdgeDesk’s sources',
            cite: { nums: [metricNum(id, mu0.raw)], words: m.words }, values: { metric: mu0.raw, corroborated: ov.raw },
            source: srcMetrics, observed_at: A.metrics, verification: 'CONFLICTING', caveat: 'not used as evidence'
          }));
        }
        var gd = leanOf(id, u);
        var small = isNum(u.n_obs) && u.n_obs < 40;
        var count = ov ? ' — ' + ov.count + ' sack' + (ov.count === 1 ? '' : 's') + ' on ' + ov.base + ' ' + ov.unit : '';
        var c = add(claim({
          topic: m.topic, key: 'metric:' + id, team: team, side: side,
          label: m.label,
          text: poss(team) + (m.side === 'off' ? ' offense ' : ' defense ') + m.phrase.replace('{v}', metricText(id, u.raw)) + count + ' (' + lg + ' ' + metricText(id, u.league) + ').',
          short: poss(team) + (m.side === 'off' ? ' offense ' : ' defense ') + m.phrase.replace('{v}', metricText(id, u.raw)),
          cite: { nums: [metricNum(id, u.raw)], words: m.words },
          values: { raw: u.raw, adjusted: u.adjusted, league: u.league, plays: u.n_obs },
          source: ov ? ov.source : srcMetrics, observed_at: ov ? ov.observed_at : A.metrics,
          verification: 'VERIFIED_DATA',
          leans: gd == null || !strengthOf(gd) ? null : (gd > 0 ? team : (side === 'home' ? away : home)),
          strength: gd == null ? null : strengthOf(gd), sample: u.n_obs,
          caveat: small ? 'small sample: ' + Math.round(u.n_obs) + ' plays' : null
        }));
        c.component = true;
        var item = { yards_per_attempt: 'off_rush_pass', yards_per_rush: 'off_rush_pass', success_rate: 'off_efficiency', early_down_success: 'off_efficiency',
          explosive_pass_rate: 'off_explosive', explosive_rush_rate: 'off_explosive', third_success: 'off_third', rz_success: 'off_red_zone',
          sack_rate_allowed: 'off_line', stuff_rate: 'off_line', turnover_rate: 'off_efficiency',
          def_yards_per_attempt: 'def_rush_pass', def_yards_per_rush: 'def_rush_pass', def_sack_rate: 'def_pressure', def_explosive_pass_allowed: 'def_explosive',
          def_explosive_rush_allowed: 'def_explosive', def_third_allowed: 'def_third', def_rz_allowed: 'def_red_zone', def_success_allowed: 'def_efficiency',
          def_early_down_allowed: 'def_efficiency', def_stuff_rate: 'def_rush_pass', def_turnovers_forced: 'def_efficiency' }[id];
        if (item) covered(item, c);
      });
    });

    /* ---- matchups: one side's offence against the other's defence ---- */
    var pairs = [];
    ['home', 'away'].forEach(function (oside) {
      var dside = oside === 'home' ? 'away' : 'home';
      var O = teams[oside], D = teams[dside];
      Object.keys(PAIRS).forEach(function (pk) {
        var P = PAIRS[pk], uo = U(oside, P.off), ud = U(dside, P.def);
        if (METRICS[P.off].unreliable || METRICS[P.def].unreliable) return;
        if (!uo || !ud || !isNum(uo.raw) || !isNum(ud.raw)) return;
        var go = leanOf(P.off, uo), gdf = leanOf(P.def, ud);
        if (go == null || gdf == null) return;
        var edge = go - gdf;
        var favors = Math.abs(edge) >= 0.12 ? (edge > 0 ? O : D) : null;
        var collision = Math.min(go, gdf);
        var sample = Math.min(uo.n_obs || 0, ud.n_obs || 0);
        var mo = METRICS[P.off], md = METRICS[P.def];
        var c = add(claim({
          topic: 'matchup', key: 'pair:' + pk + ':' + oside, team: O, side: oside,
          label: cap(P.label),
          text: 'When ' + O + ' has the ball (' + P.label + '): ' + poss(O) + ' offense ' + mo.phrase.replace('{v}', metricText(P.off, uo.raw))
            + ', and ' + poss(D) + ' defense ' + md.phrase.replace('{v}', metricText(P.def, ud.raw)) + ' (' + lg + ' ' + metricText(P.off, uo.league) + ').',
          /* the league average stays in the short form: without it, 5.7% against 6.0% does not say who has the edge */
          short: poss(O) + ' offense ' + mo.phrase.replace('{v}', metricText(P.off, uo.raw)) + '; ' + poss(D) + ' defense ' + md.phrase.replace('{v}', metricText(P.def, ud.raw)) + ' (' + lg + ' ' + metricText(P.off, uo.league) + ')',
          cite: { nums: [metricNum(P.off, uo.raw), metricNum(P.def, ud.raw)], words: mo.words, any: true },
          values: { offense: uo.raw, defense: ud.raw, league: uo.league, edge: r2(edge), collision: r2(collision) },
          source: (over[oside][P.off] || over[dside][P.def]) ? { id: 'matchup_mixed', label: 'EdgeDesk play-by-play metrics, quarterback logs and box scores', path: 'football/matchup/metrics.json' } : srcMetrics,
          observed_at: A.metrics, verification: 'VERIFIED_DATA',
          leans: favors, strength: favors ? strengthOf(edge) : null, sample: sample,
          caveat: sample < 40 ? 'small sample: ' + Math.round(sample) + ' plays' : null
        }));
        pairs.push({ key: pk, oside: oside, O: O, D: D, edge: edge, collision: collision, go: go, gd: gdf, favors: favors, claim: c, sample: sample });
      });
    });

    /* ---- position groups (EdgeDesk ratings) ---- */
    var RK = (x.rankings && x.rankings.teams) || {};
    var rh = RK[keys.home], ra = RK[keys.away];
    var GROUPS = [['qb', 'quarterback room'], ['ol', 'offensive line'], ['dl', 'defensive line'], ['secondary', 'secondary'], ['wr', 'receivers'], ['rb', 'running backs'], ['lb', 'linebackers'], ['pass_defense', 'pass defense'], ['run_defense', 'run defense'], ['offense', 'offense'], ['defense', 'defense']];
    if (rh && ra && rh.ranks && ra.ranks) {
      GROUPS.forEach(function (gp) {
        var a = ra.ranks[gp[0]], h = rh.ranks[gp[0]];
        if (!a || !h || !isNum(a.rank) || !isNum(h.rank)) return;
        var gap = h.rank - a.rank; /* >0: away ranks higher (better) */
        var lead = gap > 0 ? away : home, trail = gap > 0 ? home : away;
        var lr = gap > 0 ? a.rank : h.rank, tr = gap > 0 ? h.rank : a.rank;
        var c = add(claim({
          topic: 'position', key: 'group:' + gp[0], team: lead,
          label: cap(gp[1]),
          text: 'EdgeDesk’s position-group ratings put ' + poss(lead) + ' ' + gp[1] + ' No. ' + lr + ' nationally and ' + poss(trail) + ' No. ' + tr + '.',
          short: poss(lead) + ' ' + gp[1] + ' (No. ' + lr + ') against ' + poss(trail) + ' (No. ' + tr + ')',
          cite: { nums: [String(lr), String(tr)], words: [gp[1].split(' ')[0]] },
          values: { lead_rank: lr, trail_rank: tr, of: Object.keys(RK).length },
          source: { id: 'rankings', label: 'EdgeDesk position-group ratings', path: 'football/rankings/current.json' }, observed_at: A.rankings,
          verification: 'RATING', leans: Math.abs(gap) >= 25 ? lead : null,
          strength: Math.abs(gap) >= 60 ? 'large' : Math.abs(gap) >= 35 ? 'moderate' : Math.abs(gap) >= 25 ? 'small' : null
        }));
        covered('position_groups', c);
      });
    }

    /* ---- quarterbacks ---- */
    var qbClaims = { home: [], away: [] };
    var nameOf = function (key) { var t = RK[key]; return t && t.team || key; };
    ['home', 'away'].forEach(function (side) {
      var team = teams[side];
      var list = ((x.qbs && x.qbs[side]) || []).map(function (p) {
        var log = (p.season_log || []).filter(function (l) { return l.team_key === keys[side] && isNum(l.attempts); })
          .sort(function (a, b) { return (ts(a.kickoff) || 0) - (ts(b.kickoff) || 0); });
        return { p: p, log: log, db: log.reduce(function (s, l) { return s + (l.dropbacks || 0); }, 0) };
      }).filter(function (q) { return q.db >= 15; }).sort(function (a, b) { return b.db - a.db; }).slice(0, 2);
      list.forEach(function (q) {
        var L = q.log, n = q.p.name;
        var att = 0, cmp = 0, yds = 0, td = 0, ints = 0, sk = 0, db = 0, epa = 0, epaN = 0;
        L.forEach(function (l) { att += l.attempts || 0; cmp += l.completions || 0; yds += l.yards || 0; td += l.tds || 0; ints += l.interceptions || 0; sk += l.sacks || 0; db += l.dropbacks || 0; if (isNum(l.epa)) { epa += l.epa; epaN += l.dropbacks || 0; } });
        if (!att) return;
        var ypa = yds / att, cp = cmp / att;
        var c = add(claim({
          topic: 'qb', key: 'qb_season:' + q.p.athlete_id, team: team, side: side, subject: n,
          label: n + ' (2026)',
          text: n + ' has completed ' + cmp + ' of ' + att + ' passes (' + pct1(cp) + ') for ' + thousands(yds) + ' yards, ' + f1(ypa) + ' yards per attempt, '
            + countWord(td, 'touchdown') + ' and ' + countWord(ints, 'interception') + ' in ' + numWord(L.length) + ' game' + (L.length === 1 ? '' : 's') + ' for ' + team
            + ', and has been sacked on ' + sk + ' of ' + db + ' dropbacks.',
          short: n + ': ' + pct1(cp) + ' completions, ' + f1(ypa) + ' yards per attempt, ' + td + ' TD, ' + ints + ' INT',
          cite: { nums: [f1(ypa)], words: [lastName(n)] },
          values: { attempts: att, completions: cmp, yards: yds, tds: td, ints: ints, sacks: sk, dropbacks: db, epa_per_dropback: epaN ? r2(epa / epaN) : null, games: L.length },
          source: { id: 'qb_epa', label: 'EdgeDesk play-by-play quarterback logs (2026)', path: 'football/fbs_epa/qb_epa_2026.json' }, observed_at: A.qbs,
          verification: 'VERIFIED_DATA', leans: Math.abs(qbRel(ypa)) >= 0.1 ? (qbRel(ypa) > 0 ? team : (side === 'home' ? away : home)) : null,
          strength: Math.abs(qbRel(ypa)) >= 0.2 ? 'moderate' : (Math.abs(qbRel(ypa)) >= 0.1 ? 'small' : null), sample: db,
          caveat: 'play-by-play attribution; official box scores can differ by a few yards or attempts'
        }));
        qbClaims[side].push(c); covered('qb_efficiency', c); covered('qb_completion', c); covered('qb_ypa', c); covered('qb_td_int', c); covered('qb_sacks', c);
        /* the trend: the last two games against the ones before */
        if (L.length >= 4) {
          var last = L.slice(-2), early = L.slice(0, -2);
          var sum = function (arr, k) { return arr.reduce(function (s, l) { return s + (l[k] || 0); }, 0); };
          var ly = sum(last, 'yards') / Math.max(1, sum(last, 'attempts')), ey = sum(early, 'yards') / Math.max(1, sum(early, 'attempts'));
          var opps = last.map(function (l) { return nameOf(l.opponent_key); });
          var dir = ly - ey;
          var tc = add(claim({
            topic: 'qb', key: 'qb_trend:' + q.p.athlete_id, team: team, side: side, subject: n,
            label: n + ': recent form',
            text: 'In his last two games (' + sentenceList(opps) + '), ' + lastName(n) + ' averaged ' + f1(ly) + ' yards per attempt, against ' + f1(ey) + ' in his ' + (early.length === 1 ? 'game' : numWord(early.length) + ' games') + ' before that.',
            short: lastName(n) + ' ' + f1(ly) + ' yards per attempt over his last two games (' + f1(ey) + ' before)',
            cite: { nums: [f1(ly)], words: [lastName(n)] },
            values: { last_two_ypa: r1(ly), before_ypa: r1(ey), change: r1(dir) },
            source: { id: 'qb_epa', label: 'EdgeDesk play-by-play quarterback logs (2026)', path: 'football/fbs_epa/qb_epa_2026.json' }, observed_at: A.qbs,
            verification: 'VERIFIED_DATA', leans: Math.abs(dir) >= 1 ? (dir > 0 ? team : (side === 'home' ? away : home)) : null,
            strength: Math.abs(dir) >= 1.5 ? 'moderate' : Math.abs(dir) >= 1 ? 'small' : null
          }));
          qbClaims[side].push(tc); covered('qb_trend', tc);
        }
        var lg0 = L[L.length - 1];
        var lc = add(claim({
          topic: 'qb', key: 'qb_last:' + q.p.athlete_id, team: team, side: side, subject: n,
          label: n + ': last game',
          text: 'Against ' + nameOf(lg0.opponent_key) + (lg0.kickoff ? ' on ' + dayMonth(ts(lg0.kickoff)) : '') + ', ' + n + ' went ' + lg0.completions + ' of ' + lg0.attempts + ' for ' + lg0.yards + ' yards with '
            + countWord(lg0.tds, 'touchdown') + ' and ' + countWord(lg0.interceptions, 'interception') + '.',
          short: lastName(n) + ' went ' + lg0.completions + ' of ' + lg0.attempts + ' for ' + lg0.yards + ' yards against ' + nameOf(lg0.opponent_key),
          cite: { nums: [String(lg0.completions), String(lg0.attempts), String(lg0.yards)], words: [lastName(n)] },
          values: { completions: lg0.completions, attempts: lg0.attempts, yards: lg0.yards, tds: lg0.tds, ints: lg0.interceptions, game_id: lg0.game_id },
          source: { id: 'qb_epa', label: 'EdgeDesk play-by-play quarterback logs (2026)', path: 'football/fbs_epa/qb_epa_2026.json' }, observed_at: A.qbs,
          verification: 'VERIFIED_DATA', strength: null
        }));
        qbClaims[side].push(lc); covered('qb_trend', lc);
      });
    });

    /* ---- quarterback status: the model's expectation against the official report ---- */
    var conflicts = [];
    ['home', 'away'].forEach(function (side) {
      var team = teams[side], q = g.qb && g.qb[side];
      var rep = x.reports && x.reports[side];
      var repQbs = rep && rep.rows ? rep.rows.filter(function (r) { return r.position === 'QB'; }) : [];
      if (q && q.player) {
        var contested = !!q.contested;
        var txt = contested
          ? poss(team) + ' quarterback job is unsettled in EdgeDesk’s play-by-play: ' + q.label.replace(/^unresolved:\s*/i, '').replace(/\s*—\s*sources disagree\.?$/i, '') + '. EdgeDesk’s model is built on ' + q.player + ' starting.'
          : q.player + ' started ' + poss(team) + ' last game.';   /* a starter without an announcement is not news */
        var sc = add(claim({
          topic: 'qb_status', key: 'qb_model:' + side, team: team, side: side, subject: q.player,
          label: team + ' quarterback (model input)', text: txt,
          short: contested ? poss(team) + ' quarterback job is unsettled' : q.player + ' started the last game',
          cite: contested ? { nums: [], words: ['quarterback', 'unsettled|' + lastName(q.player)], all: true } : { nums: [], words: [lastName(q.player), 'start'], all: true },
          values: { player: q.player, status: q.status, contested: contested },
          source: { id: 'cfb_terminal', label: 'EdgeDesk starter tracking (play-by-play attribution)', path: 'football/cfb_terminal/games.json' }, observed_at: q.as_of || A.terminal,
          verification: 'VERIFIED_DATA', status: q.status, material: contested
        }));
        covered('qb_availability', sc);
      }
      if (rep) {
        repQbs.forEach(function (r) {
          var st = String(r.status || '').toLowerCase();
          var rc = add(claim({
            topic: 'injury', key: 'report:' + side + ':' + r.player_name, team: team, side: side, subject: r.player_name,
            label: r.player_name + ' (official availability)',
            text: poss(team) + ' ' + (rep.report_type ? String(rep.report_type).toLowerCase() + ' ' : '') + (rep.conference_id ? rep.conference_id.toUpperCase() + ' ' : '') + 'availability report' + (rep.published_at ? ' (published ' + dayMonth(ts(rep.published_at)) + ')' : '') + ' lists quarterback ' + r.player_name + ' as ' + st + '.',
            short: r.player_name + ' is listed as ' + st + ' on the ' + (rep.conference_id ? rep.conference_id.toUpperCase() + ' ' : '') + 'availability report',
            cite: { nums: [], words: [lastName(r.player_name), 'report|lists|listed|' + st], all: true },
            values: { status: r.status, position: 'QB' },
            source: { id: 'availability_report', label: (rep.conference || 'Conference') + ' availability report (' + (rep.report_type || 'report') + ')', path: 'football/availability/reports/', url: rep.source_url || null, published_at: rep.published_at },
            observed_at: rep.published_at || rep.retrieved_at, verification: 'OFFICIAL_REPORT', status: r.status, material: true
          }));
          covered('qb_availability', rc); covered('injuries', rc);
        });
        if (q && q.player && !repQbs.some(function (r) { return r.player_name === q.player; }) && rep.listing_scope === 'FULL_ROSTER') {
          var nl = add(claim({
            topic: 'injury', key: 'report_absent:' + side, team: team, side: side, subject: q.player, label: q.player + ' (not on the report)',
            text: q.player + ' does not appear on ' + poss(team) + ' ' + (rep.report_type ? String(rep.report_type).toLowerCase() + ' ' : '') + 'availability report.',
            short: q.player + ' is not on the availability report',
            cite: { nums: [], words: [lastName(q.player), 'report|lists|listed'], all: true }, values: { status: 'NOT_LISTED', position: 'QB' },
            source: { id: 'availability_report', label: (rep.conference || 'Conference') + ' availability report (' + (rep.report_type || 'report') + ')', path: 'football/availability/reports/', url: rep.source_url || null, published_at: rep.published_at },
            observed_at: rep.published_at, verification: 'OFFICIAL_REPORT', status: 'NOT_LISTED'
          }));
          covered('qb_availability', nl);
        }
        /* conflict: the model expects one passer, the official report says another can play */
        if (q && q.player) {
          var shares = {};
          String(q.label || '').replace(/([A-Z][A-Za-z.'’-]+(?: [A-Z][A-Za-z.'’-]+)+) (\d+)% of recent dropbacks/g, function (_, nm, s) { shares[nm] = +s; return _; });
          repQbs.forEach(function (r) {
            if (r.player_name === q.player) {
              if (r.status === 'OUT' || r.status === 'DOUBTFUL') conflicts.push({ side: side, team: team, model: q.player, report: r, at: rep.published_at || rep.retrieved_at, kind: 'expected_starter_listed_' + r.status.toLowerCase() });
              return;
            }
            var avail = r.status === 'PROBABLE' || r.status === 'AVAILABLE' || r.status === 'QUESTIONABLE';
            if (avail && (shares[r.player_name] || 0) > (shares[q.player] || 0)) conflicts.push({ side: side, team: team, model: q.player, report: r, at: rep.published_at || rep.retrieved_at, share: shares[r.player_name], model_share: shares[q.player] || null, kind: 'other_qb_available' });
          });
        }
        /* everyone else on the report */
        var rows = (rep.rows || []).filter(function (r) { return r.position !== 'QB' && r.status && r.status !== 'AVAILABLE'; });
        var byStatus = {};
        rows.forEach(function (r) { (byStatus[r.status] = byStatus[r.status] || []).push(r); });
        var KEYPOS = { RB: 1, WR: 1, TE: 1, OL: 1 };
        rows.filter(function (r) { return KEYPOS[r.position] && (r.status === 'QUESTIONABLE' || r.status === 'DOUBTFUL'); }).forEach(function (r) {
          var st = String(r.status).toLowerCase();
          var ic = add(claim({
            topic: 'injury', key: 'report:' + side + ':' + r.player_name, team: team, side: side, subject: r.player_name,
            label: r.player_name + ' (' + r.position + ')',
            text: poss(team) + ' availability report lists ' + ({ RB: 'running back', WR: 'receiver', TE: 'tight end', OL: 'offensive lineman' })[r.position] + ' ' + r.player_name + ' as ' + st + '.',
            short: r.position + ' ' + r.player_name + ' (' + st + ')',
            cite: { nums: [], words: [lastName(r.player_name), 'report|lists|listed|' + st], all: true },
            values: { status: r.status, position: r.position },
            source: { id: 'availability_report', label: (rep.conference || 'Conference') + ' availability report (' + (rep.report_type || 'report') + ')', path: 'football/availability/reports/', url: rep.source_url || null, published_at: rep.published_at },
            observed_at: rep.published_at || rep.retrieved_at, verification: 'OFFICIAL_REPORT', status: r.status, material: r.position !== 'OL' || r.status === 'DOUBTFUL'
          }));
          covered('injuries', ic);
        });
        var outN = (byStatus.OUT || []).length, olOut = (byStatus.OUT || []).filter(function (r) { return r.position === 'OL'; });
        if (outN) {
          var oc = add(claim({
            topic: 'injury', key: 'report_out:' + side, team: team, side: side,
            label: team + ': players out',
            text: poss(team) + ' availability report lists ' + numWord(outN) + ' player' + (outN === 1 ? '' : 's') + ' as out' + (olOut.length ? ', including offensive ' + (olOut.length > 1 ? 'linemen ' : 'lineman ') + sentenceList(olOut.map(function (r) { return r.player_name; })) : '') + '.',
            short: numWord(outN) + ' ' + team + ' player' + (outN === 1 ? '' : 's') + ' listed out',
            cite: { nums: outN > 10 ? [String(outN)] : [], words: [team, 'out'], all: true },
            values: { out: outN, players: (byStatus.OUT || []).map(function (r) { return r.player_name + ' (' + r.position + ')'; }) },
            source: { id: 'availability_report', label: (rep.conference || 'Conference') + ' availability report', path: 'football/availability/reports/', url: rep.source_url || null, published_at: rep.published_at },
            observed_at: rep.published_at, verification: 'OFFICIAL_REPORT', material: olOut.length >= 2
          }));
          covered('injuries', oc);
        }
      }
    });
    conflicts.forEach(function (cf) {
      var txt = cf.kind === 'other_qb_available'
        ? 'EdgeDesk’s model is built on ' + cf.model + ' starting for ' + cf.team + ', but the availability report lists ' + cf.report.player_name + ' — who took ' + (cf.share ? cf.share + '% of ' + poss(cf.team) + ' recent dropbacks' : 'the larger share of recent snaps') + ' — as ' + String(cf.report.status).toLowerCase() + '. The model’s quarterback input may be out of date.'
        : 'EdgeDesk’s model is built on ' + cf.model + ' starting for ' + cf.team + ', but the availability report lists him as ' + String(cf.report.status).toLowerCase() + '.';
      add(claim({
        topic: 'input', key: 'qb_conflict:' + cf.side, team: cf.team, side: cf.side, subject: cf.report.player_name,
        label: cf.team + ': quarterback input conflict', text: txt,
        short: 'the model expects ' + cf.model + ', but ' + cf.report.player_name + ' is listed as ' + String(cf.report.status).toLowerCase(),
        cite: { nums: [], words: [lastName(cf.report.player_name), 'model|report|lists|listed|' + String(cf.report.status).toLowerCase()], all: true },
        values: { model_starter: cf.model, reported: cf.report.player_name, status: cf.report.status },
        source: { id: 'input_audit', label: 'EdgeDesk input audit (model starter vs official availability report)' }, observed_at: [A.terminal, cf.at].filter(function (t) { return ts(t) != null; }).sort(function (a, b) { return ts(b) - ts(a); })[0] || null,
        verification: 'CONFLICTING', material: true
      }));
    });

    /* ---- results, records, schedule ---- */
    var finals = x.finals || {};
    var kick = ts(g.kickoff);
    var lastKick = { home: null, away: null };
    var confRec = {};
    ['home', 'away'].forEach(function (side) {
      var team = teams[side], prof = x.profiles && x.profiles[side];
      var opps = (prof && prof.opponents) || [];
      if (!opps.length) return;
      var w = 0, l = 0, cw = 0, cl = 0, confKnown = true;
      var rows = opps.map(function (o) {
        var f = finals[String(o.game_id)];
        var pf = o.points_for, pa = o.points_against, certified = false, where = null, t = null, conf = null;
        if (f && f.final) {
          var isHome = f.home === team;
          pf = isHome ? f.final.home_score : f.final.away_score; pa = isHome ? f.final.away_score : f.final.home_score;
          certified = true; where = f.neutral_site ? 'vs.' : (isHome ? 'vs.' : 'at'); t = ts(f.kickoff); conf = f.matchup_type === 'conference';
        } else {
          t = f ? ts(f.kickoff) : null;
          /* no certified final: it only blocks the conference record if it was a conference game */
          var oc = (x.rankings && x.rankings.by_name || {})[o.opponent];
          var myConf = side === 'home' ? gm.home_conference : gm.away_conference;
          if (oc && (!oc.conference || oc.conference === myConf)) confKnown = false;
        }
        if (!isNum(pf) || !isNum(pa)) return null;
        if (pf > pa) w++; else if (pa > pf) l++;
        if (conf) { if (pf > pa) cw++; else cl++; }
        return { opp: o.opponent, pf: pf, pa: pa, certified: certified, where: where, t: t, game_id: String(o.game_id) };
      }).filter(Boolean);
      rows.forEach(function (r) { if (r.t != null && r.t < (kick || now) && (lastKick[side] == null || r.t > lastKick[side])) lastKick[side] = r.t; });
      var recC = add(claim({
        topic: 'results', key: 'record:' + side, team: team, side: side, label: team + ' record',
        text: team + ' is ' + w + '–' + l + ' this season, scoring ' + f1(prof.scoring && isNum(prof.scoring.points_for_per_game) ? prof.scoring.points_for_per_game : rows.reduce(function (s, r) { return s + r.pf; }, 0) / rows.length)
          + ' points per game and allowing ' + f1(rows.reduce(function (s, r) { return s + r.pa; }, 0) / rows.length) + '.',
        short: team + ' (' + w + '–' + l + ')',
        cite: { nums: [String(w), String(l)], words: [team] },
        values: { wins: w, losses: l, ppg: r1(rows.reduce(function (s, r) { return s + r.pf; }, 0) / rows.length), papg: r1(rows.reduce(function (s, r) { return s + r.pa; }, 0) / rows.length) },
        source: { id: 'results', label: 'EdgeDesk results record (certified finals) and play-by-play scores', path: 'record/football/cfb_2026.json' }, observed_at: A.record,
        verification: 'VERIFIED_DATA', caveat: rows.every(function (r) { return r.certified; }) ? null : 'one or more scores are the play-by-play final, not a certified final'
      }));
      /* points per game must reproduce from the rows above, so recompute the text from them */
      recC.values.ppg = r1(rows.reduce(function (s, r) { return s + r.pf; }, 0) / rows.length);
      recC.text = team + ' is ' + w + '–' + l + ' this season, scoring ' + f1(recC.values.ppg) + ' points per game and allowing ' + f1(recC.values.papg) + '.';
      recC.cite = { nums: [String(w), String(l)], words: [team] };
      covered('recent_results', recC); covered('off_points', recC); covered('def_points', recC);
      if (confKnown && (cw + cl) > 0) confRec[side] = { w: cw, l: cl };
      rows.slice(-2).forEach(function (r) {
        var won = r.pf > r.pa;
        var rc = add(claim({
          topic: 'results', key: 'result:' + r.game_id + ':' + side, team: team, side: side, label: team + ' vs ' + r.opp,
          text: team + ' ' + (won ? 'beat ' : 'lost ') + (won ? '' : '') + score(r.pf, r.pa) + (won ? '' : '') + ' ' + (won ? '' : (r.where === 'at' ? 'at ' : 'to ')) + (won ? '' : r.opp) + (won ? r.opp + ' ' + score(r.pf, r.pa) : '') + (r.t ? ' on ' + dayMonth(r.t) : '') + '.',
          short: (won ? 'beat ' + r.opp + ' ' : 'lost ' + score(r.pf, r.pa) + ' ' + (r.where === 'at' ? 'at ' : 'to ') + r.opp) + (won ? score(r.pf, r.pa) : ''),
          cite: { nums: [String(Math.max(r.pf, r.pa)), String(Math.min(r.pf, r.pa))], words: [r.opp] },
          values: { opponent: r.opp, points_for: r.pf, points_against: r.pa, certified: r.certified },
          source: r.certified ? { id: 'results', label: 'Certified final (EdgeDesk results record)', path: 'record/football/cfb_2026.json' } : { id: 'profiles', label: 'Play-by-play final score', path: 'football/matchup/profiles_2026.json' },
          observed_at: r.certified ? A.record : A.profiles, verification: 'VERIFIED_DATA'
        }));
        /* a cleaner sentence than the concatenation above */
        rc.text = won ? team + ' beat ' + r.opp + ' ' + score(r.pf, r.pa) + (r.t ? ' on ' + dayMonth(r.t) : '') + '.'
          : team + ' lost ' + score(r.pf, r.pa) + ' ' + (r.where === 'at' ? 'at ' : 'to ') + r.opp + (r.t ? ' on ' + dayMonth(r.t) : '') + '.';
        covered('recent_results', rc);
      });
      /* who they have played: EdgeDesk ranks of the opponents (a proxy, not a schedule-strength number) */
      var ranked = rows.map(function (r) { var t = (x.rankings && x.rankings.by_name || {})[r.opp]; return t && isNum(t.rank) ? { opp: r.opp, rank: t.rank } : null; }).filter(Boolean);
      if (ranked.length >= 2) {
        var avg = ranked.reduce(function (s, r) { return s + r.rank; }, 0) / ranked.length;
        var top = ranked.filter(function (r) { return r.rank <= 25; });
        var oc2 = add(claim({
          topic: 'schedule', key: 'opponents:' + side, team: team, side: side, label: team + ': opponents faced',
          text: poss(team) + ' opponents so far have an average EdgeDesk rank of ' + Math.round(avg) + (top.length ? ', with ' + sentenceList(top.map(function (r) { return r.opp + ' (No. ' + r.rank + ')'; })) + ' inside the top 25' : ' and none inside the top 25') + '.',
          short: poss(team) + ' opponents average an EdgeDesk rank of ' + Math.round(avg),
          cite: { nums: [String(Math.round(avg))], words: ['opponents', 'schedule'] },
          values: { average_rank: Math.round(avg), opponents: ranked },
          source: { id: 'rankings', label: 'EdgeDesk national ranks of the opponents played', path: 'football/rankings/current.json' }, observed_at: A.rankings,
          verification: 'RATING', caveat: 'an average of current EdgeDesk ranks; EdgeDesk publishes no strength-of-schedule number'
        }));
        covered('opp_strength', oc2); covered('schedule_strength', oc2);
      }
    });
    if (confRec.home && confRec.away && gm.matchup_type === 'conference') {
      var cn = gm.home_conference || 'conference';
      var cc = add(claim({
        topic: 'conference', key: 'conference', team: null, label: cn + ' records',
        text: home + ' is ' + confRec.home.w + '–' + confRec.home.l + ' and ' + away + ' is ' + confRec.away.w + '–' + confRec.away.l + ' in ' + cn + ' play.',
        short: home + ' ' + confRec.home.w + '–' + confRec.home.l + ', ' + away + ' ' + confRec.away.w + '–' + confRec.away.l + ' in ' + cn + ' play',
        cite: { nums: [], words: [cn + ' play', 'conference'] },
        values: { home: confRec.home, away: confRec.away, conference: cn },
        source: { id: 'results', label: 'Certified finals (EdgeDesk results record)', path: 'record/football/cfb_2026.json' }, observed_at: A.record, verification: 'VERIFIED_DATA'
      }));
      covered('conference', cc);
    }
    /* rest */
    if (kick != null && lastKick.home != null && lastKick.away != null) {
      var dh = Math.round((kick - lastKick.home) / 86400000), da = Math.round((kick - lastKick.away) / 86400000);
      var more = dh > da ? home : (da > dh ? away : null);
      var rest = add(claim({
        topic: 'situational', key: 'rest', team: more, label: 'Rest',
        text: more ? more + ' comes in on ' + Math.max(dh, da) + ' days of rest' + (Math.max(dh, da) >= 13 ? ' after an open week' : '') + '; ' + (more === home ? away : home) + ' has had ' + Math.min(dh, da) + ' days.' : 'Both teams have had ' + dh + ' days since their last game.',
        short: more ? more + ' has ' + Math.max(dh, da) + ' days of rest to ' + Math.min(dh, da) : 'equal rest',
        cite: { nums: more ? [String(Math.max(dh, da))] : [String(dh)], words: ['rest', 'days', 'open week', 'bye'] },
        values: { home_days: dh, away_days: da },
        source: { id: 'results', label: 'Kickoff times of each team’s previous game', path: 'record/football/cfb_2026.json' }, observed_at: A.record,
        verification: 'VERIFIED_DATA', leans: more && Math.abs(dh - da) >= 5 ? more : null, strength: more && Math.abs(dh - da) >= 5 ? 'small' : null,
        caveat: (g.why && (g.why.rows || []).some(function (r) { return r.key === 'schedule' && Math.abs(r.points) < 0.05; })) ? 'EdgeDesk’s model gives rest no weight in this game' : null
      }));
      covered('rest_travel', rest);
    }
    /* home field: the model's number, and what the market has historically made of it */
    var hfaRow = ((g.why && g.why.rows) || []).filter(function (r) { return r.key === 'hfa'; })[0];
    var exPart = g.disagreement_explainer && (g.disagreement_explainer.parts || []).filter(function (p) { return p.key === 'home_field'; })[0];
    if (hfaRow && Math.abs(hfaRow.points) >= 0.5) {
      var priced = exPart && isNum(exPart.discount) ? clamp(1 - exPart.discount, 0, 1) : null;
      var hc = add(claim({
        topic: 'model', key: 'hfa', team: hfaRow.favors, label: 'Home field (model)',
        text: 'EdgeDesk’s model gives ' + home + ' ' + f1(hfaRow.points) + ' points for playing at home — a league-wide value, not one measured for this stadium' + (priced != null ? '; historically, the closing market has priced about ' + pct0(priced) + ' of EdgeDesk’s home-field number' : '') + '.',
        short: 'the model’s league-wide home-field value (' + f1(hfaRow.points) + ' points)',
        cite: { nums: [f1(hfaRow.points)], words: ['home'] },
        values: { points: r2(hfaRow.points), market_priced_share: priced },
        source: { id: 'cfb_terminal', label: 'EdgeDesk model terms and disagreement explainer', path: 'football/cfb_terminal/games.json' }, observed_at: A.terminal,
        verification: 'MODEL_OUTPUT'
      }));
      covered('home_field', hc);
    } else if (gm.neutral_site) {
      var nc = add(claim({ topic: 'situational', key: 'neutral', label: 'Neutral site', text: 'The game is at a neutral site' + (gm.venue ? ', ' + gm.venue : '') + ', so neither team gets home field.', short: 'a neutral site', cite: { nums: [], words: ['neutral'] }, source: { id: 'cfb_terminal', label: 'EdgeDesk schedule', path: 'football/cfb_terminal/games.json' }, observed_at: A.terminal, verification: 'VERIFIED_DATA' }));
      covered('home_field', nc);
    }
    /* weather */
    var fc = x.forecast;
    if (fc && !fc.dome && isNum(fc.temp_f)) {
      var material = (isNum(fc.wind_mph) && fc.wind_mph >= 15) || (isNum(fc.gust_mph) && fc.gust_mph >= 25) || (isNum(fc.precip_pct) && fc.precip_pct >= 60);
      var wc = add(claim({
        topic: 'situational', key: 'weather', label: 'Forecast',
        text: 'The kickoff forecast' + (fc.as_of ? ' (as of ' + dayMonth(ts(fc.as_of)) + ')' : '') + ' calls for ' + Math.round(fc.temp_f) + ' degrees' + (fc.text ? ' and ' + String(fc.text).toLowerCase() : '')
          + (isNum(fc.precip_pct) ? ' (' + Math.round(fc.precip_pct) + '% chance of rain)' : '') + (isNum(fc.wind_mph) ? ', with wind around ' + Math.round(fc.wind_mph) + ' mph' + (isNum(fc.gust_mph) && fc.gust_mph >= 20 ? ' and gusts near ' + Math.round(fc.gust_mph) : '') : '') + '.',
        short: Math.round(fc.temp_f) + ' degrees' + (fc.text ? ', ' + String(fc.text).toLowerCase() : '') + (isNum(fc.gust_mph) && fc.gust_mph >= 20 ? ', gusts near ' + Math.round(fc.gust_mph) + ' mph' : ''),
        cite: { nums: [String(Math.round(fc.temp_f))], words: ['forecast', 'degrees', 'wind', 'rain'] },
        values: { temp_f: fc.temp_f, wind_mph: fc.wind_mph, gust_mph: fc.gust_mph, precip_pct: fc.precip_pct, text: fc.text },
        source: { id: 'forecast', label: 'Open-Meteo kickoff-hour forecast', path: 'football/venues/forecasts.json' }, observed_at: fc.as_of || A.forecasts,
        verification: 'VERIFIED_DATA', material: material,
        caveat: 'a forecast, not an observation; EdgeDesk’s model moves no spread for weather'
      }));
      covered('weather', wc);
    } else if (fc && fc.dome) {
      covered('weather', add(claim({ topic: 'situational', key: 'weather', label: 'Indoors', text: 'The game is indoors, so weather is not a factor.', short: 'indoors', cite: { nums: [], words: ['indoors', 'dome'] }, source: { id: 'forecast', label: 'EdgeDesk venue table', path: 'football/venues/forecasts.json' }, observed_at: A.forecasts, verification: 'VERIFIED_DATA' })));
    }
    /* head-to-head: the archive, dated (historical, never current) */
    var h2h = (x.h2h || []).filter(function (r) { return isNum(r.home_points) && isNum(r.away_points); }).sort(function (a, b) { return (a.season - b.season) || ((ts(a.kickoff) || 0) - (ts(b.kickoff) || 0)); });
    if (h2h.length) {
      var lastM = h2h[h2h.length - 1];
      var hw = {}, n0 = h2h[0].season;
      h2h.forEach(function (r) { var wnr = r.home_points > r.away_points ? r.home : (r.away_points > r.home_points ? r.away : null); if (wnr) hw[wnr] = (hw[wnr] || 0) + 1; });
      var lw = lastM.home_points > lastM.away_points ? lastM.home : lastM.away, ll = lw === lastM.home ? lastM.away : lastM.home;
      var hc2 = add(claim({
        topic: 'history', key: 'h2h', team: null, label: 'Head-to-head',
        text: 'The last meeting, in ' + lastM.season + ', went to ' + lw + ', ' + score(lastM.home_points, lastM.away_points) + (lastM.neutral ? ' at a neutral site' : ' at ' + (lastM.home === lw ? 'home' : ll)) + '; in EdgeDesk’s archive of ' + h2h.length + ' meetings since ' + n0 + ', '
          + home + ' won ' + (hw[home] || 0) + ' and ' + away + ' won ' + (hw[away] || 0) + '. Those games were played by different rosters.',
        short: lw + ' won the last meeting, ' + score(lastM.home_points, lastM.away_points) + ', in ' + lastM.season,
        cite: { nums: [String(lastM.season)], words: ['meeting', 'met', 'series', 'last time'] },
        values: { last: { season: lastM.season, home: lastM.home, away: lastM.away, home_points: lastM.home_points, away_points: lastM.away_points }, meetings: h2h.length, wins: hw, since: n0 },
        scope: 'historical',
        source: { id: 'lines_archive', label: 'EdgeDesk college results-and-lines archive (2006–2025)', path: 'football/pricing/lines_cfb.json' }, observed_at: A.lines,
        verification: 'VERIFIED_DATA', caveat: 'historical results; rosters and coaches have changed'
      }));
      covered('head_to_head', hc2);
    }
    /* coaching and roster turnover (what the model weights differently) */
    ['home', 'away'].forEach(function (side) {
      var team = teams[side];
      var co = x.metrics && x.metrics[side] && x.metrics[side].coaching;
      var rg = g.edgedesk && g.edgedesk.regime && g.edgedesk.regime[side];
      if (co && co.new_hc) {
        var pc = add(claim({
          topic: 'personnel', key: 'coach:' + side, team: team, side: side, subject: co.hc,
          label: team + ': new head coach',
          text: team + ' is in its first season under head coach ' + co.hc + (rg && rg.reason && /returning roster share at the (\d+)/.test(rg.reason) ? ', with a returning roster share in the ' + rg.reason.match(/returning roster share at the (\d+\w*)/)[1] + ' percentile nationally' : '') + '.',
          short: poss(team) + ' first season under ' + co.hc,
          cite: { nums: [], words: [lastName(co.hc), 'first season|first year|returning|new coach|new head coach'], all: true },
          values: { hc: co.hc, regime: rg ? { weight: rg.weight, standard_weight: rg.standard_weight, reason: rg.reason } : null },
          source: { id: 'coaching', label: 'EdgeDesk coaching and roster-continuity data', path: 'football/coaching/continuity.json' }, observed_at: co.as_of || A.metrics,
          verification: 'VERIFIED_DATA'
        }));
        covered('injuries', pc);
      }
    });

    /* ---- outside reporting: the desk's facts ledger and notebook ---- */
    (x.facts || []).forEach(function (f) {
      var exp = ts(f.expires_at);
      if (exp != null && exp <= now) return;
      var status = f.verification === 'VERIFIED' ? 'VERIFIED_REPORT' : 'REPORTED';
      var c = add(claim({
        topic: f.kind === 'availability' ? 'injury' : (f.kind === 'result' ? 'results' : (f.kind === 'head_to_head' ? 'history' : (f.kind === 'preseason_note' ? 'preseason' : (f.kind === 'qb_stats' ? 'qb' : (f.topic || 'report'))))),
        key: 'fact:' + f.id, team: f.team || null, subject: f.subject || null,
        label: f.label || (f.subject || f.team || 'Report'),
        text: f.text, short: f.short || f.text,
        cite: f.cite || { nums: [], words: [f.subject ? lastName(f.subject) : (f.team || '')] },
        values: f.values || null,
        scope: f.scope || 'report',
        source: { id: 'facts', label: f.source && f.source.publisher || 'reporting', publisher: f.source && f.source.publisher, url: f.source && f.source.url, title: f.source && f.source.title, published_at: f.source && f.source.published_at, corroboration: f.corroboration || [] },
        observed_at: f.source && f.source.published_at || f.recorded_at,
        verification: status, leans: f.leans || null, strength: f.strength || null, material: !!f.material, status: f.status_designation || null,
        caveat: status === 'REPORTED' ? 'recorded from ' + (f.source && f.source.publisher || 'reporting') + '; not yet confirmed at the source by an EdgeDesk editor' : null
      }));
      if (f.covers) [].concat(f.covers).forEach(function (it) { covered(it, c); });
    });
    (x.notes || []).forEach(function (n) {
      var exp = ts(n.expires_at); if (exp != null && exp <= now) return;
      var c = add(claim({ topic: 'report', key: 'note:' + n.id, team: n.team || null, label: 'Desk note', text: n.text, cite: { nums: [], words: [n.text.split(' ').slice(0, 2).join(' ')] },
        source: { id: 'desk_notes', label: n.source, url: n.url, published_at: n.published_at }, observed_at: n.published_at, verification: 'REPORTED',
        caveat: 'desk note recorded by ' + n.recorded_by }));
      covered('injuries', c);
    });

    /* ---- the model and the market ---- */
    var model = modelOf(g), market = marketOf(g, now);
    var mclaims = modelClaims(g, model, market, x.record, A);
    mclaims.forEach(add);

    var packet = {
      schema: SCHEMA, version: VERSION, league: 'cfb', game_id: String(g.game_id), season: g.season, week: g.week,
      key: 'cfb:' + g.season + ':' + g.game_id,
      home: home, away: away, kickoff: g.kickoff, venue: gm.venue || null, neutral_site: !!gm.neutral_site,
      built_at: iso(now), observed: A,
      model: model, market: market,
      claims: claims,
      coverage: coverageOf(cov, 'cfb', x),
      pairs: pairs.map(function (p) { return { key: p.key, offense: p.O, defense: p.D, edge: r2(p.edge), collision: r2(p.collision), favors: p.favors, claim: p.claim.id, sample: Math.round(p.sample) }; })
    };
    packet.explanation = explain(packet, g, x);
    finalize(packet);
    packet.inputs_hash = hash(JSON.stringify([g.built_at, A, (x.facts || []).map(function (f) { return f.id + (f.expires_at || ''); }), x.reports && [x.reports.home && x.reports.home.published_at, x.reports.away && x.reports.away.published_at]]));
    packet.hash = hash(JSON.stringify(packet.claims) + JSON.stringify(packet.explanation));
    return packet;
  }
  function cap(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }

  function modelOf(g) {
    var e = g.edgedesk || {}, gm = g.game || {};
    if (!e.available || !isNum(e.fair_home_line)) return { available: false };
    var hl = r1(e.fair_home_line);
    var fav = hl < -0.05 ? gm.home : (hl > 0.05 ? gm.away : null);
    return {
      available: true, home_line: hl, favorite: fav, margin: r1(Math.abs(hl)),
      text: fav ? fav + ' by ' + f1(Math.abs(hl)) : 'a pick’em',
      home_win_prob: isNum(e.home_win_prob) ? r2(e.home_win_prob) : null,
      projected: e.projected_score && isNum(e.projected_score.home) ? { home: r1(e.projected_score.home), away: r1(e.projected_score.away) } : null,
      total: isNum(e.fair_total) ? r1(e.fair_total) : null, version: e.model_version || null, as_of: e.prediction_ts || null
    };
  }
  function marketOf(g, now) {
    var m = g.market || {}, gm = g.game || {};
    var best = null;
    (m.quotes || []).forEach(function (q) { var t = ts(q.observed_at); if (t == null || !isNum(q.home_line)) return; if (!best || t > best.t) best = { t: t, q: q }; });
    if (!best) return { status: 'none', comparable: false, reason: 'no captured line' };
    var age = Math.round((now - best.t) / 60000);
    var hl = r1(best.q.home_line);
    var fav = hl < -0.05 ? gm.home : (hl > 0.05 ? gm.away : null);
    var book = { draftkings: 'DraftKings', fanduel: 'FanDuel', 'cfbd consensus': 'CollegeFootballData consensus', betmgm: 'BetMGM', caesars: 'Caesars', espnbet: 'ESPN BET' }[String(best.q.book || '').toLowerCase()] || best.q.book || null;
    var mapping = ((g.market_check && g.market_check.checks) || []).filter(function (c) { return c.area === 'Mapping'; })[0];
    return {
      status: age <= STALE_MINUTES ? 'current' : 'stale', home_line: hl, favorite: fav, margin: r1(Math.abs(hl)),
      text: fav ? fav + ' -' + (Math.abs(hl) % 1 === 0 ? String(Math.abs(hl)) : Math.abs(hl).toFixed(1)) : 'pick’em',
      book: book, captured_at: iso(best.t),
      open_home_line: isNum(m.open_home_line) ? r1(m.open_home_line) : null,
      comparable: !(mapping && mapping.status === 'FAIL'),
      reason: age <= STALE_MINUTES ? 'a full-game spread captured within three hours' : 'a full-game spread captured more than three hours before this build: comparable, but not a current price'
    };
  }

  /* the model's own numbers about this game — never football evidence */
  function modelClaims(g, model, market, record, A) {
    var out = [], gm = g.game || {};
    var src = { id: 'cfb_terminal', label: 'EdgeDesk CFB research terminal', path: 'football/cfb_terminal/games.json' };
    if (model.available) {
      out.push(claim({ topic: 'model', key: 'projection', label: 'EdgeDesk projection', text: 'EdgeDesk’s model makes it ' + model.text + (model.projected ? ' (projected ' + f1(Math.max(model.projected.home, model.projected.away)) + '–' + f1(Math.min(model.projected.home, model.projected.away)) + ')' : '') + '.',
        short: 'EdgeDesk ' + model.text, cite: { nums: [f1(model.margin)], words: ['EdgeDesk', 'model', 'projection'] }, values: model, source: src, observed_at: model.as_of || A.terminal, verification: 'MODEL_OUTPUT' }));
    }
    if (market.status !== 'none') {
      out.push(claim({ topic: 'market', key: 'market', label: 'Captured line', text: 'The ' + (market.status === 'current' ? 'current' : 'last captured') + ' line had ' + market.text + (market.book ? ' (' + market.book + ', captured ' + dayMonth(ts(market.captured_at)) + ')' : '') + '.',
        short: market.text, cite: { nums: [String(market.margin)], words: ['line', 'market', 'captured'] }, values: market, source: { id: 'market', label: market.book ? market.book + ' (captured line)' : 'captured line', path: 'football/cfb_lab/ledger/2026' },
        observed_at: market.captured_at, verification: 'MARKET_DATA', scope: 'market' }));
    }
    ((g.why && g.why.rows) || []).forEach(function (r) {
      if (!isNum(r.points) || Math.abs(r.points) < 0.3 || r.key === 'hfa') return;
      var lab = termLabel(r);
      out.push(claim({ topic: 'model', key: 'term:' + r.key, team: r.favors, label: 'Model term: ' + lab,
        text: 'In EdgeDesk’s model, ' + lab.toLowerCase() + ' is worth ' + f1(Math.abs(r.points)) + ' points toward ' + r.favors + '.',
        short: lab.toLowerCase() + ' (' + f1(Math.abs(r.points)) + ' points toward ' + r.favors + ')',
        cite: { nums: [f1(Math.abs(r.points))], words: [lab.split(' ')[0].toLowerCase(), r.favors] }, values: { points: r2(r.points), favors: r.favors }, source: src, observed_at: A.terminal, verification: 'MODEL_OUTPUT' }));
    });
    var ex = g.disagreement_explainer;
    var ourGap = model.available && market.status !== 'none' ? Math.abs(market.home_line - model.home_line) : null;
    if (ex && ex.available && isNum(ex.explained_points) && isNum(ex.gap_points) && Math.abs(ex.gap_points) > 0 && ourGap != null && ourGap >= MATERIAL_GAP) {
      /* the explainer's share, applied to the gap THIS article states (the explainer
         runs against the consensus line, which can differ by a few tenths) */
      var shareX = clamp(isNum(ex.share_explained) ? ex.share_explained : ex.explained_points / ex.gap_points, 0, 1);
      var gapP = r1(ourGap), expl = r1(gapP * shareX);
      out.push(claim({ topic: 'model', key: 'explainer', label: 'How much of the gap EdgeDesk can explain',
        text: 'EdgeDesk’s own breakdown of how the closing market has historically treated each piece of its number accounts for about ' + f1(expl) + ' of the ' + f1(gapP) + ' points between the model and the line.',
        short: 'EdgeDesk’s breakdown accounts for about ' + f1(expl) + ' of the ' + f1(gapP) + ' points',
        cite: { nums: [f1(expl)], words: ['account', 'explain', 'unexplained', 'traced', 'trace', 'breakdown'] }, values: { explained: expl, gap: gapP, share: r2(shareX), caveat: ex.caveat || null },
        source: { id: 'cfb_terminal', label: 'EdgeDesk disagreement explainer (fit 2021–2025)', path: 'football/cfb_terminal/games.json' }, observed_at: A.terminal, verification: 'MODEL_OUTPUT' }));
    }
    var cons = g.consensus;
    if (cons && cons.available) {
      var others = (cons.rows || []).filter(function (r) { return r.key !== 'v1' && r.independent && isNum(r.home_margin); });
      if (others.length) {
        var lines = others.map(function (r) { return -r.home_margin; }).sort(function (a, b) { return a - b; });
        var medLine = lines.length % 2 ? lines[(lines.length - 1) / 2] : (lines[lines.length / 2 - 1] + lines[lines.length / 2]) / 2;
        var say = function (hl) { var fv = hl < -0.05 ? gm.home : (hl > 0.05 ? gm.away : null); return fv ? fv + ' by ' + f1(Math.abs(hl)) : 'a pick’em'; };
        out.push(claim({ topic: 'model', key: 'other_models', label: 'EdgeDesk’s other models',
          text: 'EdgeDesk’s ' + numWord(others.length) + ' other, independently built models have ' + sentenceList(lines.map(say)) + '.',
          short: 'EdgeDesk’s other models: ' + sentenceList(lines.map(say)),
          cite: { nums: [f1(Math.abs(lines[0]))], words: ['other', 'models'] }, values: { median_home_line: r1(medLine), models: others.map(function (r) { return { label: r.label, text: r.text }; }) },
          source: src, observed_at: A.terminal, verification: 'MODEL_OUTPUT' }));
      }
    }
    var hist = g.historical && (g.historical.sets || [])[0];
    if (hist && isNum(hist.n) && hist.n >= 30) {
      out.push(claim({ topic: 'model', key: 'track_record', label: 'EdgeDesk’s record in similar spots',
        text: 'When EdgeDesk’s number has been this far from the closing line (' + String(hist.label).replace(/^EdgeDesk\s*/, '').replace(/ off the close$/, ' off') + '), the side it favored covered ' + hist.w + ' of ' + (hist.w + hist.l) + ' times (' + f1(hist.pct) + '%).',
        short: 'EdgeDesk ' + hist.w + '–' + hist.l + ' against the spread in similar spots',
        cite: { nums: [String(hist.w), String(hist.w + hist.l)], words: ['covered', 'record'] }, values: hist,
        scope: 'historical', source: { id: 'record', label: 'EdgeDesk’s public record, graded against the close', path: 'record/football/cfb_2026.json' }, observed_at: A.terminal, verification: 'MODEL_OUTPUT' }));
    }
    var fp = record && record.research && record.research.market;
    if (fp && fp.classification) {
      out.push(claim({ topic: 'model', key: 'classification', label: 'EdgeDesk’s own label for this gap', text: 'EdgeDesk’s game page labels this comparison “' + fp.classification + '”: ' + (fp.classification_note || '') ,
        short: 'labelled ' + fp.classification, cite: { nums: [], words: [String(fp.classification).toLowerCase().split(' ')[0]] }, values: { classification: fp.classification },
        source: { id: 'article_record', label: 'EdgeDesk game research page', path: 'articles/data/records/' }, observed_at: record.updated_at || null, verification: 'MODEL_OUTPUT' }));
    }
    return out;
  }

  /* the research items the brief asks for, and whether each was available */
  var COVERAGE = [
    ['qb_efficiency', 'Quarterback efficiency'], ['qb_completion', 'Completion rate'], ['qb_ypa', 'Yards per attempt'], ['qb_td_int', 'Touchdowns and interceptions'],
    ['qb_sacks', 'Sacks taken'], ['qb_trend', 'Recent quarterback form'], ['qb_availability', 'Quarterback availability'],
    ['off_points', 'Points per game'], ['off_efficiency', 'Offensive efficiency'], ['off_rush_pass', 'Rushing and passing production'], ['off_explosive', 'Explosive plays'],
    ['off_third', 'Third-down conversion'], ['off_red_zone', 'Red-zone production'], ['off_line', 'Offensive-line performance'], ['opp_strength', 'Recent opponent strength'],
    ['def_points', 'Points allowed'], ['def_rush_pass', 'Rushing and passing defense'], ['def_pressure', 'Pressure and sacks'], ['def_explosive', 'Explosive plays allowed'],
    ['def_third', 'Third-down defense'], ['def_red_zone', 'Red-zone defense'], ['position_groups', 'Position-group advantages'], ['turnovers', 'Turnover rates'],
    ['home_field', 'Home field'], ['recent_results', 'Recent results'], ['schedule_strength', 'Strength of schedule'], ['head_to_head', 'Historical meetings'],
    ['injuries', 'Injuries and personnel'], ['rest_travel', 'Rest and travel'], ['weather', 'Weather'], ['conference', 'Conference implications'], ['penalties', 'Penalty rate']
  ];
  var MISSING_WHY = {
    penalties: 'EdgeDesk holds no current-season penalty data for this league',
    turnovers: 'the play-by-play feed does not attribute fumbles reliably, so turnover rates are not used (quarterback interceptions are)',
    schedule_strength: 'EdgeDesk publishes no strength-of-schedule number; opponent ranks are shown instead where available',
    head_to_head: 'no prior meeting in EdgeDesk’s results archive',
    conference: 'not a conference game, or a conference record could not be certified',
    weather: 'no forecast on file',
    rest_travel: 'previous-game kickoff times not on file',
    off_third: 'no third-down data for this league', def_third: 'no third-down data for this league',
    off_red_zone: 'no red-zone data for this league', def_red_zone: 'no red-zone data for this league'
  };
  function coverageOf(cov, league, x) {
    return COVERAGE.map(function (it) {
      var ids = uniq(cov[it[0]] || []);
      var proxy = it[0] === 'schedule_strength' && ids.length;
      return { item: it[0], label: it[1], status: ids.length ? (proxy ? 'PROXY' : 'AVAILABLE') : 'MISSING', claims: ids, why: ids.length && !proxy ? null : (MISSING_WHY[it[0]] || 'not in EdgeDesk’s verified data for this game') };
    });
  }

  /* ======================================================================
     EXPLAIN — the model against the market, in football terms
     ====================================================================== */
  var WEIGHT = { large: 3, moderate: 2, small: 1 };
  function explain(packet, g, x) {
    var model = packet.model, market = packet.market;
    var home = packet.home, away = packet.away;
    var C = packet.claims;
    var byId = {}; C.forEach(function (c) { byId[c.id] = c; });
    var out = { status: null, actionable: false, input_suspect: false, input_flags: [], supporting: [], contradicting: [], uncertainty: [], what_must_happen: [], game_script: { model_case: [], market_case: [] } };
    if (!model.available) { out.status = 'NO_PROJECTION'; out.assessment = 'EdgeDesk has no projection for this game.'; return out; }
    out.projection = { text: model.text, home_line: model.home_line };
    if (market.status === 'none' || !market.comparable) {
      out.status = 'NO_COMPARABLE_MARKET';
      out.market = { status: market.status, text: null };
      out.assessment = 'There is no verified comparable market line on file, so there is no disagreement to explain.';
    } else {
      out.market = { status: market.status, text: market.text, book: market.book, captured_at: market.captured_at, home_line: market.home_line, comparable_reason: market.reason };
    }
    var gap = out.market && out.market.text ? Math.abs(market.home_line - model.home_line) : null;
    /* toward: the team the model likes MORE than the market does */
    var towardSide = gap == null ? null : (market.home_line - model.home_line > 0 ? 'home' : 'away');
    var T = towardSide ? packet[towardSide] : null, O = towardSide ? packet[towardSide === 'home' ? 'away' : 'home'] : null;
    if (gap != null) out.gap = { points: r1(gap), toward: T, other: O, toward_side: towardSide, size: gap >= MAJOR_GAP ? 'major' : gap >= 5 ? 'notable' : gap >= MATERIAL_GAP ? 'moderate' : 'minor' };

    /* model terms */
    out.model_terms = ((g.why && g.why.rows) || []).filter(function (r) { return isNum(r.points) && Math.abs(r.points) >= 0.05; }).map(function (r) {
      return { key: r.key, label: termLabel(r), points: r2(Math.abs(r.points)), favors: r.favors, toward_gap: T ? r.favors === T : null };
    });
    var ex = g.disagreement_explainer;
    if (ex && ex.available && isNum(ex.explained_points) && isNum(ex.gap_points) && Math.abs(ex.gap_points) > 0) {
      var share = clamp(isNum(ex.share_explained) ? ex.share_explained : ex.explained_points / ex.gap_points, 0, 1);
      var gapN = gap != null ? gap : Math.abs(ex.gap_points);
      out.mechanical = { share: r2(share), explained_points: r1(r1(gapN) * share), unexplained_points: r1(r1(gapN) - r1(r1(gapN) * share)),
        parts: (ex.parts || []).filter(function (p) { return p.significant && isNum(p.explained_points) && Math.abs(p.explained_points) >= 0.3; }).map(function (p) { return { key: p.key, label: p.label, points: r1(p.explained_points) }; }),
        basis: ex.caveat || null };
    }
    out.market_implied = g.why && g.why.market_implied && g.why.market_implied.text || null;

    /* football balance: measured claims leaning toward T support the model's side of the gap */
    if (T) {
      C.forEach(function (c) {
        if (!c.football || !c.leans || !c.strength || c.component) return;
        if (c.leans === T) out.supporting.push(c.id); else if (c.leans === O) out.contradicting.push(c.id);
      });
      var w = function (ids) { return ids.reduce(function (s, id) { var c = byId[id]; return s + (WEIGHT[c.strength] || 0) * (c.measured ? 1 : 0.5) * (c.caveat && /small sample/.test(c.caveat) ? 0.5 : 1); }, 0); };
      var rankOf = function (c) { return (WEIGHT[c.strength] || 0) * (c.measured ? 1 : 0.6) * (c.caveat && /small sample/.test(c.caveat) ? 0.5 : 1) + (c.topic === 'matchup' ? 0.1 : 0); };
      var sortIds = function (ids) { return ids.sort(function (a, b) { return rankOf(byId[b]) - rankOf(byId[a]); }); };
      sortIds(out.supporting); sortIds(out.contradicting);
      out.football_balance = { supporting: r1(w(out.supporting)), contradicting: r1(w(out.contradicting)) };
      out.football_balance.score = r1(out.football_balance.supporting - out.football_balance.contradicting);
      /* the model's own reasons to doubt itself */
      ['track_record', 'other_models', 'explainer'].forEach(function (k) {
        var c = C.filter(function (y) { return y.key === k; })[0]; if (!c) return;
        if (k === 'track_record' && c.values && isNum(c.values.pct) && c.values.pct < 52.4) out.contradicting.push(c.id);
        if (k === 'other_models' && c.values && isNum(c.values.median_home_line) && Math.abs(c.values.median_home_line - market.home_line) < Math.abs(model.home_line - market.home_line) - 1) out.contradicting.push(c.id);
        if (k === 'explainer' && out.mechanical && out.mechanical.share < 0.35) out.contradicting.push(c.id);
      });
    }

    /* the input audit: is the gap a data problem rather than football? */
    function flag(key, severity, text, ids) { out.input_flags.push({ key: key, severity: severity, text: text, claims: ids || [] }); }
    if (market.status === 'stale') flag('STALE_MARKET', 'info', 'The only line on file was captured ' + (market.captured_at ? dayMonth(ts(market.captured_at)) : 'more than three hours before this build') + ', so the market may have moved.');
    C.filter(function (c) { return c.verification === 'CONFLICTING' && c.topic === 'input'; }).forEach(function (c) { flag('QB_INPUT_CONFLICT', 'high', c.text, [c.id]); });
    var dc = C.filter(function (c) { return c.topic === 'data' && c.verification === 'CONFLICTING'; });
    if (dc.length) flag('DATA_CONFLICT', 'medium', 'EdgeDesk’s own sources disagree on ' + sentenceList(dc.map(function (c) { return c.label.replace(/ \(sources disagree\)$/, '').toLowerCase() + ' (' + c.team + ')'; })) + '; the evidence uses the corroborated figures, and any model term built on the play-by-play figure may be off.', dc.map(function (c) { return c.id; }));
    var inj = ((g.why && g.why.rows) || []).filter(function (r) { return r.key === 'injury' && isNum(r.points) && Math.abs(r.points) >= 2; })[0];
    if (inj) {
      var hurt = inj.favors === home ? away : home, hs = hurt === home ? 'home' : 'away';
      var q = g.qb && g.qb[hs];
      var outQb = C.filter(function (c) { return c.team === hurt && c.topic === 'injury' && c.values && c.values.position === 'QB' && c.status === 'OUT'; })[0];
      var repl = outQb ? C.filter(function (c) { return c.team === hurt && /^(qb_season):/.test(c.key) && c.subject !== outQb.subject; })[0] : null;
      if (outQb) flag('QB_REPLACEMENT_GENERIC', 'medium', 'The availability report lists ' + outQb.subject + ' out, and EdgeDesk’s main model subtracts a generic quarterback absence (' + f1(Math.abs(inj.points)) + ' points) from ' + hurt + ' — it does not price the replacement’s own play' + (repl ? ' (' + repl.short + ')' : '') + '.', [outQb.id].concat(repl ? [repl.id] : []));
      else if (q && (q.contested || q.status === 'COMPETITION')) flag('QB_ABSENCE_APPLIED', 'high', 'EdgeDesk’s main model subtracts a full quarterback absence (' + f1(Math.abs(inj.points)) + ' points) from ' + hurt + ', while its own play-by-play shows ' + poss(hurt) + ' job shared rather than vacant and no official report confirms an absence. The replacement’s measured play is not priced.');
    }
    var cons = g.consensus;
    if (cons && cons.available) {
      var others = (cons.rows || []).filter(function (r) { return r.key !== 'v1' && r.independent && isNum(r.home_margin); });
      if (others.length >= 2) {
        var med = others.map(function (r) { return -r.home_margin; }).sort(function (a, b) { return a - b; })[Math.floor(others.length / 2)];
        var d = Math.abs(med - model.home_line);
        if (d >= 3) flag('CROSS_MODEL_OUTLIER', d >= 6 ? 'high' : 'medium', 'EdgeDesk’s published number sits ' + f1(d) + ' points from the middle of its own other models.');
      }
    }
    var fp = x && x.record && x.record.research && x.record.research.market;
    if (fp && /DATA FAULT/.test(String(fp.classification || ''))) flag('DATA_FAULT', 'high', 'EdgeDesk’s game page already labels this gap a DATA FAULT: ' + String(fp.classification_note || 'a gap larger than any real disagreement explains').replace(/\.\s*$/, '') + '.');
    var hfa = C.filter(function (c) { return c.key === 'hfa'; })[0];
    if (hfa && hfa.values && hfa.values.points >= 3.5 && isNum(hfa.values.market_priced_share) && hfa.values.market_priced_share < 0.8 && T && hfa.team === T) flag('HFA_CONSTANT', 'medium', hfa.text, [hfa.id]);
    var rg = g.edgedesk && g.edgedesk.regime;
    ['home', 'away'].forEach(function (s) { var r = rg && rg[s]; if (r && r.applied) flag('REGIME_CHANGE', 'medium', packet[s] + ': ' + String(r.why || r.reason).replace(/^REGIME CHANGE:\s*/i, ''), []); });
    if (g.games_played && isNum(g.games_played.min) && g.games_played.min <= 4) flag('THIN_SAMPLE', 'medium', 'One team has played only ' + g.games_played.min + ' games; ratings this early carry wide error.');
    out.input_suspect = out.input_flags.some(function (f) { return f.severity === 'high'; });

    /* status */
    if (!out.status) {
      if (gap < MATERIAL_GAP) { out.status = 'NO_MATERIAL_DISAGREEMENT'; }
      else {
        var share2 = out.mechanical ? out.mechanical.share : null;
        var fb = out.football_balance ? out.football_balance.score : 0;
        if (share2 != null && share2 >= 0.7) out.status = 'EXPLAINED';
        else if ((share2 != null && share2 >= 0.35) || fb > 0) out.status = 'PARTIALLY_EXPLAINED';
        else out.status = 'UNEXPLAINED';
        if (gap >= MAJOR_GAP && out.status !== 'EXPLAINED' && fb <= 2) out.status = 'UNEXPLAINED';
      }
    }
    out.actionable = false;
    out.actionable_reason = 'EdgeDesk’s articles are research. A gap is never presented as a bet; ' + (market.status !== 'current' ? 'the only line on file is not a current price; ' : '') + (out.status === 'UNEXPLAINED' ? 'and this gap is unexplained.' : 'any betting decision belongs to EdgeDesk’s decision engine, at a live price.');

    /* the critical matchup: strength against strength, else the biggest mismatch */
    var P = packet.pairs || [];
    var strong = P.filter(function (p) { return p.collision >= 0.15 && p.sample >= 40 && p.key !== 'turnovers'; }).sort(function (a, b) { return b.collision - a.collision; });
    var mism = P.filter(function (p) { return p.favors && p.sample >= 40; }).sort(function (a, b) { return Math.abs(b.edge) - Math.abs(a.edge); });
    var crit = strong[0] || mism[0] || null;
    if (crit) {
      var qbO = qbNameFor(packet, crit.offense);
      var def = PAIRS[crit.key];
      /* NFL teams read as “the Bengals”; possessives follow the name (Ole Miss’, the Bengals’) */
      var nm = function (t) { return packet.league === 'nfl' ? 'the ' + String(t).split(' ').slice(-1)[0] : t; };
      var fill = function (t, qbDefault) { return t.replace(/\{D\}’s/g, poss(nm(crit.defense))).replace(/\{O\}’s/g, poss(nm(crit.offense))).replace(/\{D\}/g, nm(crit.defense)).replace(/\{O\}/g, nm(crit.offense)).replace(/\{QB\}/g, qbO || qbDefault); };
      /* sentence case for the body: the template's own words lower-cased, names kept */
      var sentenceCase = def.q.split(' ').map(function (w, i) { return i === 0 || /\{/.test(w) ? w : w.toLowerCase(); }).join(' ');
      out.critical_matchup = { key: crit.key, offense: crit.offense, defense: crit.defense, claim: crit.claim, why: strong[0] === crit ? 'strength against strength' : 'the biggest mismatch',
        question: fill(def.q, poss(nm(crit.offense)) + ' Quarterback').replace(qbO || '\u0000', qbO ? lastName(qbO) : ''), question_text: fill(sentenceCase, poss(nm(crit.offense)) + ' quarterback'),
        watch: fill(def.watch, poss(nm(crit.offense)) + ' quarterback'), text: byId[crit.claim] ? byId[crit.claim].text : null };
      out.headline_question = out.critical_matchup.question;
    }

    /* the game script each number needs: a full line with the evidence, and
       the same condition as a short unit (the first-party scorecard) */
    if (T) {
      var tOff = mism.filter(function (p) { return p.favors === T; }).slice(0, 2);
      var oOff = mism.filter(function (p) { return p.favors === O; }).slice(0, 2);
      var MC = [], KC = [];
      var push = function (list, line, unit) { if (line && !list.some(function (x) { return x.line === line; })) list.push({ line: line, unit: unit }); };
      if (crit) push(MC, scriptLine(crit, T, byId, 'win'), unitLine(crit, T, 'win'));
      oOff.forEach(function (p) { if (p !== crit) push(MC, scriptLine(p, T, byId, 'neutralize'), unitLine(p, T, 'neutralize')); });
      tOff.forEach(function (p) { if (p !== crit) push(MC, scriptLine(p, T, byId, 'win'), unitLine(p, T, 'win')); });
      var tqb = statusLine(packet, T);
      if (tqb) push(MC, tqb, poss(T) + ' quarterback question breaks its way');
      if (hfa && hfa.team === T) push(MC, 'Home field has to be worth something close to the full ' + f1(hfa.values.points) + ' points EdgeDesk gives it.', 'home field worth close to the full ' + f1(hfa.values.points) + ' points the model gives it');
      oOff.forEach(function (p) { push(KC, scriptLine(p, O, byId, 'win'), unitLine(p, O, 'win')); });
      if (crit) push(KC, scriptLine(crit, O, byId, 'win'), unitLine(crit, O, 'win'));
      var oqb = qbSeasonClaim(packet, O);
      if (oqb) push(KC, lastName(oqb.subject) + ' keeps producing at his season rate (' + oqb.short.replace(/^[^:]+:\s*/, '') + ').', lastName(oqb.subject) + ' plays to his season form');
      MC = MC.slice(0, 4); KC = KC.slice(0, 3);
      out.game_script.model_case = MC.map(function (x) { return x.line; });
      out.game_script.market_case = KC.map(function (x) { return x.line; });
      out.game_script.units = { model: MC.map(function (x) { return x.unit; }), market: KC.map(function (x) { return x.unit; }) };
      out.what_must_happen = out.game_script.model_case.slice();
    }

    /* unresolved uncertainty */
    C.forEach(function (c) {
      if (c.topic === 'qb_status' && c.values && c.values.contested) out.uncertainty.push(c.short + '.');
      if (c.topic === 'injury' && c.material && /QUESTIONABLE|DOUBTFUL/.test(c.status || '')) out.uncertainty.push(c.text);
      if (c.verification === 'CONFLICTING' && c.topic === 'input') out.uncertainty.push(cap(c.short) + '.');
      if (c.key === 'weather' && c.material) out.uncertainty.push('Weather: ' + c.short + '.');
    });
    if (dc.length) out.uncertainty.push('EdgeDesk’s own sources disagree on ' + sentenceList(uniq(dc.map(function (c) { return c.label.replace(/ \(sources disagree\)$/, '').toLowerCase(); }))) + ' for ' + sentenceList(uniq(dc.map(function (c) { return c.team; }))) + '.');
    var miss = (packet.coverage || []).filter(function (c) { return c.status === 'MISSING'; }).map(function (c) { return c.label.toLowerCase(); });
    if (miss.length) out.uncertainty.push('Not in EdgeDesk’s verified data for this game: ' + sentenceList(miss) + '.');
    if (market.status === 'stale') out.uncertainty.push('The line on file was captured ' + (market.captured_at ? dayMonth(ts(market.captured_at)) : 'more than three hours ago') + ' and may have moved.');
    out.uncertainty = uniq(out.uncertainty);

    /* thesis and assessment, in plain words */
    var termsTxt = (out.model_terms || []).filter(function (t) { return t.points >= 1; }).sort(function (a, b) { return b.points - a.points; }).slice(0, 3)
      .map(function (t) { return t.label.toLowerCase() + ' (' + f1(t.points) + ' points toward ' + t.favors + ')'; });
    if (out.gap && out.gap.points >= MATERIAL_GAP) {
      out.thesis = 'EdgeDesk’s model makes it ' + model.text + '; the ' + (market.status === 'current' ? 'current' : 'last captured') + ' line had ' + market.text + '. That is ' + f1(out.gap.points) + ' points closer to ' + T + ' than the market. '
        + (termsTxt.length ? 'The model’s biggest pieces are ' + sentenceList(termsTxt) + '. ' : '')
        + 'Those are the model’s mechanics, not football reasons in themselves.';
    } else if (out.gap) {
      out.thesis = 'EdgeDesk’s model (' + model.text + ') and the ' + (market.status === 'current' ? 'current' : 'last captured') + ' line (' + market.text + ') largely agree; the interest here is the football, not a disagreement.';
    } else out.thesis = 'EdgeDesk’s model makes it ' + model.text + '.';
    var flagsHigh = out.input_flags.filter(function (f) { return f.severity === 'high'; });
    if (out.status === 'UNEXPLAINED') {
      out.assessment = 'UNEXPLAINED. EdgeDesk’s number is ' + f1(out.gap.points) + ' points closer to ' + T + ' than the line, and EdgeDesk cannot account for most of that'
        + (out.mechanical ? ': its own breakdown accounts for about ' + f1(out.mechanical.explained_points) + ' of the ' + f1(out.gap.points) + ' points' : '') + '. '
        + (out.football_balance && out.football_balance.score < 0 ? 'The measured football evidence leans toward ' + O + ', not toward EdgeDesk’s number. ' : '')
        + (flagsHigh.length ? 'There is a specific reason to suspect EdgeDesk’s inputs: ' + flagsHigh[0].text + ' ' : '')
        + 'Treat the gap as an open research question, not as an edge.';
    } else if (out.status === 'PARTIALLY_EXPLAINED') {
      out.assessment = 'PARTIALLY EXPLAINED. Some measured evidence supports EdgeDesk’s lean toward ' + T + (out.mechanical ? ', and its own breakdown accounts for about ' + f1(out.mechanical.explained_points) + ' of the ' + f1(out.gap.points) + ' points' : '') + ', but not the full gap. '
        + (flagsHigh.length ? 'Input warning: ' + flagsHigh[0].text + ' ' : '') + 'It is a research question, not a bet.';
    } else if (out.status === 'EXPLAINED') {
      var main = out.mechanical && out.mechanical.parts && out.mechanical.parts.slice().sort(function (a, b) { return Math.abs(b.points) - Math.abs(a.points); })[0];
      out.assessment = 'EXPLAINED. Most of the ' + f1(out.gap.points) + '-point difference traces to ' + (main ? main.label + ' (about ' + f1(Math.abs(main.points)) + ' points)' : 'identifiable pieces of EdgeDesk’s number')
        + ', which the closing market has historically priced differently. That explains the gap; it does not make either number a bet.';
    } else if (out.status === 'NO_MATERIAL_DISAGREEMENT') {
      out.assessment = 'No material disagreement: EdgeDesk and the line are within ' + f1(out.gap.points) + ' points.';
    }
    return out;
  }
  function qbNameFor(packet, team) {
    var st = packet.claims.filter(function (c) { return c.topic === 'qb_status' && c.team === team; })[0];
    if (st && st.values && !st.values.contested) return st.subject;
    var conf = packet.claims.filter(function (c) { return c.topic === 'injury' && c.team === team && c.values && c.values.position === 'QB' && /PROBABLE|AVAILABLE/.test(c.status || ''); })[0];
    return conf ? conf.subject : (st ? null : null);
  }
  function qbSeasonClaim(packet, team) {
    return packet.claims.filter(function (c) { return c.team === team && /^qb_season:/.test(c.key); })[0] || null;
  }
  function statusLine(packet, team) {
    var cf = packet.claims.filter(function (c) { return c.verification === 'CONFLICTING' && c.topic === 'input' && c.team === team; })[0];
    if (cf) return team + ' needs its quarterback question answered in its favor: ' + cf.short + '.';
    var st = packet.claims.filter(function (c) { return c.topic === 'qb_status' && c.team === team && c.values && c.values.contested; })[0];
    if (st) return poss(team) + ' quarterback situation has to settle: ' + st.short + '.';
    return null;
  }
  var WHERE = { protection: 'in the pass-rush matchup', pass: 'through the air', rush: 'on the ground', early_downs: 'on early downs', third_down: 'on third down',
    red_zone: 'in the red zone', explosive_pass: 'on big pass plays', explosive_rush: 'on long runs', turnovers: 'in the turnover battle', run_blocking: 'at the line of scrimmage', efficiency: 'down to down' };
  /* the same condition as a short unit, no figures (they are in the evidence) */
  function unitLine(p, forTeam, mode) {
    var P = PAIRS[p.key], where = WHERE[p.key] || 'in ' + (P && P.label || p.key), isOff = forTeam === p.offense;
    if (mode === 'neutralize') return isOff ? poss(p.offense) + ' offense holds its own ' + where : poss(p.defense) + ' defense slows ' + p.offense + ' ' + where;
    return isOff ? poss(p.offense) + ' offense wins ' + where : poss(p.defense) + ' defense wins ' + where;
  }
  /* one line of the game script: what `forTeam` must do in pair p.
     mode 'win' (its own strength), 'neutralize' (the other side's strength) */
  function scriptLine(p, forTeam, byId, mode) {
    var c = byId[p.claim]; if (!c) return null;
    var v = c.values || {}, P = PAIRS[p.key], where = WHERE[p.key] || 'in ' + (P && P.label || p.key);
    var isOff = forTeam === p.offense;
    if (!P || !isNum(v.offense) || !isNum(v.defense)) {
      /* rank-based (NFL) pairs */
      return mode === 'neutralize' ? (isOff ? 'The ' + p.offense + ' have to hold their own ' + where + ' (' + c.short + ').' : 'The ' + p.defense + ' have to slow the ' + p.offense + ' ' + where + ' (' + c.short + ').')
        : (isOff ? 'The ' + p.offense + ' have to win ' + where + ' (' + c.short + ').' : 'The ' + p.defense + ' have to win ' + where + ' (' + c.short + ').');
    }
    var offTxt = METRICS[P.off].phrase.replace('{v}', metricText(P.off, v.offense));
    var defTxt = METRICS[P.def].phrase.replace('{v}', metricText(P.def, v.defense));
    if (mode === 'neutralize') {
      return isOff ? poss(p.offense) + ' offense has to hold its own ' + where + ' against a defense that ' + defTxt + '.'
        : poss(p.defense) + ' defense has to slow ' + p.offense + ' ' + where + ' — ' + poss(p.offense) + ' offense ' + offTxt + '.';
    }
    return isOff ? poss(p.offense) + ' offense has to keep winning ' + where + ': it ' + offTxt + ', and ' + poss(p.defense) + ' defense ' + defTxt + '.'
      : poss(p.defense) + ' defense has to come out ahead ' + where + ': it ' + defTxt + ', against an offense that ' + offTxt + '.';
  }

  /* ======================================================================
     BUILD — NFL (the slate, its team ratings and results, the official
     injury report, nflverse team-week stats)
     x: { game (slate game), teams (slate.teams), injuries, teamWeeks
          {CODE: [rows]}, h2h, facts, notes, as_of {...} }
     ====================================================================== */
  var NFL_RANKS = [
    ['off_epa_play', 'offense', 'offense', 'offense', 'efficiency per play'], ['def_epa_play', 'defense', 'defense', 'defense', 'efficiency allowed per play'],
    ['pass_epa_db', 'offense', 'off_rush_pass', 'passing offense', 'passing efficiency'], ['rush_epa_att', 'offense', 'off_rush_pass', 'running game', 'rushing efficiency'],
    ['def_pass_epa_db', 'defense', 'def_rush_pass', 'pass defense', 'pass defense'], ['def_rush_epa_att', 'defense', 'def_rush_pass', 'run defense', 'run defense'],
    ['sack_rate_all', 'line', 'off_line', 'pass protection', 'sack rate allowed'], ['sack_rate_made', 'pressure', 'def_pressure', 'pass rush', 'sack rate'],
    ['expl_pass', 'offense', 'off_explosive', 'explosive passing', 'explosive pass rate'], ['def_expl_pass', 'defense', 'def_explosive', 'explosive passes allowed', 'explosive passes allowed'],
    ['pts_for', 'offense', 'off_points', 'scoring offense', 'points scored'], ['pts_against', 'defense', 'def_points', 'scoring defense', 'points allowed']
  ];
  function buildNfl(x, opts) {
    opts = opts || {};
    var g = x.game || {}, now = isNum(opts.now) ? opts.now : Date.now();
    var A = x.as_of || {};
    var home = g.home_team, away = g.away_team, teams = { home: home, away: away }, codes = { home: g.home_code, away: g.away_code };
    var claims = [], cov = {};
    function add(c) { if (c && claims.every(function (y) { return y.id !== c.id; })) claims.push(c); return c; }
    function covered(item, c) { (cov[item] = cov[item] || []).push(c.id); }
    var TT = x.teams || {};
    var srcSlate = { id: 'nfl_slate', label: 'EdgeDesk NFL team ratings (2026)', path: 'football/nfl/slate.json' };
    /* unit ranks */
    ['home', 'away'].forEach(function (side) {
      var t = TT[codes[side]]; if (!t || !t.ranks) return;
      NFL_RANKS.forEach(function (r) {
        var rk = t.ranks[r[0]]; if (!rk || !isNum(rk.rank)) return;
        var good = rk.rank <= 8, bad = rk.rank >= 25;
        var c = add(claim({
          topic: r[1], key: 'rank:' + r[0], team: teams[side], side: side, label: cap(r[4]),
          text: poss(teams[side]) + ' ' + r[3] + ' ranks No. ' + rk.rank + ' of ' + (rk.of || 32) + ' in ' + r[4] + ' this season.',
          short: poss(teams[side]) + ' ' + r[3] + ' (No. ' + rk.rank + ')',
          cite: { nums: [String(rk.rank)], words: [r[3].split(' ')[0], r[4].split(' ')[0]] },
          values: { rank: rk.rank, of: rk.of || 32 },
          source: srcSlate, observed_at: A.slate, verification: 'VERIFIED_DATA',
          leans: good ? teams[side] : (bad ? teams[side === 'home' ? 'away' : 'home'] : null),
          strength: rk.rank <= 4 || rk.rank >= 29 ? 'moderate' : (good || bad ? 'small' : null)
        }));
        covered(r[2], c);
      });
    });
    /* matchups from ranks: offense unit vs the other defense */
    var NPAIRS = [['pass_epa_db', 'def_pass_epa_db', 'pass', 'the passing game against the pass defense'], ['rush_epa_att', 'def_rush_epa_att', 'rush', 'the run game against the run defense'], ['sack_rate_all', 'sack_rate_made', 'protection', 'pass protection against the pass rush']];
    var pairs = [];
    ['home', 'away'].forEach(function (oside) {
      var dside = oside === 'home' ? 'away' : 'home', to = TT[codes[oside]], td = TT[codes[dside]];
      if (!to || !td || !to.ranks || !td.ranks) return;
      NPAIRS.forEach(function (np) {
        var a = to.ranks[np[0]], b = td.ranks[np[1]]; if (!a || !b || !isNum(a.rank) || !isNum(b.rank)) return;
        var go = (16.5 - a.rank) / 16, gd = (16.5 - b.rank) / 16, edge = go - gd;
        var O = teams[oside], D = teams[dside];
        var favors = Math.abs(edge) >= 0.5 ? (edge > 0 ? O : D) : null;
        var c = add(claim({ topic: 'matchup', key: 'pair:' + np[2] + ':' + oside, team: O, side: oside, label: cap(np[3]),
          text: 'When ' + O + ' have the ball: their ' + np[3].replace(/^the /, '').split(' against ')[0] + ' ranks No. ' + a.rank + ', and ' + poss(D) + ' ' + np[3].split(' against the ')[1] + ' ranks No. ' + b.rank + '.',
          short: poss(O) + ' No. ' + a.rank + ' ' + np[3].split(' against ')[0].replace(/^the /, '') + ' against ' + poss(D) + ' No. ' + b.rank + ' ' + np[3].split(' against the ')[1],
          cite: { nums: [String(a.rank), String(b.rank)], words: np[2] === 'protection' ? ['protection', 'pass rush', 'sack'] : (np[2] === 'pass' ? ['pass'] : ['run', 'rush']) },
          values: { offense_rank: a.rank, defense_rank: b.rank, edge: r2(edge) }, source: srcSlate, observed_at: A.slate, verification: 'VERIFIED_DATA',
          leans: favors, strength: favors ? (Math.abs(edge) >= 1 ? 'large' : Math.abs(edge) >= 0.75 ? 'moderate' : 'small') : null }));
        pairs.push({ key: np[2], offense: O, defense: D, edge: r2(edge), collision: r2(Math.min(go, gd)), favors: favors, claim: c.id, sample: 100 });
      });
    });
    /* team passing from nflverse team-week stats (completion %, YPA, TD, INT, sacks) and penalties */
    ['home', 'away'].forEach(function (side) {
      var rows = (x.teamWeeks && x.teamWeeks[codes[side]]) || [];
      if (!rows.length) return;
      var s = function (k) { return rows.reduce(function (a, r) { return a + (+r[k] || 0); }, 0); };
      var att = s('attempts'), cmp = s('completions'), yds = s('passing_yards'), td = s('passing_tds'), ints = s('passing_interceptions'), sk = s('sacks_suffered'), pen = s('penalties'), peny = s('penalty_yards');
      if (att) {
        var qb = g[side + '_starter'] && g[side + '_starter'].player_name;
        var c = add(claim({ topic: 'qb', key: 'team_passing:' + side, team: teams[side], side: side, subject: qb || null, label: teams[side] + ' passing (2026)',
          text: poss(teams[side]) + ' passers have completed ' + cmp + ' of ' + att + ' (' + pct1(cmp / att) + ') for ' + thousands(yds) + ' yards, ' + f1(yds / att) + ' yards per attempt, with ' + td + ' touchdowns, ' + ints + ' interceptions and ' + sk + ' sacks taken in ' + numWord(rows.length) + ' games.',
          short: poss(teams[side]) + ' passing: ' + pct1(cmp / att) + ' completions, ' + f1(yds / att) + ' yards per attempt, ' + td + ' TD, ' + ints + ' INT',
          cite: { nums: [f1(yds / att)], words: ['per attempt', 'yards per'] }, values: { attempts: att, completions: cmp, yards: yds, tds: td, ints: ints, sacks: sk, games: rows.length },
          source: { id: 'nflverse_team_week', label: 'nflverse team-week stats (2026)', path: 'football/nfl/stats_team_week_2026.csv' }, observed_at: A.team_weeks, verification: 'VERIFIED_DATA' }));
        ['qb_efficiency', 'qb_completion', 'qb_ypa', 'qb_td_int', 'qb_sacks'].forEach(function (k) { covered(k, c); });
      }
      if (rows.length && isNum(pen)) {
        var pc = add(claim({ topic: 'discipline', key: 'penalties:' + side, team: teams[side], side: side, label: teams[side] + ' penalties',
          text: teams[side] + ' have been flagged ' + pen + ' times for ' + peny + ' yards in ' + numWord(rows.length) + ' games (' + f1(pen / rows.length) + ' per game).',
          short: f1(pen / rows.length) + ' penalties per game for ' + teams[side],
          cite: { nums: [f1(pen / rows.length)], words: ['penalt', 'flag'] }, values: { penalties: pen, yards: peny, per_game: r1(pen / rows.length) },
          source: { id: 'nflverse_team_week', label: 'nflverse team-week stats (2026)', path: 'football/nfl/stats_team_week_2026.csv' }, observed_at: A.team_weeks, verification: 'VERIFIED_DATA' }));
        covered('penalties', pc);
      }
      /* last two QB-by-game lines for the trend */
      if (rows.length >= 3) {
        var sorted = rows.slice().sort(function (a, b) { return (+a.week) - (+b.week); });
        var last = sorted.slice(-2), early = sorted.slice(0, -2);
        var ly = last.reduce(function (a, r) { return a + (+r.passing_yards || 0); }, 0) / Math.max(1, last.reduce(function (a, r) { return a + (+r.attempts || 0); }, 0));
        var ey = early.reduce(function (a, r) { return a + (+r.passing_yards || 0); }, 0) / Math.max(1, early.reduce(function (a, r) { return a + (+r.attempts || 0); }, 0));
        var tc = add(claim({ topic: 'qb', key: 'team_passing_trend:' + side, team: teams[side], side: side, label: teams[side] + ' passing trend',
          text: 'Over their last two games, ' + poss(teams[side]) + ' passers averaged ' + f1(ly) + ' yards per attempt, against ' + f1(ey) + ' before that.',
          short: poss(teams[side]) + ' passing ' + f1(ly) + ' yards per attempt over the last two games (' + f1(ey) + ' before)',
          cite: { nums: [f1(ly)], words: ['last two', 'per attempt'] }, values: { last_two_ypa: r1(ly), before_ypa: r1(ey) },
          source: { id: 'nflverse_team_week', label: 'nflverse team-week stats (2026)', path: 'football/nfl/stats_team_week_2026.csv' }, observed_at: A.team_weeks, verification: 'VERIFIED_DATA',
          leans: Math.abs(ly - ey) >= 1 ? (ly > ey ? teams[side] : teams[side === 'home' ? 'away' : 'home']) : null, strength: Math.abs(ly - ey) >= 1 ? 'small' : null }));
        covered('qb_trend', tc);
      }
    });
    /* results */
    ['home', 'away'].forEach(function (side) {
      var t = TT[codes[side]]; var res = (t && t.results) || [];
      if (!res.length) return;
      var w = res.filter(function (r) { return r.result === 'W'; }).length, l = res.filter(function (r) { return r.result === 'L'; }).length, tie = res.length - w - l;
      var ppg = res.reduce(function (a, r) { return a + r.points_for; }, 0) / res.length, papg = res.reduce(function (a, r) { return a + r.points_against; }, 0) / res.length;
      var rc = add(claim({ topic: 'results', key: 'record:' + side, team: teams[side], side: side, label: teams[side] + ' record',
        text: 'The ' + teams[side] + ' are ' + w + '–' + l + (tie ? '–' + tie : '') + ', scoring ' + f1(ppg) + ' points per game and allowing ' + f1(papg) + '.',
        short: teams[side] + ' (' + w + '–' + l + (tie ? '–' + tie : '') + ')', cite: { nums: [String(w), String(l)], words: [teams[side].split(' ').slice(-1)[0]] },
        values: { wins: w, losses: l, ties: tie, ppg: r1(ppg), papg: r1(papg) }, source: srcSlate, observed_at: A.slate, verification: 'VERIFIED_DATA' }));
      covered('recent_results', rc); covered('off_points', rc); covered('def_points', rc);
      res.slice(-2).forEach(function (r) {
        var won = r.result === 'W';
        var cc = add(claim({ topic: 'results', key: 'result:' + r.game_id + ':' + side, team: teams[side], side: side, label: teams[side] + ' vs ' + r.opponent,
          text: 'The ' + teams[side] + ' ' + (won ? 'beat the ' + r.opponent + ' ' : (r.result === 'L' ? 'lost ' : 'tied ')) + score(r.points_for, r.points_against) + (won ? '' : (r.result === 'L' ? (r.venue === 'away' ? ' at ' : ' to ') + 'the ' + r.opponent : ' with the ' + r.opponent)) + ' in Week ' + r.week + '.',
          short: (won ? 'beat the ' + r.opponent + ' ' : 'lost ' ) + score(r.points_for, r.points_against) + (won ? '' : (r.venue === 'away' ? ' at ' : ' to ') + 'the ' + r.opponent),
          cite: { nums: [String(Math.max(r.points_for, r.points_against)), String(Math.min(r.points_for, r.points_against))], words: [String(r.opponent).split(' ').slice(-1)[0]] },
          values: r, source: srcSlate, observed_at: A.slate, verification: 'VERIFIED_DATA' }));
        covered('recent_results', cc);
      });
    });
    /* quarterbacks and the official injury report */
    var inj = x.injuries || {};
    ['home', 'away'].forEach(function (side) {
      var st = g[side + '_starter'], code = codes[side], team = teams[side];
      var tr = inj.teams && inj.teams[code];
      var players = tr && tr.week === g.week ? (tr.players || []) : [];
      if (st && st.player_name) {
        var rep = players.filter(function (p) { return p.name === st.player_name && p.status; })[0];
        var sc = add(claim({ topic: 'qb_status', key: 'qb_model:' + side, team: team, side: side, subject: st.player_name, label: team + ' quarterback',
          text: st.player_name + ' is ' + poss(team) + ' listed starter in the schedule feed' + (rep ? '; the official injury report lists him as ' + String(rep.status).toLowerCase() + (rep.injury ? ' (' + String(rep.injury).toLowerCase() + ')' : '') : '') + '.',
          short: st.player_name + (rep ? ' (' + String(rep.status).toLowerCase() + ')' : ' (listed starter)'), cite: { nums: [], words: [lastName(st.player_name), 'start|report|lists|listed' + (rep ? '|' + String(rep.status).toLowerCase() : '')], all: true },
          values: { player: st.player_name, status: rep ? rep.status : 'LISTED', contested: false }, source: { id: 'nfl_slate', label: 'nflverse schedule feed and official injury report', path: 'football/nfl/slate.json' }, observed_at: A.slate,
          verification: rep ? 'OFFICIAL_REPORT' : 'VERIFIED_DATA', status: rep ? String(rep.status).toUpperCase() : 'PREVIOUS_GAME', material: !!rep }));
        covered('qb_availability', sc);
        var regime = g.regime && g.regime[side];
        if (regime && regime.qb_out) add(claim({ topic: 'input', key: 'qb_regime:' + side, team: team, side: side, label: team + ': quarterback change', text: poss(team) + ' regular starter ' + (regime.regular_starter || '') + ' is not the listed starter this week.', short: poss(team) + ' regular starter is out', cite: { nums: [], words: [lastName(regime.regular_starter || team), 'start|out'], all: true }, source: srcSlate, observed_at: A.slate, verification: 'VERIFIED_DATA', material: true }));
      }
      var outs = players.filter(function (p) { return p.status === 'Out' || p.status === 'Doubtful'; });
      var key = outs.filter(function (p) { return /^(QB|T|G|C|WR|TE|RB|CB|S|DE|DT|LB|EDGE|OLB)$/.test(p.position); }).slice(0, 4);
      if (outs.length) {
        var ic = add(claim({ topic: 'injury', key: 'report_out:' + side, team: team, side: side, label: team + ' injuries',
          text: 'The official injury report lists ' + numWord(outs.length) + ' ' + team + ' player' + (outs.length === 1 ? '' : 's') + ' as out or doubtful' + (key.length ? ', including ' + sentenceList(key.map(function (p) { return p.position + ' ' + p.name + ' (' + p.status.toLowerCase() + ')'; })) : '') + '.',
          short: numWord(outs.length) + ' ' + team + ' players out or doubtful', cite: { nums: [], words: [team.split(' ').slice(-1)[0], 'out|doubtful'], all: true },
          values: { players: outs.map(function (p) { return { name: p.name, position: p.position, status: p.status, injury: p.injury }; }) },
          source: { id: 'nfl_injuries', label: 'Official NFL injury report (nflverse)', path: 'football/injuries/nfl_2026.json' }, observed_at: inj.retrieved_at || A.injuries, verification: 'OFFICIAL_REPORT', material: key.length > 0 }));
        covered('injuries', ic);
      }
    });
    /* rest, weather, head-to-head */
    if (isNum(g.home_rest) && isNum(g.away_rest)) {
      var more = g.home_rest > g.away_rest ? home : (g.away_rest > g.home_rest ? away : null);
      var rc2 = add(claim({ topic: 'situational', key: 'rest', team: more, label: 'Rest', text: more ? 'The ' + more + ' come in on ' + Math.max(g.home_rest, g.away_rest) + ' days of rest; the ' + (more === home ? away : home) + ' have had ' + Math.min(g.home_rest, g.away_rest) + '.' : 'Both teams are on ' + g.home_rest + ' days of rest.',
        short: more ? more + ' ' + Math.max(g.home_rest, g.away_rest) + ' days of rest to ' + Math.min(g.home_rest, g.away_rest) : 'equal rest', cite: { nums: [String(Math.max(g.home_rest, g.away_rest))], words: ['rest', 'days'] },
        values: { home_days: g.home_rest, away_days: g.away_rest }, source: srcSlate, observed_at: A.slate, verification: 'VERIFIED_DATA', leans: more && Math.abs(g.home_rest - g.away_rest) >= 3 ? more : null, strength: more && Math.abs(g.home_rest - g.away_rest) >= 3 ? 'small' : null }));
      covered('rest_travel', rc2);
    }
    var fc = g.forecast;
    if (fc && isNum(fc.temp_f) && !fc.dome) {
      var wc = add(claim({ topic: 'situational', key: 'weather', label: 'Forecast', text: 'The kickoff forecast calls for ' + Math.round(fc.temp_f) + ' degrees' + (isNum(fc.wind_mph) ? ' with wind around ' + Math.round(fc.wind_mph) + ' mph' : '') + (fc.text ? ' (' + String(fc.text).toLowerCase() + ')' : '') + '.',
        short: Math.round(fc.temp_f) + ' degrees', cite: { nums: [String(Math.round(fc.temp_f))], words: ['forecast', 'degrees', 'wind'] }, values: fc, source: { id: 'forecast', label: 'Kickoff forecast', path: 'football/nfl/slate.json' }, observed_at: fc.as_of || A.slate,
        verification: 'VERIFIED_DATA', material: (isNum(fc.wind_mph) && fc.wind_mph >= 15), caveat: 'a forecast, not an observation' }));
      covered('weather', wc);
    } else if (g.roof === 'dome' || g.roof === 'closed') covered('weather', add(claim({ topic: 'situational', key: 'weather', label: 'Indoors', text: 'The game is played indoors.', short: 'indoors', cite: { nums: [], words: ['indoors', 'dome', 'roof'] }, source: srcSlate, observed_at: A.slate, verification: 'VERIFIED_DATA' })));
    var h2h = (x.h2h || []).filter(function (r) { return isNum(r.home_points) && isNum(r.away_points); }).sort(function (a, b) { return (a.season - b.season) || ((ts(a.kickoff) || 0) - (ts(b.kickoff) || 0)); });
    if (h2h.length) {
      var lm = h2h[h2h.length - 1];
      var lw = lm.home_points > lm.away_points ? lm.home : lm.away;
      covered('head_to_head', add(claim({ topic: 'history', key: 'h2h', label: 'Head-to-head', text: 'The last meeting, in ' + lm.season + ', went to the ' + lw + ', ' + score(lm.home_points, lm.away_points) + '.', short: 'the ' + lw + ' won the last meeting in ' + lm.season,
        cite: { nums: [String(lm.season)], words: ['meeting', 'met'] }, values: lm, scope: 'historical', source: { id: 'lines_archive', label: 'EdgeDesk NFL results-and-lines archive', path: 'football/pricing/lines_nfl.json' }, observed_at: A.lines, verification: 'VERIFIED_DATA' })));
    }
    if (g.div_game) covered('conference', add(claim({ topic: 'conference', key: 'division', label: 'Division game', text: 'It is a division game.', short: 'a division game', cite: { nums: [], words: ['division'] }, source: srcSlate, observed_at: A.slate, verification: 'VERIFIED_DATA' })));
    (x.facts || []).forEach(function (f) {
      var exp = ts(f.expires_at); if (exp != null && exp <= now) return;
      var c = add(claim({ topic: f.kind === 'availability' ? 'injury' : (f.topic || 'report'), key: 'fact:' + f.id, team: f.team || null, subject: f.subject || null, label: f.label || f.subject || 'Report', text: f.text, short: f.short || f.text,
        cite: f.cite || { nums: [], words: [f.subject ? lastName(f.subject) : (f.team || '')] }, values: f.values || null, scope: f.scope || 'report',
        source: { id: 'facts', label: f.source && f.source.publisher, publisher: f.source && f.source.publisher, url: f.source && f.source.url, published_at: f.source && f.source.published_at },
        observed_at: f.source && f.source.published_at || f.recorded_at, verification: f.verification === 'VERIFIED' ? 'VERIFIED_REPORT' : 'REPORTED', material: !!f.material, status: f.status_designation || null,
        caveat: f.verification === 'VERIFIED' ? null : 'not yet confirmed at the source by an EdgeDesk editor' }));
      if (f.covers) [].concat(f.covers).forEach(function (it) { covered(it, c); });
    });

    /* model and market */
    var model = { available: g.model_status === 'PREDICTED' && isNum(g.model_home_line) };
    if (model.available) {
      var hl = r1(g.model_home_line), fav = hl < -0.05 ? home : (hl > 0.05 ? away : null);
      model = { available: true, home_line: hl, favorite: fav, margin: r1(Math.abs(hl)), text: fav ? 'the ' + fav + ' by ' + f1(Math.abs(hl)) : 'a pick’em', home_win_prob: isNum(g.model_home_win_prob) ? r2(g.model_home_win_prob) : null, total: isNum(g.model_fair_total) ? r1(g.model_fair_total) : null, version: g.model_version || null };
    }
    var q = x.quote;
    var market = { status: 'none', comparable: false };
    if (q && isNum(q.home_line)) {
      var age = q.captured_at ? Math.round((now - ts(q.captured_at)) / 60000) : null;
      var mhl = r1(q.home_line), mf = mhl < -0.05 ? home : (mhl > 0.05 ? away : null);
      market = { status: age != null && age <= STALE_MINUTES ? 'current' : 'stale', home_line: mhl, favorite: mf, margin: r1(Math.abs(mhl)), text: mf ? 'the ' + mf + ' -' + (Math.abs(mhl) % 1 === 0 ? String(Math.abs(mhl)) : Math.abs(mhl).toFixed(1)) : 'pick’em', book: q.book || null, captured_at: q.captured_at || null, comparable: true, reason: 'a captured sportsbook spread' };
    } else if (g.reference_market && isNum(g.reference_market.home_line)) {
      var rhl = r1(g.reference_market.home_line), rf = rhl < -0.05 ? home : (rhl > 0.05 ? away : null);
      market = { status: 'reference', home_line: rhl, favorite: rf, margin: r1(Math.abs(rhl)), text: rf ? 'the ' + rf + ' -' + (Math.abs(rhl) % 1 === 0 ? String(Math.abs(rhl)) : Math.abs(rhl).toFixed(1)) : 'pick’em', book: null, captured_at: null, comparable: true, reason: 'a consensus reference line with no sportsbook and no capture time: comparable for research, never a price' };
    }
    if (model.available) add(claim({ topic: 'model', key: 'projection', label: 'EdgeDesk projection', text: 'EdgeDesk’s model makes it ' + model.text + '.', short: 'EdgeDesk ' + model.text, cite: { nums: [f1(model.margin)], words: ['EdgeDesk', 'model'] }, values: model, source: srcSlate, observed_at: A.slate, verification: 'MODEL_OUTPUT' }));
    if (market.status !== 'none') add(claim({ topic: 'market', key: 'market', label: market.status === 'reference' ? 'Reference line' : 'Captured line', text: (market.status === 'reference' ? 'The consensus reference line (no sportsbook, no capture time)' : 'The last captured line') + ' had ' + market.text + '.', short: market.text, cite: { nums: [String(market.margin)], words: ['line'] }, values: market, scope: 'market', source: { id: 'market', label: market.status === 'reference' ? 'nflverse consensus (reference)' : (market.book || 'captured line') }, observed_at: market.captured_at || A.slate, verification: 'MARKET_DATA' }));
    ((g.contributions && g.contributions.spread) || []).filter(function (r) { return r.key !== 'baseline' && isNum(r.points) && Math.abs(r.points) >= 0.5; }).forEach(function (r) {
      var fav3 = r.points > 0 ? home : away; /* contributions are in home-margin points */
      var lab = termLabel(r);
      add(claim({ topic: 'model', key: 'term:' + r.key, team: fav3, label: 'Model term: ' + lab, text: 'In EdgeDesk’s model, ' + lab + ' is worth ' + f1(Math.abs(r.points)) + ' points toward the ' + fav3 + '.', short: lab + ' (' + f1(Math.abs(r.points)) + ' points toward the ' + fav3 + ')', cite: { nums: [f1(Math.abs(r.points))], words: [lab.split(' ')[0]] }, values: r, source: srcSlate, observed_at: A.slate, verification: 'MODEL_OUTPUT' }));
    });
    var packet = {
      schema: SCHEMA, version: VERSION, league: 'nfl', game_id: String(g.game_id), season: g.season, week: g.week, key: 'nfl:' + g.season + ':' + g.game_id,
      home: home, away: away, kickoff: g.kickoff, venue: g.venue || null, neutral_site: false, built_at: iso(now), observed: A,
      model: model, market: market, claims: claims, coverage: coverageOf(cov, 'nfl', x), pairs: pairs
    };
    /* a minimal terminal-shaped record so explain() reads the NFL game the same way */
    var gshape = { game: { home: home, away: away }, why: { rows: ((g.contributions && g.contributions.spread) || []).filter(function (r) { return r.key !== 'baseline' && isNum(r.points); }).map(function (r) { return { key: r.key, label: r.key, points: -r.points, favors: r.points > 0 ? home : away }; }) }, games_played: null };
    packet.explanation = explain(packet, gshape, x);
    finalize(packet);
    packet.inputs_hash = hash(JSON.stringify([g.fingerprint || g.game_id, A, (x.facts || []).map(function (f) { return f.id; })]));
    packet.hash = hash(JSON.stringify(packet.claims) + JSON.stringify(packet.explanation));
    return packet;
  }

  /* The stored packet: single-team stats are folded into the matchup claims
     that carry the same numbers, sources are listed once, empty fields go. */
  function finalize(packet) {
    var keep = {}, srcs = {}, idx = {}, n = 0;
    packet.claims = packet.claims.filter(function (c) { return !c.component; }).map(function (c) {
      var out = {};
      Object.keys(c).forEach(function (k) {
        var v = c[k];
        if (v == null || v === false || (k === 'short' && v === c.text) || (k === 'scope' && v === 'current_season') || k === 'source' || k === 'observed_at') return;
        out[k] = v;
      });
      if (c.source) {
        var sk = JSON.stringify([c.source, c.observed_at || null]);
        if (!idx[sk]) { idx[sk] = 's' + (n++); srcs[idx[sk]] = Object.assign({}, c.source, { observed_at: c.observed_at || null }); }
        out.src = idx[sk];
      }
      if (!out.cite.any) delete out.cite.any;
      if (!out.cite.all) delete out.cite.all;
      keep[c.id] = 1;
      return out;
    });
    packet.sources = srcs;
    (packet.coverage || []).forEach(function (cv) { cv.claims = cv.claims.filter(function (id) { return keep[id]; }); });
    var X = packet.explanation || {};
    ['supporting', 'contradicting'].forEach(function (k) { if (X[k]) X[k] = X[k].filter(function (id) { return keep[id]; }); });
    return packet;
  }
  /* A smaller packet for a multi-game article: the explanation's own
     evidence, every quarterback / availability / results / situational /
     model claim, and the strongest matchups and position groups. */
  var ALWAYS = { qb: 1, qb_status: 1, injury: 1, input: 1, results: 1, situational: 1, model: 1, market: 1, history: 1, conference: 1, personnel: 1, schedule: 1, discipline: 1 };
  function trim(packet, opts) {
    if (!packet || !packet.claims) return packet;
    opts = opts || {};
    var X = packet.explanation || {};
    var want = {};
    (X.supporting || []).slice(0, opts.per || 6).concat((X.contradicting || []).slice(0, opts.per || 6)).forEach(function (id) { want[id] = 1; });
    if (X.critical_matchup) want[X.critical_matchup.claim] = 1;
    (packet.pairs || []).slice().sort(function (a, b) { return Math.abs(b.edge) - Math.abs(a.edge); }).slice(0, opts.pairs || 6).forEach(function (p) { want[p.claim] = 1; });
    var claims = packet.claims.filter(function (c) { return want[c.id] || ALWAYS[c.topic] || (c.topic === 'position' && c.strength); });
    var used = {}; claims.forEach(function (c) { if (c.src) used[c.src] = 1; });
    var srcs = {}; Object.keys(packet.sources || {}).forEach(function (k) { if (used[k]) srcs[k] = packet.sources[k]; });
    var keep = {}; claims.forEach(function (c) { keep[c.id] = 1; });
    var X2 = Object.assign({}, X, { supporting: (X.supporting || []).filter(function (id) { return keep[id]; }), contradicting: (X.contradicting || []).filter(function (id) { return keep[id]; }) });
    return Object.assign({}, packet, { claims: claims, sources: srcs, explanation: X2, pairs: (packet.pairs || []).filter(function (p) { return keep[p.claim]; }), trimmed: true });
  }
  /* ======================================================================
     FIRST-PARTY — the summary an EdgeDesk game page renders, and the
     preflight that holds a page whose evidence an editor must still confirm
     ====================================================================== */
  function articleSummary(packet) {
    if (!packet || !packet.explanation) return null;
    var X = packet.explanation, by = byIdOf(packet);
    var qbs = packet.claims.filter(function (c) { return /^(qb_season|team_passing):/.test(c.key) || (c.topic === 'injury' && c.values && c.values.position === 'QB') || (c.topic === 'input' && c.verification === 'CONFLICTING'); });
    var avail = materialInjuries(packet).filter(function (c) { return c.topic === 'injury' && !(c.values && c.values.position === 'QB'); });
    var football = function (ids) { return (ids || []).map(function (id) { return by[id]; }).filter(function (c) { return c && c.football; }).slice(0, 4); };
    var sup = football(X.supporting), con = football(X.contradicting);
    var used = sup.concat(con, qbs, avail);
    var srcs = {};
    used.forEach(function (c) {
      var so = sourceOf(packet, c); if (!so) return;
      var k = (so.url || so.path || so.label) + '|' + c.verification;
      if (!srcs[k]) srcs[k] = { label: so.publisher || so.label, url: so.url || null, path: so.path || null, observed_at: so.observed_at || so.published_at || null, verification: c.verification };
    });
    return {
      schema: 'edgedesk_article_evidence_v1', packet_hash: packet.hash, status: X.status || null, input_suspect: !!X.input_suspect,
      question: X.critical_matchup && X.critical_matchup.question_text || null,
      assessment: String(X.assessment || '').replace(/^[A-Z_ ]+\.\s*/, ''),
      gap: X.gap ? { points: X.gap.points, toward: X.gap.toward, other: X.gap.other } : null,
      supporting: sup.map(function (c) { return c.text; }), contradicting: con.map(function (c) { return c.text; }),
      quarterbacks: qbs.map(function (c) { return c.text; }), availability: avail.map(function (c) { return c.text; }),
      script: { model: (X.game_script && X.game_script.model_case) || [], market: (X.game_script && X.game_script.market_case) || [] },
      unknown: (X.uncertainty || []).slice(0, 6),
      flags: (X.input_flags || []).filter(function (f) { return f.severity !== 'info'; }).map(function (f) { return { key: f.key, severity: f.severity, text: f.text }; }),
      sources: Object.keys(srcs).map(function (k) { return srcs[k]; }),
      needs_confirmation: used.filter(function (c) { return c.needs_confirmation; }).map(function (c) { return c.short || c.text; })
    };
  }
  /* blocking conditions for an EdgeDesk page that would publish on its own */
  function firstPartyGate(rec) {
    var fe = rec && rec.football_evidence, blocking = [];
    if (!fe) blocking.push({ id: 'football_evidence', why: 'a pregame page is published only with a football evidence packet behind it (tools/content/evidence.js); there is none for this game yet', detail: null });
    else {
      if (fe.input_suspect) blocking.push({ id: 'evidence_inputs_suspect', why: 'EdgeDesk’s own inputs for this game are suspect, so a person reviews the page before it goes out', detail: (fe.flags || []).filter(function (f) { return f.severity === 'high'; }).map(function (f) { return f.key; }).join(', ') || null });
      if ((fe.needs_confirmation || []).length) blocking.push({ id: 'evidence_unconfirmed', why: 'the page cites outside reporting an editor has not yet confirmed at the source (tools/content/add_fact.js --verify)', detail: fe.needs_confirmation.slice(0, 4).join(' · ') });
    }
    return { ok: !blocking.length, blocking: blocking };
  }
  function sourceOf(packet, c) { return c && c.src && packet && packet.sources ? packet.sources[c.src] || null : (c && c.source) || null; }
  function vOf(c) { return c.verification; }

  /* ======================================================================
     WRITER HELPERS — what an article may say, chosen from the packet
     ====================================================================== */
  function byIdOf(packet) { var m = {}; (packet && packet.claims || []).forEach(function (c) { m[c.id] = c; }); return m; }
  function pick(packet, ids, n, filter) {
    var b = byIdOf(packet);
    return (ids || []).map(function (id) { return b[id]; }).filter(function (c) { return c && (!filter || filter(c)); }).slice(0, n);
  }
  function qbSummary(packet, side) {
    var team = packet[side];
    var season = packet.claims.filter(function (c) { return c.team === team && /^(qb_season|team_passing):/.test(c.key); });
    var status = packet.claims.filter(function (c) { return c.team === team && (c.topic === 'qb_status' || (c.topic === 'injury' && c.values && c.values.position === 'QB')); });
    var conflict = packet.claims.filter(function (c) { return c.team === team && c.verification === 'CONFLICTING'; });
    var trend = packet.claims.filter(function (c) { return c.team === team && /^qb_trend:/.test(c.key); });
    return { season: season, status: status, conflict: conflict, trend: trend };
  }
  function materialInjuries(packet) {
    return packet.claims.filter(function (c) { return (c.topic === 'injury' && c.material) || (c.verification === 'CONFLICTING' && c.topic === 'input'); });
  }

  /* ======================================================================
     GATE — the editorial checks an article must pass
     ====================================================================== */
  var EDGE_RE = /\b(betting edge|an edge (?:on|against|over) the (?:market|line|books?|close)|(?:there(?:’|')s|there is|has) value (?:on|in|with)|value (?:side|bet|play|pick)|mispric\w*|overvalued|undervalued|sharp (?:side|play|money|bet)|the (?:market|books?|line|oddsmakers?) (?:is|are|has it|have it|got it) wrong|market (?:is )?(?:missing|asleep|overreacting)|market inefficien\w*|beat the (?:line|market|close|closing line)|fade (?:the|this)|(?:the|an|this) edge is (?:intact|real)|exploitable)\b/i;
  var CAUSAL_RE = /\b(because|due to|driven by|thanks to|the reason|which is why|that(?:’|')s why|is why|explains?|explained by|stems? from|comes? from|caused by|owing to|reflects?)\b/i;
  var MODEL_SUBJ_RE = /\b(EdgeDesk|the model|model(?:’|')s|projection|our number|EdgeDesk(?:’|')s number)\b/i;
  var GAP_RE = /\b(gap|difference|disagree\w*|apart|closer to|further from|than the (?:line|market))\b/i;
  /* an unexplained or suspect gap must be disclosed twice over: that EdgeDesk
     cannot explain it, AND that it is not an edge (either alone sells it) */
  var UNEXPLAINED_RE = /\b(unexplained|can(?:no|’|')t (?:fully )?(?:explain|account)|cannot (?:fully )?(?:explain|account)|doesn(?:’|')t (?:fully )?(?:explain|account)|does not (?:fully )?(?:explain|account)|no (?:measured )?explanation|accounts? for (?:only |about |roughly |just |most )?[^.]{0,30}?of (?:the|these|those|that|this)|open (?:research )?question|data (?:problem|fault|issue)|input (?:problem|error|may be)|part does not|not all of it|only part)\b/i;
  var NOT_EDGE_RE = /\b(not (?:a|an) (?:betting )?edge|not an? (?:bet|wager|pick)|not (?:for )?a wager|not to bet|not as an edge)\b/i;
  var DISCLOSE_RE = { unexplained: UNEXPLAINED_RE, not_edge: NOT_EDGE_RE };
  var JARGON_RE = /\b(V2\.\d|V2|V1|champion (?:engine|model)|ensemble|ridge regression|gradient-boosted|PMF|sigma|perturbation|regime curve|cfbfastR|play attribution|JSON|pipeline|explainer|holdout|R²|backtest)\b/;
  /* a year, or last season — “the last meeting” alone does not tell a reader it was 2023 */
  var HIST_DATE_RE = /\b(19|20)\d{2}\b|\b(?:last|previous) (?:season|year)\b/i;

  var WORD_RE_CACHE = {};
  function wordRe(w) {
    w = String(w);
    if (!WORD_RE_CACHE[w]) WORD_RE_CACHE[w] = new RegExp('(^|[^A-Za-z])' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + (/[a-z]$/i.test(w) && w.length >= 5 ? '' : '(?![A-Za-z])'), 'i');
    return WORD_RE_CACHE[w];
  }
  function normNums(s) { return String(s).replace(/(\d),(?=\d{3}\b)/g, '$1'); }
  function hasNum(s, n) {
    var t = String(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('(^|[^0-9.])' + t + '(?![0-9]|\\.[0-9])').test(s);
  }
  function sentences(t) {
    return normNums(String(t)).replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').split(/\n+|(?<=[.!?])\s+(?=[A-Z“"*(\-])/).map(function (s) { return s.trim(); }).filter(Boolean);
  }
  function citedIn(c, sents) {
    var nums = c.cite && c.cite.nums || [], words = (c.cite && c.cite.words || []).filter(Boolean);
    return sents.some(function (s) {
      var hit = c.cite && c.cite.any ? nums.some(function (n) { return hasNum(s, normNums(n)); }) : nums.every(function (n) { return hasNum(s, normNums(n)); });
      if (nums.length && !hit) return false;
      if (!words.length) return true;
      var has = function (w) { return String(w).split('|').some(function (x) { return x && wordRe(x).test(s); }); };
      return c.cite && c.cite.all ? words.every(has) : words.some(has);
    });
  }
  var STATUS_TOPICS = { qb_status: 1, injury: 1, input: 1 };
  var COUNTER_SECTIONS = { counterargument: 1, game_script: 1, market_case: 1 };
  function citedClaims(packet, text) {
    var s = sentences(text);
    return (packet && packet.claims || []).filter(function (c) { return (c.cite.nums.length || c.cite.words.length) && citedIn(c, s); });
  }

  /* the text an article says about each featured game: a ### block in a
     multi-game article, the whole body in a single-game one */
  function blocksFor(article, games, single) {
    var body = (article.sections || []).map(function (s) { return s.body; }).join('\n\n');
    if (single == null) single = games.length === 1;
    var out = {};
    if (single) { out[games[0].game_id] = { text: body, single: true }; return out; }
    /* a game's block runs from its ### heading to the next heading or the end
       of its section: what follows in another section is not about that game */
    var parts = [];
    (article.sections || []).forEach(function (sec) {
      String(sec.body || '').split(/\n(?=### )/).forEach(function (x) {
        x = x.replace(/^\n+/, '');
        if (/^### /.test(x)) { parts.push({ head: x.split('\n')[0], text: x }); return; }
        /* a game led in bold is a block too when it argues EdgeDesk's number or
           the line: "**Away at Home.** …" paragraphs and "- **Away at Home:** …"
           bullets (the model-versus-market writing), not a weather note */
        x.split(/\n+/).forEach(function (line) {
          var m = /^(?:- )?\*\*([^*]+?)[.:]\*\*/.exec(line);
          if (m && /\b(?:line|market|spread)\b|EdgeDesk(?:’s|'s)? (?:has|number|model|projection)/i.test(line)) parts.push({ head: m[1], text: line });
        });
      });
    });
    games.forEach(function (p) {
      var hit = parts.filter(function (b) { return b.head.indexOf(p.home) >= 0 && b.head.indexOf(p.away) >= 0; });
      if (hit.length) out[p.game_id] = { text: hit.map(function (b) { return b.text; }).join('\n\n'), single: false };
    });
    return out;
  }

  /* article: {sections, title, standfirst, format, base_format}
     research: o.research ({games:[packets with .evidence]})
     opts: { publisher (bool), firstParty (bool), kind } */
  function gate(article, research, opts) {
    opts = opts || {};
    var checks = [];
    function add(id, status, label, detail, game) { checks.push({ id: id, status: status, label: label, detail: detail || null, game: game || null, gate: 'evidence' }); }
    var games = (research && research.games) || [];
    var body = (article.sections || []).map(function (s) { return s.body; }).join('\n\n');
    var all = [article.title, article.standfirst, body].join('\n\n');
    var single = opts.single != null ? !!opts.single : games.length === 1;
    var blocks = blocksFor(article, games, single);
    var storyLike = /trending_story/.test(article.base_format || article.format || '');
    var record = [];
    var holds = [];
    var shown = games.filter(function (p) { return blocks[p.game_id]; });

    if (!games.length) { add('evidence_scope', 'pass', 'No featured games to evidence'); return finish(); }
    if (!shown.length) add('evidence_games_shown', 'fail', 'The article discusses its featured games', 'no featured game could be found in the article text');

    shown.forEach(function (p) {
      var ev = p.evidence, name = p.away + ' at ' + p.home;
      var blk = blocks[p.game_id], sents = sentences(blk.text);
      if (!ev || ev.schema !== SCHEMA) { add('evidence_packet', 'fail', 'A football evidence packet backs every featured game', name + ': no evidence packet' + (p.evidence_stale ? ' — ' + p.evidence_stale : ''), p.game_id); return; }
      var X = ev.explanation || {};
      var cited = ev.claims.filter(function (c) { return (c.cite.nums.length || c.cite.words.length) && citedIn(c, sents); });
      /* who is playing is a status, judged by injuries_addressed below; it is
         not a football reason for the number (“Chambliss started the last
         game” explains nothing about how the game will be played) */
      var football = cited.filter(function (c) { return c.football && !STATUS_TOPICS[c.topic]; });
      var measured = football.filter(function (c) { return c.measured; });
      var need = storyLike ? 1 : (single ? 5 : 2);
      add('football_evidence', football.length >= need && measured.length >= Math.min(need, single ? 3 : 1) ? 'pass' : 'fail', 'Football evidence, not just the projection',
        name + ': ' + football.length + ' football claim' + (football.length === 1 ? '' : 's') + ' cited, availability aside (' + measured.length + ' measured; need ' + need + ')', p.game_id);
      /* quarterbacks */
      var qbNames = uniq(ev.claims.filter(function (c) { return (c.topic === 'qb' || c.topic === 'qb_status') && c.subject; }).map(function (c) { return c.subject; }));
      var qbCited = cited.filter(function (c) { return c.topic === 'qb' && c.football; });
      if (!storyLike) {
        var teamsWithQb = uniq(ev.claims.filter(function (c) { return /^(qb_season|team_passing):/.test(c.key); }).map(function (c) { return c.team; }));
        var named = qbNames.filter(function (n) { return blk.text.indexOf(lastName(n)) >= 0; });
        var ok = single ? (qbCited.length >= Math.min(2, teamsWithQb.length) && teamsWithQb.every(function (t) { return qbCited.some(function (c) { return c.team === t; }); })) : (named.length >= 1 || qbCited.length >= 1);
        add('qb_discussed', ok || !qbNames.length ? 'pass' : 'fail', 'Discusses recent quarterback performance', name + ': ' + (ok ? 'quarterbacks discussed' : 'no measured quarterback performance cited' + (single ? ' for both teams' : '')), p.game_id);
      }
      /* material injuries and conflicts must be addressed */
      var mat = materialInjuries(ev);
      var needMat = single && !storyLike ? mat : mat.filter(function (c) { return c.verification === 'CONFLICTING' || (c.values && c.values.position === 'QB'); });
      /* a conflict is addressed only by stating it; naming the player is not enough */
      var missing = needMat.filter(function (c) { return !citedIn(c, sents) && (c.verification === 'CONFLICTING' || !(c.subject && blk.text.indexOf(lastName(c.subject)) >= 0)); });
      add('injuries_addressed', missing.length ? 'fail' : 'pass', 'Material injuries and availability are addressed', missing.length ? name + ': not mentioned — ' + missing.map(function (c) { return c.short || c.text; }).join('; ') : null, p.game_id);
      /* contrary evidence where the numbers disagree (and always in a single-game piece) */
      var gap = X.gap && X.gap.points || 0;
      var mentionsGap = !!(ev.market && ev.market.text && (blk.text.indexOf(String(ev.market.margin)) >= 0 || /\bline\b|\bmarket\b|\bspread\b/i.test(blk.text)));
      if ((single && !storyLike) || (gap >= MATERIAL_GAP && mentionsGap)) {
        var contra = (X.contradicting || []).map(function (id) { return ev.claims.filter(function (c) { return c.id === id; })[0]; }).filter(Boolean);
        /* a single-game piece argues the other side where it says it does (the
           counterargument, the game script, the market's case): a stat that
           merely appears in the evidence section is not an argument against */
        var counter = single ? (article.sections || []).filter(function (x) { return COUNTER_SECTIONS[x.key]; }).map(function (x) { return x.body; }).join('\n\n') : '';
        var csents = counter ? sentences(counter) : sents;
        var cc = contra.filter(function (c) { return citedIn(c, csents); });
        var needC = counter && contra.length >= 2 ? 2 : 1;
        var pool = contra.length ? cc.length : (cited.filter(function (c) { return c.football && c.leans && c.leans !== (X.gap && X.gap.toward); }).length);
        add('contrary_evidence', pool >= needC ? 'pass' : 'fail', 'Includes the evidence against EdgeDesk’s view', name + ': ' + pool + ' contradicting claim(s) cited' + (counter ? ' where the article argues the other side' : '') + ' (need ' + needC + ')', p.game_id);
      }
      /* an unexplained or suspect gap is disclosed as such, never sold */
      if ((X.status === 'UNEXPLAINED' || X.input_suspect) && gap >= MATERIAL_GAP && (mentionsGap || single || gap >= MAJOR_GAP)) {
        var saysUnexp = UNEXPLAINED_RE.test(blk.text), saysNotEdge = NOT_EDGE_RE.test(blk.text);
        add('unexplained_disclosed', saysUnexp && saysNotEdge ? 'pass' : 'fail', 'An unexplained gap is called unexplained',
          name + ': status ' + X.status + (X.input_suspect ? ' (input suspect)' : '') + (saysUnexp && saysNotEdge ? '' : ' — the article must say EdgeDesk cannot explain the gap' + (saysUnexp ? ' (it does)' : '') + ' and that it is not an edge' + (saysNotEdge ? ' (it does)' : '')), p.game_id);
      }
      /* causal claims about the model must rest on the model's own terms */
      var bad = [];
      sents.forEach(function (s) {
        if (!CAUSAL_RE.test(s)) return;
        var about = MODEL_SUBJ_RE.test(s) || GAP_RE.test(s);
        if (!about) return;
        var cs = ev.claims.filter(function (c) { return citedIn(c, [s]); });
        var mech = cs.filter(function (c) { return c.verification === 'MODEL_OUTPUT' || c.verification === 'CONFLICTING' || c.verification === 'MARKET_DATA'; });
        var foot = cs.filter(function (c) { return c.football; });
        if (!cs.length && /\b(because|due to|driven by|thanks to|stems? from|caused by|the reason)\b/i.test(s)) bad.push('“' + s.slice(0, 110) + '” — no evidence in the sentence');
        else if (MODEL_SUBJ_RE.test(s) && /\b(likes?|favou?rs?|rates?|sees?|backs?|is high on|projects?)\b/i.test(s) && foot.length && !mech.length) bad.push('“' + s.slice(0, 110) + '” — presents a football stat as the model’s reason; the model’s reasons are its terms');
        else if (X.status === 'UNEXPLAINED' && GAP_RE.test(s) && foot.length && !mech.length && !/\b(not|no|isn(?:’|')t|cannot|can(?:’|')t)\b/i.test(s)) bad.push('“' + s.slice(0, 110) + '” — attributes an unexplained gap to a football cause');
      });
      add('causal_supported', bad.length ? 'fail' : 'pass', 'No unsupported causal explanation', bad.length ? bad.slice(0, 3).join(' · ') : null, p.game_id);
      /* availability stated as the evidence states it */
      var wrong = [];
      ev.claims.filter(function (c) { return c.subject && (c.topic === 'injury' || c.topic === 'qb_status' || c.verification === 'CONFLICTING'); }).forEach(function (c) {
        var st = String(c.status || (c.values && c.values.status) || '').toUpperCase();
        sents.filter(function (s) { return s.indexOf(lastName(c.subject)) >= 0; }).forEach(function (s) {
          var past = /\b(missed|was ruled out|sat out|did not play|didn(?:’|')t play|was scratched|last (?:week|game|saturday))\b/i.test(s);
          if (!past && /\b(ruled out|is out|will miss|won(?:’|')t play|will not play|out for the|sidelined)\b/i.test(s) && st && st !== 'OUT' && c.subject === subjectOf(s, ev)) wrong.push(c.subject + ' is ' + st.toLowerCase() + ', not out');
          if (/\b(will start|is confirmed|confirmed (?:as|to start)|has been cleared|is cleared|fully healthy|is healthy)\b/i.test(s) && !/\b(not|never|no|isn(?:’|')t|hasn(?:’|')t|yet to|unless|if)\b/i.test(s) && st !== 'CONFIRMED' && st !== 'AVAILABLE' && c.subject === subjectOf(s, ev)) wrong.push(c.subject + ' is not confirmed (' + (st || 'unconfirmed').toLowerCase() + ')');
          if (st === 'OUT' && /\b(will start|is expected to (?:start|play)|available|probable)\b/i.test(s) && !past && c.subject === subjectOf(s, ev)) wrong.push(c.subject + ' is listed out');
        });
      });
      add('injury_status_correct', wrong.length ? 'fail' : 'pass', 'Injury and starter status match the report', wrong.length ? uniq(wrong).join('; ') : null, p.game_id);
      /* historical facts carry their date — in EVERY sentence that states
         them: one dated mention does not license an undated one elsewhere */
      var undated = ev.claims.filter(function (c) { return c.scope === 'historical' && c.topic !== 'model'; }).filter(function (c) {
        return sents.some(function (s) {
          var mentions = citedIn(c, [s]) || !!(c.values && c.values.last && hasNum(s, String(c.values.last.home_points)) && hasNum(s, String(c.values.last.away_points)));
          return mentions && !HIST_DATE_RE.test(s);
        });
      });
      add('historical_dated', undated.length ? 'fail' : 'pass', 'Historical facts are dated, not presented as current', undated.length ? undated.map(function (c) { return c.short || c.text; }).join('; ') : null, p.game_id);
      /* the gap, if stated, is the gap */
      if (X.gap) {
        var wrongGap = [];
        sents.forEach(function (s) {
          if (/\baccount|explain/i.test(s)) return;
          var m = s.match(/(\d+(?:\.\d+)?)[- ](?:point|pt)s?\s+(?:gap|apart|difference|closer|further|disagreement|away from)|gap of (\d+(?:\.\d+)?)|differ(?:s|ence)? (?:by|of) (\d+(?:\.\d+)?)|(\d+(?:\.\d+)?) points? (?:closer|apart)/i);
          if (!m) return;
          var v = parseFloat(m[1] || m[2] || m[3] || m[4]);
          if (Math.abs(v - X.gap.points) > 0.15 && Math.abs(v - Math.round(X.gap.points)) > 0.01) wrongGap.push(v + ' (the gap is ' + f1(X.gap.points) + ')');
        });
        add('gap_arithmetic', wrongGap.length ? 'fail' : 'pass', 'Model-versus-line arithmetic is correct', wrongGap.length ? name + ': ' + wrongGap.join(', ') : null, p.game_id);
      }
      cited.forEach(function (c) {
        var so = sourceOf(ev, c);
        record.push({ game_id: p.game_id, claim_id: c.id, text: c.text, topic: c.topic, verification: c.verification, scope: c.scope || 'current_season', observed_at: so && so.observed_at || null,
          source: so ? { label: so.label, path: so.path || null, url: so.url || null, publisher: so.publisher || null, published_at: so.published_at || null } : null,
          needs_confirmation: !!c.needs_confirmation, central: !!c.football || c.topic === 'model' || c.topic === 'market' });
        if (c.needs_confirmation) holds.push((c.short || c.text) + ' (' + (so && so.label || 'report') + ')');
      });
      if (X.input_suspect) holds.push(name + ': EdgeDesk’s inputs are suspect (' + X.input_flags.filter(function (f) { return f.severity === 'high'; }).map(function (f) { return f.key; }).join(', ') + ')');
    });

    /* whole-article checks */
    var edge = all.match(EDGE_RE);
    add('no_edge_language', edge ? 'fail' : 'pass', 'No betting-edge language', edge ? '“' + edge[0] + '”' : null);
    var counts = {};
    sentences(body).forEach(function (s) { var k = s.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim(); if (k.split(' ').length >= 8) counts[k] = (counts[k] || 0) + 1; });
    var rep = Object.keys(counts).filter(function (k) { return counts[k] >= 3; }), rep2 = Object.keys(counts).filter(function (k) { return counts[k] === 2; });
    add('no_repetition', rep.length ? 'fail' : (rep2.length ? 'warn' : 'pass'), 'No repeated boilerplate', rep.length ? rep.length + ' sentence(s) repeated 3+ times, e.g. “' + rep[0].slice(0, 80) + '”' : (rep2.length ? rep2.length + ' sentence(s) repeated twice' : null));
    if (opts.publisher) {
      var jg = all.match(JARGON_RE) || all.replace(/\]\([^)]*\)/g, ']').replace(/https?:\/\/\S+/g, '').match(/\b[a-z]+(?:_[a-z0-9]+)+\b/);
      add('no_software_jargon', jg ? 'fail' : 'pass', 'No software or modelling jargon for a general audience', jg ? '“' + jg[0] + '”' : null);
    }
    /* every link points at EdgeDesk or a source in the evidence */
    var known = {};
    games.forEach(function (p) { var sv = (p.evidence && p.evidence.sources) || {}; Object.keys(sv).forEach(function (k) { var so = sv[k]; if (so && so.url) known[hostOf(so.url)] = 1; (so && so.corroboration || []).forEach(function (y) { if (y.url) known[hostOf(y.url)] = 1; }); }); });
    (opts.sources || []).forEach(function (s) { if (s && s.url) known[hostOf(s.url)] = 1; });
    var unknown = [];
    String(body).replace(/\]\((https?:\/\/[^)\s]+)\)/g, function (_, u) { var h = hostOf(u); if (!/(^|\.)edgedesksports\.com$/.test(h) && !known[h]) unknown.push(h); return _; });
    add('sources_known', unknown.length ? 'fail' : 'pass', 'No source outside the research', unknown.length ? 'links to ' + uniq(unknown).join(', ') : null);
    return finish();

    function finish() {
      var fails = checks.filter(function (c) { return c.status === 'fail'; });
      return {
        checks: checks, evidence_record: record, holds: uniq(holds),
        readiness: fails.length ? 'BLOCKED' : (holds.length ? 'HOLD_FOR_REVIEW' : 'READY'),
        version: VERSION
      };
    }
  }
  function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return String(u); } }
  /* which person a sentence is about: the evidence subject whose surname appears first */
  function subjectOf(s, ev) {
    var best = null, at = Infinity;
    ev.claims.forEach(function (c) { if (!c.subject) return; var i = s.indexOf(lastName(c.subject)); if (i >= 0 && i < at) { at = i; best = c.subject; } });
    return best;
  }

  /* ======================================================================
     FACTS LEDGER — outside reporting the desk recorded, with receipts
     ====================================================================== */
  var FACT_KINDS = ['availability', 'result', 'qb_stats', 'head_to_head', 'personnel', 'team_stats', 'preseason_note', 'schedule'];
  var FACT_TTL_HOURS = { availability: 72, personnel: 24 * 14, qb_stats: 24 * 7, team_stats: 24 * 7, preseason_note: 24 * 120, schedule: 24 * 30 };
  function validateFact(f, nowMs) {
    var reasons = [];
    if (!f || typeof f !== 'object') return { ok: false, reasons: ['not an object'] };
    if (!/^[a-z0-9_.-]{6,80}$/.test(String(f.id || ''))) reasons.push('id: lower-case slug, 6–80 characters');
    if (['cfb', 'nfl'].indexOf(f.league) < 0) reasons.push('league must be cfb or nfl');
    if (FACT_KINDS.indexOf(f.kind) < 0) reasons.push('kind must be one of ' + FACT_KINDS.join(', '));
    if (!Array.isArray(f.teams) || !f.teams.length) reasons.push('teams: the team names the fact concerns');
    if (!f.text || String(f.text).length < 12) reasons.push('text is required');
    var s = f.source || {};
    if (!s.publisher) reasons.push('source.publisher is required');
    if (!/^https:\/\/\S+\.\S+/.test(String(s.url || ''))) reasons.push('source.url is required (https)');
    if (!isFinite(Date.parse(s.published_at || ''))) reasons.push('source.published_at (when the SOURCE said it) is required');
    if (!f.recorded_by) reasons.push('recorded_by is required');
    if (['VERIFIED', 'REPORTED'].indexOf(f.verification) < 0) reasons.push('verification must be VERIFIED (a person opened the source and confirmed it) or REPORTED');
    if (f.verification === 'VERIFIED' && !f.verified_by) reasons.push('a VERIFIED fact names verified_by');
    if (isFinite(Date.parse(s.published_at || '')) && Date.parse(s.published_at) > (nowMs || Date.now()) + 3600000) reasons.push('published_at is in the future');
    var nums = String(f.text).match(/\d+(?:\.\d+)?/g) || [];
    var cnums = (f.cite && f.cite.nums) || [];
    cnums.forEach(function (n) { if (nums.indexOf(String(n)) < 0 && normNums(f.text).indexOf(String(n)) < 0) reasons.push('cite number ' + n + ' does not appear in the text'); });
    return reasons.length ? { ok: false, reasons: reasons } : { ok: true };
  }
  function factsFor(ledger, packetish, nowMs) {
    var facts = (ledger && ledger.facts) || [];
    return facts.filter(function (f) {
      if (f.game_id && String(f.game_id) !== String(packetish.game_id)) return false;
      if (!f.game_id && !(f.teams || []).some(function (t) { return t === packetish.home || t === packetish.away; })) return false;
      var exp = ts(f.expires_at); if (exp != null && exp <= (nowMs || Date.now())) return false;
      return true;
    });
  }
  /* what to look up for a featured game: missing or expired research items */
  function researchPlan(packet) {
    var gaps = (packet.coverage || []).filter(function (c) { return c.status === 'MISSING'; }).map(function (c) { return { item: c.item, label: c.label, why: c.why }; });
    var conf = (packet.claims || []).filter(function (c) { return c.needs_confirmation; }).map(function (c) { var so = sourceOf(packet, c); return { claim: c.id, confirm: c.short || c.text, source: so && so.url }; });
    var qb = (packet.claims || []).filter(function (c) { return c.topic === 'qb_status' && c.status !== 'CONFIRMED'; }).map(function (c) { return { item: 'starter_confirmation', team: c.team, question: 'Has ' + c.team + ' named its starting quarterback?' }; });
    return { game: packet.away + ' at ' + packet.home, game_id: packet.game_id, status: packet.explanation && packet.explanation.status, missing: gaps, to_confirm: conf, starters: qb };
  }

  /* a compact view for the AI request: the claims a writer may use */
  function forWriter(packet) {
    if (!packet) return null;
    var X = packet.explanation || {};
    return {
      game: packet.away + ' at ' + packet.home, status: X.status, input_suspect: X.input_suspect, actionable: false,
      thesis: X.thesis, assessment: X.assessment, gap: X.gap || null, headline_question: X.headline_question || null,
      critical_matchup: X.critical_matchup || null,
      supporting: (X.supporting || []).slice(0, 6), contradicting: (X.contradicting || []).slice(0, 6),
      game_script: X.game_script, uncertainty: X.uncertainty, input_flags: X.input_flags,
      claims: packet.claims.filter(function (c) { return c.verification !== 'MISSING'; }).map(function (c) {
        var so = sourceOf(packet, c);
        return { id: c.id, topic: c.topic, team: c.team || null, text: c.text, verification: c.verification, scope: c.scope || 'current_season', source: so && (so.publisher || so.label), url: so && so.url || null, needs_attribution: c.verification === 'REPORTED' || c.verification === 'VERIFIED_REPORT', caveat: c.caveat || null };
      }),
      missing: (packet.coverage || []).filter(function (c) { return c.status === 'MISSING'; }).map(function (c) { return c.label; })
    };
  }

  return {
    SCHEMA: SCHEMA, VERSION: VERSION, METRICS: METRICS, PAIRS: PAIRS, COVERAGE: COVERAGE, FACT_KINDS: FACT_KINDS, FACT_TTL_HOURS: FACT_TTL_HOURS, DISCLOSE_RE: DISCLOSE_RE,
    MATERIAL_GAP: MATERIAL_GAP, MAJOR_GAP: MAJOR_GAP,
    buildCfb: buildCfb, buildNfl: buildNfl, explain: explain,
    gate: gate, citedClaims: citedClaims, sentences: sentences,
    validateFact: validateFact, factsFor: factsFor, researchPlan: researchPlan, forWriter: forWriter,
    sourceOf: sourceOf, trim: trim, articleSummary: articleSummary, firstPartyGate: firstPartyGate,
    writer: { pick: pick, qbSummary: qbSummary, materialInjuries: materialInjuries, byId: byIdOf, lastName: lastName, poss: poss, dayMonth: dayMonth, sentenceList: sentenceList, f1: f1 },
    util: { hash: hash }
  };
});
