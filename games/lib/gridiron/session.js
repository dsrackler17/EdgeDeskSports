/* ===========================================================================
   GRIDIRON — a session of football.

   The glue between the engine, the renderer and everything else: settings, a
   game that survives the browser closing, the league of fictional opponents,
   and the bridge to a franchise when there is one.

   HOW A GAME IS SAVED. Not by writing the state — by writing the SEED AND THE
   CALLS. The engine is deterministic, so twenty bytes of call list rebuild the
   exact game, every ball and every yard of it. Close the tab at 3rd and 7 in
   the third quarter and it comes back at 3rd and 7 in the third quarter.

   THE FRANCHISE. If one is signed in, the game is played with its roster, its
   scheme, its opponent and its week's preparation. If not, Game Day still
   works: it builds both sides out of the league below. The football never
   waits on a network.
   =========================================================================== */
(function (root) {
  'use strict';

  var G = root.EDGridiron || (typeof require === 'function' ? require('./engine.js') : null);
  var AI = root.EDGridironAI || (typeof require === 'function' ? require('./ai.js') : null);
  var Auto = root.EDGridironAuto || (typeof require === 'function' ? require('./autoplay.js') : null);
  var F = root.EDFootball || (typeof require === 'function' ? require('./football.js') : null);
  var R = root.EDRoster || (typeof require === 'function' ? require('./roster.js') : null);

  var SAVE_KEY = 'ed_gridiron_game_v1';
  var SET_KEY = 'ed_gridiron_settings_v1';

  /* ── THE LEAGUE ──────────────────────────────────────────────────────────
     Eight clubs that play differently from each other, because "the AI has a
     personality" has to mean something a player can feel on the field. Each
     one's scheme, rating and coaching tier is what actually changes. */
  var TEAMS = [
    { key: 'forgemen', city: 'Iron Ridge', name: 'Forgemen', abbr: 'IRF', theme: 'crimson', logo: 'gear',
      overall: 74, offense: 'power_run', defense: 'four_three', personality: 'trench',
      blurb: 'Trench-heavy, slow, physical, conservative. They will run it at you all afternoon.' },
    { key: 'oxen', city: 'Timberline', name: 'Oxen', abbr: 'TLO', theme: 'forest', logo: 'bull',
      overall: 73, offense: 'pro_style', defense: 'bend_dont_break', personality: 'balanced',
      blurb: 'Balanced, patient, a strong offensive line and no obvious way in.' },
    { key: 'vipers', city: 'Sonora', name: 'Vipers', abbr: 'SNV', theme: 'gold', logo: 'spear',
      overall: 75, offense: 'spread', defense: 'blitz_heavy', personality: 'aggressive',
      blurb: 'Spread, tempo, and they blitz you on any down they feel like.' },
    { key: 'ghosts', city: 'Mesa', name: 'Ghosts', abbr: 'MSG', theme: 'slate', logo: 'wing',
      overall: 72, offense: 'air_raid', defense: 'zone', personality: 'speed',
      blurb: 'Speed and disguise. Feast or famine, and the variance is the point.' },
    { key: 'longhaul', city: 'Amarillo', name: 'Railmen', abbr: 'AMR', theme: 'orange', logo: 'anchor',
      overall: 70, offense: 'west_coast', defense: 'four_three', personality: 'balanced',
      blurb: 'Short timing throws, yards after the catch, and a lot of third-and-two.' },
    { key: 'mustangs', city: 'Cheyenne', name: 'Mustangs', abbr: 'CHM', theme: 'navy', logo: 'horn',
      overall: 76, offense: 'option', defense: 'three_four', personality: 'trench',
      blurb: 'The option, run properly. If you guess wrong they take the edge.' },
    { key: 'gales', city: 'Galveston', name: 'Gales', abbr: 'GLV', theme: 'teal', logo: 'wave',
      overall: 71, offense: 'spread', defense: 'press_man', personality: 'aggressive',
      blurb: 'Press coverage everywhere and a dare to beat it deep.' },
    { key: 'sentinels', city: 'Boulder Creek', name: 'Sentinels', abbr: 'BCS', theme: 'violet', logo: 'shield',
      overall: 77, offense: 'pro_style', defense: 'zone', personality: 'balanced',
      blurb: 'The best team in the league, and they do not beat themselves.' }
  ];
  function teamByKey(k) {
    var out = null;
    TEAMS.forEach(function (t) { if (t.key === k) out = t; });
    return out || TEAMS[0];
  }

  /* the franchise the game defaults to before anybody founds one */
  var HOUSE = { city: 'Lubbock', name: 'High Plains', abbr: 'LHP', theme: 'forest', logo: 'peak',
    overall: 74, offense: 'power_run', defense: 'three_four' };

  /* ── SETTINGS ────────────────────────────────────────────────────────────── */
  var DEFAULTS = {
    speed: 'normal',        /* normal | fast | instant */
    mode: 'play',           /* play | coach */
    difficulty: 'pro',
    art: true,
    sound: true,
    haptics: true,
    length: 'standard',     /* standard 15:00 | quick 8:00 | blitz 5:00 */
    autoDefense: false
  };
  var SPEEDS = { normal: 1.5, fast: 2.6, instant: 99 };
  var LENGTHS = { standard: 900, quick: 480, blitz: 300 };

  function store() {
    try { return root.localStorage; } catch (_) { return null; }
  }
  function settings() {
    var s = store(), o = {}, k, raw;
    for (k in DEFAULTS) if (DEFAULTS.hasOwnProperty(k)) o[k] = DEFAULTS[k];
    if (!s) return o;
    try {
      raw = JSON.parse(s.getItem(SET_KEY) || '{}');
      for (k in DEFAULTS) if (DEFAULTS.hasOwnProperty(k) && raw[k] != null) o[k] = raw[k];
    } catch (_) {}
    return o;
  }
  function saveSettings(o) {
    var s = store();
    if (!s) return o;
    try { s.setItem(SET_KEY, JSON.stringify(o)); } catch (_) {}
    return o;
  }

  /* ── BUILDING A GAME ─────────────────────────────────────────────────────
     From a franchise snapshot when there is one, from the league when there
     is not. Either way the result is the same two arguments the engine takes.  */
  function teamFromFranchise(f, players, prep) {
    if (!f) return null;
    return {
      id: f.id, city: f.city, name: f.name, abbr: f.abbr, theme: f.theme, logo: f.logo,
      offense: f.offense, defense: f.defense,
      overall: f.overall || f.rating_overall || 74,
      players: players && players.length ? players : null,
      seed: (f.city || '') + (f.name || ''),
      mods: {
        preparation: prep ? prep.preparation : 0,
        scouting: prep ? prep.scouting : 0,
        conditioning: prep ? (prep.conditioning || 0) : 0,
        offense: prep ? (prep.offense_edge || 0) : 0,
        defense: prep ? (prep.defense_edge || 0) : 0
      }
    };
  }
  function teamFromLeague(t, seedSalt) {
    return {
      city: t.city, name: t.name, abbr: t.abbr, theme: t.theme, logo: t.logo,
      offense: t.offense, defense: t.defense, overall: t.overall,
      seed: t.key + (seedSalt || ''), identity: t.personality
    };
  }

  /* one game, ready to play */
  function build(o) {
    o = o || {};
    var set = o.settings || settings();
    var me = o.me || teamFromLeague(
      { key: 'house', city: HOUSE.city, name: HOUSE.name, abbr: HOUSE.abbr, theme: HOUSE.theme,
        logo: HOUSE.logo, offense: HOUSE.offense, defense: HOUSE.defense, overall: HOUSE.overall });
    var opp = o.opponent || teamFromLeague(TEAMS[0]);
    var atHome = o.home !== false;
    var seed = o.seed != null ? o.seed
      : (me.abbr || 'ME') + '-' + (opp.abbr || 'OP') + '-' + (o.week || 1) + '-' + (o.season || 1);
    var g = G.createGame({
      seed: seed,
      home: atHome ? me : opp,
      away: atHome ? opp : me,
      user: atHome ? 'home' : 'away',
      difficulty: set.difficulty,
      quarterSeconds: LENGTHS[set.length] || LENGTHS.standard
    });
    g.meta = { user: atHome ? 'home' : 'away', seed: seed, week: o.week || 1, season: o.season || 1,
               opponentKey: o.opponentKey || null, home: atHome, length: set.length,
               difficulty: set.difficulty };
    g.calls = [];
    return g;
  }

  /* ── SAVE AND RESUME ─────────────────────────────────────────────────────
     The call list is the save file. Replaying it is the load. */
  function record(g, call) {
    if (!g.calls) g.calls = [];
    g.calls.push(compress(call));
  }
  /* ONE CALL, IN AS FEW BYTES AS IT TAKES. The type is a single letter — and
     punt is 'u' rather than 'p' because a play is already 'p'. */
  function compress(c) {
    if (!c || !c.type) return { t: 'k' };
    switch (c.type) {
      case 'play': return { t: 'p', p: c.play, f: c.formation, d: c.def, m: c.tempo,
        r: c.read == null ? null : c.read, l: c.lane == null ? null : c.lane,
        g: c.timing == null ? null : c.timing, sc: c.scramble ? 1 : 0,
        o: c.outcome ? thinOutcome(c.outcome) : null };
      case 'two': return { t: '2', p: c.play, f: c.formation, d: c.def };
      case 'pat': return { t: 'x' };
      case 'punt': return { t: 'u' };
      case 'fieldgoal': return { t: 'g' };
      case 'halftime_done': return { t: 'h', a: c.adjust || null, b: c.oppAdjust || null };
      case 'timeout': return { t: 't', s: c.side || null };
      default: return { t: 'k' };
    }
  }
  function expand(c) {
    if (!c) return { type: 'kickoff' };
    switch (c.t) {
      case 'p': return { type: 'play', play: c.p, formation: c.f, def: c.d, tempo: c.m,
        read: c.r == null ? null : c.r, lane: c.l == null ? null : c.l,
        timing: c.g == null ? null : c.g, scramble: !!c.sc,
        outcome: c.o || null };
      case '2': return { type: 'two', play: c.p, formation: c.f, def: c.d };
      case 'x': return { type: 'pat' };
      case 'u': return { type: 'punt' };
      case 'g': return { type: 'fieldgoal' };
      case 'h': return { type: 'halftime_done', adjust: c.a || null, oppAdjust: c.b || null };
      case 't': return { type: 'timeout', side: c.s || null };
      default: return { type: 'kickoff' };
    }
  }

  function save(g) {
    var s = store();
    if (!s || !g || !g.meta) return;
    try {
      s.setItem(SAVE_KEY, JSON.stringify({
        v: 1, meta: g.meta, calls: g.calls || [],
        at: Date.now(),
        show: { home: g.home.abbr, away: g.away.abbr,
                score: { home: g.score.home, away: g.score.away },
                quarter: g.quarter, clock: g.clock }
      }));
    } catch (_) {}
  }
  function saved() {
    var s = store();
    if (!s) return null;
    try { return JSON.parse(s.getItem(SAVE_KEY) || 'null'); } catch (_) { return null; }
  }
  function clearSave() { var s = store(); if (s) { try { s.removeItem(SAVE_KEY); } catch (_) {} } }

  /* rebuild a game from its save and replay every call into it */
  function resume(rec, o) {
    if (!rec || !rec.meta) return null;
    o = o || {};
    var g = build({
      me: o.me, opponent: o.opponent, home: rec.meta.home, seed: rec.meta.seed,
      week: rec.meta.week, season: rec.meta.season, opponentKey: rec.meta.opponentKey,
      settings: { difficulty: rec.meta.difficulty, length: rec.meta.length }
    });
    g.meta = rec.meta;
    var i;
    for (i = 0; i < rec.calls.length; i++) {
      var r = G.step(g, expand(rec.calls[i]));
      if (!r.ok) break;
      g.calls.push(rec.calls[i]);
    }
    return g;
  }

  /* ── ONE STEP, WITH THE SAVE KEPT IN STEP ───────────────────────────────── */
  function step(g, call) {
    if (call && call.outcome) call.outcome = withPlayers(g, call.outcome);
    var r = G.step(g, call);
    if (r.ok) { g.calls.push(compress(call)); save(g); }
    return r;
  }

  /* ── A LIVE OUTCOME, SAVED AND RESTORED ──────────────────────────────────
     A Play Mode snap is settled out on the grass, so the call list has to
     carry the result as well as the call: replaying the inputs is not enough
     when the inputs were a thumb. Player cards do not survive a round trip
     through storage, so they travel as ids and are looked up again on the way
     back in — which keeps the box score naming the same men after a reload. */
  var WHO = ['carrier', 'target', 'tackler', 'interceptor'];
  function thinOutcome(o) {
    if (!o) return null;
    var out = {}, k;
    for (k in o) {
      if (!Object.prototype.hasOwnProperty.call(o, k)) continue;
      if (WHO.indexOf(k) >= 0) { out[k] = o[k] && o[k].id ? o[k].id : null; continue; }
      if (k === 'notes') { out[k] = o[k]; continue; }
      if (o[k] && typeof o[k] === 'object') continue;
      out[k] = o[k];
    }
    return out;
  }
  function withPlayers(g, o) {
    if (!o) return o;
    var i, k, seen = {};
    ['home', 'away'].forEach(function (side) {
      var t = g.teams && g.teams[side];
      ((t && t.players) || []).forEach(function (p) { seen[p.id] = p; });
    });
    for (i = 0; i < WHO.length; i++) {
      k = WHO[i];
      if (typeof o[k] === 'string') o[k] = seen[o[k]] || null;
    }
    return o;
  }

  /* ── THE OPPOSING COACH, for whichever half of the call the user is not
     making. Coach Mode means the user calls both sides; Play Mode means the
     user calls offence and the AI defends, and defends its own. ─────────── */
  function aiDefense(g) {
    var sit = G.situation(g), off = sit.offense, def = sit.defense;
    return AI.callDefense({
      sit: sit, difficulty: g.cfg.difficulty, rand: g.aiRand || g.rand,
      oppOffense: G.teamOf(g, off).offense, oppMem: g.mem[off], mem: g.defMem[def]
    }).key;
  }
  function aiOffense(g, defCall) {
    var sit = G.situation(g), off = sit.offense, def = sit.defense;
    var c = AI.callOffense({
      sit: sit, team: G.teamOf(g, off), difficulty: g.cfg.difficulty, rand: g.aiRand || g.rand,
      mem: g.mem[off], defMem: g.defMem[def], tempo: AI.tempoFor(sit)
    });
    c.def = defCall;
    return c;
  }

  /* ── THE PRE-SNAP READ THE PLAYER GETS ───────────────────────────────────
     Everything the user is allowed to see before deciding: the box count, the
     coverage shell, and where the front is heavy. It is a PURE function of the
     defensive call and the formation, so what the page draws is exactly what
     the engine is about to resolve against. */
  function preSnap(g, playKey, formKey, defKey) {
    var parts = F.defParts(defKey), play = F.play(playKey);
    var box = G.boxCount(parts, formKey);
    var sit = G.situation(g);
    var strong = F.strongSide(parts.front.key + parts.coverage.key + parts.pressure.key + parts.fit.key, sit);
    var reads = F.reads(playKey, parts.coverage);
    return {
      parts: parts, play: play, box: Math.round(box * 10) / 10, strong: strong,
      reads: reads,
      blitzing: parts.pressure.key !== 'none',
      shell: parts.coverage.name,
      safeties: parts.coverage.key === 'cover0' ? 0
        : (parts.coverage.key === 'cover1' || parts.coverage.key === 'cover3') ? 1
        : (parts.coverage.key === 'cover4' || parts.coverage.key === 'cover6') ? 4 : 2,
      light: box <= 6.2, heavy: box >= 7.6
    };
  }

  /* ── WHAT SCOUTING KNOWS ABOUT THE OPPONENT ──────────────────────────────
     Derived from what they have actually called in this game plus what the
     franchise's scouting report says, and — this is the EdgeDesk part — it
     carries its own confidence. A tendency from four snaps is not a fact. */
  function scoutRead(g, side) {
    var mem = g.mem[side], n = mem.total, i, runs = 0, blitz = 0;
    for (i = 0; i < mem.recent.length; i++) {
      if (F.play(mem.recent[i].key).type === 'run') runs++;
    }
    var dm = g.defMem[side];
    for (i = 0; i < dm.recent.length; i++) {
      var d = F.defCall(dm.recent[i].key);
      if (d.pressure && d.pressure !== 'none') blitz++;
    }
    var conf = n >= 20 ? 'high' : n >= 8 ? 'medium' : 'low';
    return {
      snaps: n,
      runShare: mem.recent.length ? runs / mem.recent.length : null,
      blitzShare: dm.recent.length ? blitz / dm.recent.length : null,
      confidence: conf,
      note: n < 8 ? 'Too few snaps to call it a tendency.'
          : n < 20 ? 'A lean, not a tendency — ' + n + ' snaps.'
          : 'A tendency, over ' + n + ' snaps.'
    };
  }

  /* ── THE RECAP ───────────────────────────────────────────────────────────
     Why the game went the way it did, from the box score rather than a
     template: the three biggest real differences between the two teams. */
  function why(box, mySide) {
    var me = box[mySide], op = box[mySide === 'home' ? 'away' : 'home'], out = [];
    function add(cond, good, text) { if (cond) out.push({ good: good, text: text }); }
    add(me.ypc - op.ypc >= 0.8, true, me.ypc + ' yards a carry, to their ' + op.ypc + '.');
    add(op.ypc - me.ypc >= 0.8, false, 'They ran it at ' + op.ypc + ' a carry; you managed ' + me.ypc + '.');
    add(me.turnovers < op.turnovers, true, 'Won the turnover battle ' + op.turnovers + '–' + me.turnovers + '.');
    add(me.turnovers > op.turnovers, false, 'Gave it away ' + me.turnovers + ' times to their ' + op.turnovers + '.');
    add(me.thirdPct >= 45, true, 'Converted ' + me.third + ' on third down.');
    add(me.thirdPct < 30 && me.third !== '0/0', false, 'Third down was ' + me.third + '.');
    add(me.explosive - op.explosive >= 3, true, me.explosive + ' explosive plays to their ' + op.explosive + '.');
    add(op.explosive - me.explosive >= 3, false, 'They hit ' + op.explosive + ' explosive plays to your ' + me.explosive + '.');
    add(me.sacks > op.sacks + 1, true, 'Got home ' + me.sacks + ' times; they got ' + op.sacks + '.');
    add(op.sacks > me.sacks + 1, false, 'Gave up ' + op.sacks + ' sacks.');
    add(me.redzone !== '0/0', me.redzoneGood !== false, 'Red zone: ' + me.redzone + '.');
    add(me.top - op.top > 240, true, 'Held the ball for ' + Math.round(me.top / 60) + ' minutes.');
    add(op.top - me.top > 240, false, 'They held it for ' + Math.round(op.top / 60) + ' minutes.');
    return out;
  }
  /* the five worth printing: the ones that explain the result first */
  function reasons(box, mySide, won) {
    var all = why(box, mySide);
    var first = all.filter(function (r) { return r.good === won; });
    var rest = all.filter(function (r) { return r.good !== won; });
    return first.concat(rest).slice(0, 5).map(function (r) { return r.text; });
  }

  /* the play that turned it: the biggest swing in the log */
  function turningPoint(g) {
    var best = null, bestS = 0, i;
    for (i = 0; i < g.plays.length; i++) {
      var p = g.plays[i];
      var s = (p.td ? 7 : 0) + (p.to ? 6 : 0) + Math.max(0, p.yards) / 12;
      /* it matters more the later it is and the closer the game */
      s *= 1 + (p.q - 1) * 0.35;
      if (s > bestS) { bestS = s; best = p; }
    }
    return best;
  }

  var API = {
    TEAMS: TEAMS, HOUSE: HOUSE, DEFAULTS: DEFAULTS, SPEEDS: SPEEDS, LENGTHS: LENGTHS,
    SAVE_KEY: SAVE_KEY, SET_KEY: SET_KEY,
    teamByKey: teamByKey, settings: settings, saveSettings: saveSettings,
    teamFromFranchise: teamFromFranchise, teamFromLeague: teamFromLeague,
    build: build, step: step, save: save, saved: saved, clearSave: clearSave, resume: resume,
    aiDefense: aiDefense, aiOffense: aiOffense, scoutRead: scoutRead, preSnap: preSnap,
    why: why, reasons: reasons, turningPoint: turningPoint, record: record
  };
  root.EDGridironSession = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
