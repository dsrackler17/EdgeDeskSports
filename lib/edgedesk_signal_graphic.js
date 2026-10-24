/* ===========================================================================
   EDGEDESK SIGNAL GRAPHICS — the shareable research graphic for one Signal
   Center signal, drawn by the matchup graphic's own renderer.
   Browser: window.EDSignalGraphic. Node: require('./edgedesk_signal_graphic.js').
   docs/signal-center/GRAPHICS.md

   THE SAME PIPELINE, NOT A NEW ONE. lib/edgedesk_game_graphic.js draws every
   op: its kit (fitted text, panels, gradients), its night-stadium backdrop,
   the EdgeDesk lockup, the monogram badges, the footer with RESEARCH NOT
   PICKS., the canvas painter, the PNG and the cache. This file only builds a
   signal's content and arranges those parts; it registers its layout as
   G.LAYOUTS.signal_v1, so EDGameGraphic.renderContent draws it.

   DETERMINISTIC, FROM ONE PAYLOAD. content(payload) reads ONE immutable signal
   version (sc_signal_versions.payload) and nothing else: every number on the
   picture is a display string the engine already rounded once. The content
   carries that version's hash and is itself stored (sc_graphics.content) with
   its own SHA-256, so any graphic can be drawn again exactly and checked
   against the version it came from.

   THE RULES
     * No number is computed here, and none is invented: a missing value
       prints "—", never a guess.
     * Facts and estimates are kept apart: an injury graphic prints the
       designation as fact and a model effect only when one was calculated.
     * A model-version change says so; an unexplained move says EdgeDesk does
       not know yet; an Estimated simulator outcome carries ESTIMATED; Monte
       Carlo error is labelled sampling error only.
     * A disagreement is never an edge; the copy rule (EDSignalEngine.BANNED
       and EDGameGraphic.BANNED) is applied to every string.
     * No team logo: the monogram badge in the team's colours (neutral colours
       and initials when none are on file).
     * A graphic that is OUTDATED or WITHDRAWN is drawn with a band that says
       so; a fixture always says it is a controlled test input.

   TEMPLATES (template_version sg1)
     probability_shift     FORECAST_SHIFT
     market_disagreement   MARKET_DIVERGENCE, MARKET_CONVERGENCE, LINE_MOVEMENT
     injury_impact         INJURY_IMPACT
     simulator_movement    SIMULATION_SHIFT
     reliability_alert     MODEL_RELIABILITY_WARNING
     weekly_recap          recap(payloads): the week's highest-scoring signals
   FORMATS: square 1080×1080 (primary), landscape 1200×675, portrait 1080×1350.
   =========================================================================== */
(function (root, factory) {
  var node = typeof module === 'object' && module.exports;
  var G = node ? require('./edgedesk_game_graphic.js') : root.EDGameGraphic;
  var E = node ? require('./edgedesk_signal_engine.js') : root.EDSignalEngine;
  var api = factory(G, E);
  if (node) module.exports = api;
  if (root && root.document) root.EDSignalGraphic = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (G, E) {
  'use strict';
  if (!G) throw new Error('edgedesk_signal_graphic needs lib/edgedesk_game_graphic.js loaded first');
  var SG = { VERSION: 'edgedesk_signal_graphic/1', TEMPLATE: 'signal_v1', TEMPLATE_VERSION: 'sg1' };
  SG.FORMATS = {
    square: { w: 1080, h: 1080, label: 'Square · 1080×1080' },
    landscape: { w: 1200, h: 675, label: 'Landscape · 1200×675' },
    portrait: { w: 1080, h: 1350, label: 'Portrait · 1080×1350' }
  };
  SG.TEMPLATES = {
    FORECAST_SHIFT: 'probability_shift', MARKET_DIVERGENCE: 'market_disagreement', MARKET_CONVERGENCE: 'market_disagreement', LINE_MOVEMENT: 'market_disagreement',
    INJURY_IMPACT: 'injury_impact', SIMULATION_SHIFT: 'simulator_movement', MODEL_RELIABILITY_WARNING: 'reliability_alert'
  };
  SG.KICKER = {
    FORECAST_SHIFT: 'MODEL PROBABILITY SHIFT', MARKET_DIVERGENCE: 'MODEL VS MARKET', MARKET_CONVERGENCE: 'MARKET CONVERGENCE', LINE_MOVEMENT: 'LINE MOVEMENT',
    INJURY_IMPACT: 'AVAILABILITY UPDATE', SIMULATION_SHIFT: 'SIMULATOR MOVEMENT', MODEL_RELIABILITY_WARNING: 'MODEL RELIABILITY ALERT', RECAP: 'WEEKLY RESEARCH RECAP'
  };
  /* the header's right-hand label: short, so the lockup keeps its size */
  SG.SPORT_SHORT = { nfl: 'NFL', cfb: 'CFB', nba: 'NBA', nhl: 'NHL', mlb: 'MLB', wnba: 'WNBA', ncaam: 'NCAAM', mma: 'UFC', college_baseball: 'NCAA BASEBALL', all: 'ALL SPORTS' };
  SG.SPORT_LABEL = { nfl: 'NFL', cfb: 'COLLEGE FOOTBALL', nba: 'NBA', nhl: 'NHL', mlb: 'MLB', wnba: 'WNBA', ncaam: 'MEN’S COLLEGE BASKETBALL', mma: 'UFC', college_baseball: 'COLLEGE BASEBALL', all: 'ALL SPORTS' };
  SG.STAMPS = {
    OUTDATED: 'OUTDATED · A NEWER VERSION OF THIS SIGNAL EXISTS',
    WITHDRAWN: 'WITHDRAWN · NOT CURRENT RESEARCH',
    FIXTURE: 'CONTROLLED TEST INPUT · NOT A REAL EVENT',
    EXAMPLE: 'EXAMPLE FROM PUBLISHED HISTORY · NOT CURRENT RESEARCH'
  };
  var NEUTRAL = { color: '#3b4a6b', alt: '#8aa0c8', on: '#ffffff' };

  function str(x) { return x === null || x === undefined ? '' : String(x); }
  function up(x) { return str(x).toUpperCase(); }
  function num(x) { var n = Number(x); return x === null || x === undefined || x === '' || !isFinite(n) ? null : n; }
  function stamp(t) { return t ? (G.stamp(t) || str(t)) : null; }
  function dash(x) { return x === null || x === undefined || x === '' ? '—' : String(x); }
  function hex(h) { return /^#?[0-9a-f]{6}$/i.test(str(h)) ? (str(h).charAt(0) === '#' ? str(h) : '#' + h) : null; }
  function initials(name) {
    var w = str(name).replace(/[()'’.]/g, ' ').split(/\s+/).filter(Boolean);
    if (!w.length) return '?';
    if (w.length === 1) return w[0].slice(0, 4).toUpperCase();
    return w.map(function (x) { return x.charAt(0).toUpperCase(); }).join('').slice(0, 4);
  }
  /* a team's badge: the colours the payload or the resolver has, else neutral */
  function teamStyle(t, resolver, sport) {
    t = t || {};
    var r = resolver ? resolver(sport, t) : null;
    var color = hex(t.color) || (r && hex(r.color)) || NEUTRAL.color, alt = hex(t.alt) || hex(t.alt_color) || (r && hex(r.alt)) || NEUTRAL.alt;
    var on = hex(t.on) || hex(t.on_color) || (r && hex(r.on)) || NEUTRAL.on;
    var abbr = str(t.abbr || (r && r.abbr) || initials(t.name)).toUpperCase().slice(0, 5) || '?';
    return { name: up(t.name || abbr), short: up(t.name || abbr), abbr: abbr, color: color, alt: alt, on: on, colors_source: (t.color || (r && r.color)) ? 'on file' : 'neutral (no colours on file)' };
  }
  /* "+7.6 PERCENTAGE POINTS" with the engine's own one-decimal rounding */
  function ppWords(v) {
    v = num(v);
    if (v === null) return '—';
    var a = Math.abs(v).toFixed(1);
    return (v > 0 ? '+' : (v < 0 ? '−' : '')) + a + (a === '1.0' ? ' PERCENTAGE POINT' : ' PERCENTAGE POINTS');
  }
  SG._ppWords = ppWords;
  function toneOf(v) { v = num(v); return v === null || v === 0 ? 'neutral' : (v > 0 ? 'up' : 'down'); }
  function pctOf(p) { p = num(p); return p === null ? '—' : (Math.round(p * 1000) / 10).toFixed(1) + '%'; }
  function surfaceOf(sport, kind) {
    if (kind === 'model' || kind === 'source') return 'none';
    return sport === 'nba' || sport === 'wnba' || sport === 'ncaam' ? 'court' : (sport === 'nhl' ? 'ice' : 'field');
  }

  SG.eligible = function (p) {
    if (!p || p.schema !== 'edgedesk_signal_v1') return { ok: false, reason: 'not a signal payload' };
    if (!SG.TEMPLATES[p.category]) return { ok: false, reason: 'no graphic template for ' + p.category };
    if (!p.verification || p.verification.state !== 'VERIFIED') return { ok: false, reason: 'only a VERIFIED signal gets a graphic' };
    if (!p.version_hash || !p.signal_key) return { ok: false, reason: 'the payload has no identity' };
    return { ok: true, template: SG.TEMPLATES[p.category] };
  };

  /* ================================================================ CONTENT */
  function common(p, opts) {
    var label = up(p.score && p.score.label || 'MONITOR');
    var sport = SG.SPORT_LABEL[p.sport] || up(p.sport);
    return {
      template: SG.TEMPLATE, template_version: SG.TEMPLATE_VERSION, kind: SG.TEMPLATES[p.category], category: p.category,
      signal_key: p.signal_key, version: opts.version || null, version_hash: p.version_hash, payload_sha256: opts.payload_sha256 || null,
      league_label: 'SIGNAL CENTER', week_label: SG.SPORT_SHORT[p.sport] || up(p.sport), tagline: G.TAGLINE,
      surface: surfaceOf(p.sport, p.subject && p.subject.kind), kicker: SG.KICKER[p.category] || 'SIGNAL',
      chip: { text: label, tone: label === 'MAJOR' ? 'major' : (label === 'NOTABLE' ? 'notable' : 'plain') },
      confidence: p.verification.state === 'VERIFIED' ? 'VERIFIED SIGNAL' : 'UNVERIFIED · NOT FOR PUBLICATION',
      status: label + ' · IMPORTANCE ' + Math.round(num(p.score && p.score.total) || 0) + '/100',
      status_tone: p.verification.state === 'VERIFIED' ? 'ok' : 'warn',
      snapshot_line: p.signal_key + (opts.version ? ' v' + opts.version : '') + ' · detected ' + dash(stamp(p.detected_at)) + ' · ' + G.SITE,
      file_stem: 'signal-' + str(p.signal_key).replace(/^sc1-/, '') + (opts.version ? '-v' + opts.version : ''),
      fixture: !!p.fixture
    };
  }
  function eventLine(p) {
    var ev = p.event || {};
    return [ev.label ? up(ev.label) : null, ev.at ? up(stamp(ev.at)) : null].filter(Boolean).join(' · ');
  }
  function subjectTeam(p, opts) {
    var ev = p.event || {}, side = p.subject && p.subject.side;
    var t = side && ev[side] ? ev[side] : { name: p.subject && (p.subject.team || p.subject.label) };
    return teamStyle(t, opts.teamStyle, p.sport);
  }

  var BUILD = {
    probability_shift: function (p, c, opts) {
      var v = p.values || {}, vc = p.subtype === 'model_version_change';
      c.subject = { kind: 'team', name: up(p.subject.label), team: subjectTeam(p, opts), sub: (vc ? 'FORECAST AFTER A MODEL VERSION CHANGE' : 'WIN PROBABILITY UPDATE') + (eventLine(p) ? ' · ' + eventLine(p) : '') };
      c.numbers = { mode: 'pair', left: { label: 'PREVIOUS', value: dash(v.previous && v.previous.display), sub: dash(stamp(v.previous && v.previous.at)) },
        right: { label: 'UPDATED', value: dash(v.current && v.current.display), sub: dash(stamp(v.current && v.current.at)) },
        change: { label: 'CHANGE', text: ppWords(v.change_pp), tone: toneOf(v.change_pp) } };
      c.why = { title: 'WHY IT CHANGED', chip: up(p.evidence.label), text: p.evidence.summary };
      var d = v.distribution || {};
      c.meta = [
        'MODEL ' + dash(p.model && p.model.version) + (vc && p.model.previous_version ? ' (was ' + p.model.previous_version + ')' : ''),
        'SOURCE ' + dash(p.sources && p.sources[0] && p.sources[0].label) + ' · snapshots ' + dash(v.previous && v.previous.snapshot_id) + ' → ' + dash(v.current && v.current.snapshot_id),
        d.rarity !== null && d.rarity !== undefined ? up('this move is ' + E.rarityWords({ value: d.rarity, reference_n: d.reference_n })) : 'RARITY NOT SCORED: ' + up(d.note || 'no reference')
      ];
    },
    market_disagreement: function (p, c, opts) {
      var v = p.values || {}, m = p.market || {};
      c.subject = { kind: 'team', name: up(p.subject.label), team: subjectTeam(p, opts), sub: eventLine(p) || up(p.outcome && p.outcome.label) };
      if (p.category === 'MARKET_DIVERGENCE') {
        c.numbers = { mode: 'versus', left: { label: 'EDGEDESK MODEL', value: dash(v.current && v.current.display), sub: 'win probability · ' + dash(stamp(v.current && v.current.at)) },
          right: { label: up(m.book || 'market') + ' · NO-VIG', value: dash(v.previous && v.previous.display), sub: 'moneyline ' + (m.moneyline ? fmtAm(m.moneyline.home) + ' / ' + fmtAm(m.moneyline.away) : '—') + ' · ' + dash(stamp(m.captured_at)) },
          change: { label: 'DIFFERENCE', text: ppWords(v.change_pp), tone: 'neutral' } };
        c.why = { title: 'WHAT THIS IS, AND IS NOT', chip: 'OBSERVED DISAGREEMENT', text: p.evidence.summary };
        c.meta = [
          'MARKET ' + dash(m.book) + ' via ' + dash(m.source_label || m.source) + ' · captured ' + dash(stamp(m.captured_at)) + ' · de-vig multiplicative · overround ' + (num(m.overround) === null ? '—' : (m.overround * 100).toFixed(1) + '%'),
          'MODEL ' + dash(p.model && p.model.version) + (p.model && p.model.validation && p.model.validation.market_test ? ' · market test ' + p.model.validation.market_test : ''),
          'NOT A BETTING RECOMMENDATION · SIGNAL CENTER DOES NOT SAY WHICH NUMBER IS RIGHT'
        ];
      } else if (p.category === 'MARKET_CONVERGENCE') {
        c.numbers = { mode: 'pair', left: { label: 'GAP WAS', value: dash(v.previous && v.previous.display), sub: dash(stamp(v.previous && v.previous.at)) },
          right: { label: 'GAP NOW', value: dash(v.current && v.current.display), sub: dash(stamp(v.current && v.current.at)) },
          change: { label: 'MOVED', text: 'MODEL ' + ppWords(v.model_moved_pp).replace(' PERCENTAGE POINTS', ' PP').replace(' PERCENTAGE POINT', ' PP') + ' · MARKET ' + ppWords(v.market_moved_pp).replace(' PERCENTAGE POINTS', ' PP').replace(' PERCENTAGE POINT', ' PP'), tone: 'neutral' } };
        c.why = { title: 'WHAT CHANGED', chip: 'OBSERVED', text: p.evidence.summary };
        c.meta = ['MARKET ' + dash(m.book) + ' · captured ' + dash(stamp(m.captured_at)), 'MODEL ' + dash(p.model && p.model.version), 'MOVEMENT IS MEASURED, NOT EXPLAINED'];
      } else {
        c.numbers = { mode: 'pair', left: { label: 'PREVIOUS · NO-VIG', value: dash(v.previous && v.previous.display), sub: dash(stamp(v.previous && v.previous.at)) },
          right: { label: 'CURRENT · NO-VIG', value: dash(v.current && v.current.display), sub: dash(stamp(v.current && v.current.at)) },
          change: { label: 'CHANGE', text: ppWords(v.change_pp), tone: toneOf(v.change_pp) } };
        c.why = { title: 'WHAT CHANGED', chip: 'OBSERVED', text: p.evidence.summary };
        c.meta = ['MARKET ' + dash(m.book) + ' via ' + dash(m.source_label || m.source) + ' · same book, two captures', 'A PRICE MOVE IS NEVER READ AS INFORMATION ABOUT THE GAME'];
      }
    },
    injury_impact: function (p, c, opts) {
      var v = p.values || {}, s = p.subject || {}, fe = p.facts_vs_estimates || {};
      c.subject = { kind: 'player', name: up(s.label), team: teamStyle({ name: s.team }, opts.teamStyle, p.sport), sub: [s.position, up(s.team), eventLine(p)].filter(Boolean).join(' · ') };
      var bare = function (t) { return up(dash(t)).replace(/^AN? /, ''); };
      c.numbers = { mode: 'status', left: { label: 'PREVIOUS', value: bare(v.previous && v.previous.display), sub: dash(stamp(v.previous && v.previous.at)) },
        right: { label: 'CURRENT DESIGNATION', value: bare(v.current && v.current.display), sub: 'published ' + dash(stamp(p.timestamps && p.timestamps.source_published_at)) },
        change: { label: 'ESTIMATED MODEL EFFECT', text: p.model && p.model.effect_calculated && num(v.change_pp) !== null ? ppWords(v.change_pp) + ' (AN ESTIMATE)' : 'NOT CALCULATED', tone: 'neutral' } };
      c.why = { title: 'THE FACTS', chip: 'SOURCE-DATED', text: (fe.facts || []).join(' ') };
      c.meta = [
        'SOURCE ' + dash(p.sources && p.sources[0] && p.sources[0].label) + ' · published ' + dash(stamp(p.timestamps && p.timestamps.source_published_at)),
        'ESTIMATE ' + (fe.estimate || 'none: no per-player availability computation isolates this designation'),
        p.sources && p.sources[0] && p.sources[0].ref ? 'URL ' + p.sources[0].ref : 'FACTS ARE THE TEAM’S; ANY ESTIMATE IS THE MODEL’S'
      ];
    },
    simulator_movement: function (p, c, opts) {
      var v = p.values || {}, sm = p.simulation || {}, est = p.outcome && p.outcome.provenance === 'Estimated';
      c.subject = { kind: 'team', name: up(p.subject.label), team: teamStyle({ name: p.subject.label, abbr: p.subject.entity_id }, opts.teamStyle, p.sport),
        sub: up(str(p.outcome && p.outcome.label).replace(p.subject.label + ' ', '')) + ' PROBABILITY · ' + up(sm.competition) + ' ' + dash(sm.season) };
      if (est) c.flag = { text: 'ESTIMATED', tone: 'warn' };
      c.numbers = { mode: 'pair', left: { label: 'PREVIOUS RUN', value: dash(v.previous && v.previous.display), sub: 'inputs ' + dash(stamp(v.previous && v.previous.input_snapshot_at)) },
        right: { label: 'UPDATED RUN', value: dash(v.current && v.current.display), sub: 'inputs ' + dash(stamp(v.current && v.current.input_snapshot_at)) },
        change: { label: 'CHANGE', text: ppWords(v.change_pp), tone: toneOf(v.change_pp) } };
      c.why = { title: 'WHY IT CHANGED', chip: up(p.evidence.label), text: p.evidence.summary + (sm.estimated_note ? ' ' + sm.estimated_note : '') };
      c.meta = [
        'SIMULATOR ' + dash(p.model && p.model.version) + ' · ' + (sm.n_sims ? (sm.n_sims[0] === sm.n_sims[1] ? thousands(sm.n_sims[1]) + ' simulations per run' : sm.n_sims.map(thousands).join(' then ') + ' simulations') : '—') + ' · EXPERIMENTAL (T3 research model)',
        up(v.sampling_note || ''),
        'RUNS ' + dash(sm.previous_run).slice(0, 8) + ' → ' + dash(sm.current_run).slice(0, 8)
      ];
    },
    reliability_alert: function (p, c) {
      var st = (p.values && p.values.statistic) || {};
      c.subject = { kind: 'model', name: up(p.model && p.model.label || p.subject.label), icon: 'bars', sub: 'MODEL RELIABILITY · ' + (SG.SPORT_LABEL[p.sport] || up(p.sport)) };
      if (p.subtype === 'calibration_band') {
        c.numbers = { mode: 'pair', left: { label: 'MODEL SAID', value: pctOf(st.mean_predicted), sub: Math.round(st.band[0] * 100) + '–' + Math.round(st.band[1] * 100) + '% band' },
          right: { label: 'OBSERVED', value: pctOf(st.observed), sub: '95% interval ' + pctOf(st.wilson_95 && st.wilson_95[0]) + '–' + pctOf(st.wilson_95 && st.wilson_95[1]) },
          change: { label: 'SAMPLE', text: st.n + ' GRADED GAMES', tone: 'neutral' } };
      } else if (p.subtype === 'behind_market') {
        c.numbers = { mode: 'versus', left: { label: 'MODEL BRIER', value: dash(st.model), sub: 'lower is better' }, right: { label: 'MARKET BRIER', value: dash(st.market), sub: 'de-vigged pregame market' },
          change: { label: 'SAME GAMES', text: st.n + ' VERIFIED GAMES · SAMPLE ' + dash(st.sample_state).replace(/_/g, ' '), tone: 'neutral' } };
      } else {
        c.numbers = { mode: 'pair', left: { label: 'SERVING VERSION', value: dash(st.version), sub: 'the model the board reads' }, right: { label: 'GRADED LIVE GAMES', value: String(st.n === undefined ? '—' : st.n), sub: 'for that version' },
          change: { label: 'EVIDENCE', text: 'BACKTEST ONLY, SO FAR', tone: 'neutral' } };
      }
      c.why = { title: 'RESEARCH IMPLICATION', chip: 'AUDIT FINDING', text: p.evidence.summary + ' ' + (p.research_implication || '') };
      var w = (p.evidence.items && p.evidence.items[0] && p.evidence.items[0].text) || '';
      c.meta = [w, 'SOURCE ' + dash(p.sources && p.sources[0] && p.sources[0].ref), 'AN AUDIT FINDING, NOT A VERDICT ON THE MODEL'];
    }
  };
  function thousands(n) { n = num(n); return n === null ? '—' : String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function fmtAm(a) { a = num(a); return a === null ? '—' : (a > 0 ? '+' : '−') + Math.abs(Math.round(a)); }

  /* content(payload, opts) -> { ok, content } | { ok: false, reason }
     opts: { version, payload_sha256 (the stored version's hash), teamStyle(sport, team) } */
  SG.content = function (p, opts) {
    opts = opts || {};
    var el = SG.eligible(p);
    if (!el.ok) return { ok: false, reason: el.reason };
    var c = common(p, opts);
    BUILD[el.template](p, c, opts);
    c.alt = altOf(c, p);
    var bad = strings(c).filter(function (s) { return (E && !E.copyOk(s)) || G.BANNED.test(s); });
    if (bad.length) return { ok: false, reason: 'copy_rule', message: G.REASON_TEXT.copy_rule, detail: bad[0] };
    return { ok: true, content: c };
  };
  function strings(o, out) {
    out = out || [];
    if (typeof o === 'string') out.push(o);
    else if (o && typeof o === 'object') Object.keys(o).forEach(function (k) { if (k !== 'signal_key' && k !== 'version_hash' && k !== 'payload_sha256' && k !== 'file_stem') strings(o[k], out); });
    return out;
  }
  function altOf(c, p) {
    var n = c.numbers || {};
    var s = 'EdgeDesk Signal Center graphic, ' + c.kicker.toLowerCase() + ': ' + c.subject.name + '. ' + (c.subject.sub ? c.subject.sub + '. ' : '');
    if (n.mode !== 'list' && n.left) s += n.left.label + ' ' + n.left.value + ', ' + n.right.label + ' ' + n.right.value + ', ' + n.change.label + ' ' + n.change.text + '. ';
    s += c.why.title + ': ' + c.why.chip + '. ' + c.why.text + ' ' + c.status + '. Research, not picks.';
    return s;
  }

  /* the week's recap: the highest-scoring published signals, ranked by the
     documented importance score (E.SPEC), never by hand */
  SG.recap = function (payloads, opts) {
    opts = opts || {};
    var rows = (payloads || []).filter(function (p) { return p && p.verification && p.verification.state === 'VERIFIED' && !p.fixture && p.category !== 'DATA_QUALITY_WARNING'; })
      .sort(function (a, b) { return (b.score.total - a.score.total) || String(a.signal_key).localeCompare(String(b.signal_key)); }).slice(0, opts.top || 5);
    if (!rows.length) return { ok: false, reason: 'no verified signals in the window' };
    var sport = opts.sport || 'all';
    var c = {
      template: SG.TEMPLATE, template_version: SG.TEMPLATE_VERSION, kind: 'weekly_recap', category: 'RECAP',
      league_label: 'SIGNAL CENTER', week_label: (SG.SPORT_SHORT[sport] || up(sport)), tagline: G.TAGLINE, surface: 'none',
      kicker: SG.KICKER.RECAP, chip: { text: 'TOP ' + rows.length, tone: 'plain' },
      subject: { kind: 'recap', name: 'THE WEEK IN RESEARCH', sub: [opts.from ? up(stamp(opts.from)) : null, opts.to ? up(stamp(opts.to)) : null].filter(Boolean).join(' TO ') },
      numbers: { mode: 'list', rows: rows.map(function (p, i) { return { rank: i + 1, label: up(p.score.label), sport: SG.SPORT_LABEL[p.sport] || up(p.sport), text: p.headline, change: p.values && p.values.change_display ? p.values.change_display : '' }; }) },
      why: { title: 'HOW THIS IS RANKED', chip: 'SC_IMPORTANCE_V1', text: 'Ranked by EdgeDesk’s documented, rules-based importance score (magnitude, rarity, evidence, freshness, model reliability, relevance). It is not a probability and not a measure of profit.' },
      meta: ['RECAP OF ' + (payloads || []).length + ' SIGNALS · ' + rows.length + ' SHOWN', 'EVERY LINE IS ONE STORED, VERIFIED SIGNAL VERSION'],
      confidence: 'VERIFIED SIGNALS ONLY', status: 'WEEKLY RECAP', status_tone: 'ok',
      snapshot_line: 'recap of ' + rows.map(function (p) { return p.signal_key.slice(4, 10); }).join(', ') + ' · built ' + dash(stamp(opts.now || null)) + ' · ' + G.SITE,
      file_stem: 'recap-' + (sport || 'all') + '-' + str(opts.to || '').slice(0, 10), signal_keys: rows.map(function (p) { return p.signal_key; }), version_hashes: rows.map(function (p) { return p.version_hash; })
    };
    c.alt = 'EdgeDesk Signal Center weekly research recap: ' + rows.map(function (r, i) { return (i + 1) + '. ' + r.headline; }).join('; ') + '. Research, not picks.';
    var bad = strings(c).filter(function (s) { return (E && !E.copyOk(s)) || G.BANNED.test(s); });
    if (bad.length) return { ok: false, reason: 'copy_rule', detail: bad[0] };
    return { ok: true, content: c };
  };

  /* ================================================================ LAYOUT */
  var GEO = {
    square: { cols: 1, floor: 430, kicker: 150, subj: 176, subjH: 160, badgeR: 60, nums: 352, numsH: 262, why: 632, whyH: 276, meta: 920, metaH: 98, footer: 1053, big: 116, whyLines: 5, whySize: 25 },
    portrait: { cols: 1, floor: 520, kicker: 168, subj: 196, subjH: 196, badgeR: 76, nums: 410, numsH: 304, why: 734, whyH: 388, meta: 1140, metaH: 118, footer: 1300, big: 132, whyLines: 8, whySize: 27 },
    landscape: { cols: 2, floor: 330, kicker: 164, subj: 182, subjH: 108, badgeR: 44, nums: 304, numsH: 250, why: 138, whyH: 292, meta: 442, metaH: 150, footer: 638, big: 88, whyLines: 6, whySize: 21 }
  };
  SG.GEO = GEO;
  SG.layout = function (c, format, measure) {
    format = SG.FORMATS[format] ? format : 'square';
    var FMT = SG.FORMATS[format], W = FMT.w, H = FMT.h, g = GEO[format], K = G.K;
    var k = G.kit(measure), ops = k.ops, text = k.text, rect = k.rect, lin = k.lin, panel = k.panel, P = 24;
    G.backdrop(k, W, H, g.floor, c.surface);
    G.lockup(k, c, W, format === 'portrait' ? 'portrait' : 'square');

    var L = g.cols === 2 ? { x: P, w: 560 } : { x: P, w: W - 2 * P };
    var R = g.cols === 2 ? { x: P + 560 + 16, w: W - 3 * P - 560 + 8 } : L;
    var toneColor = function (t) { return t === 'up' ? K.cyan : (t === 'down' ? K.magenta : K.gold); };

    /* ---- kicker and label chip */
    /* the kicker never meets the chip: centred between two chip widths, or
       (landscape, under the lockup) left-aligned beside it */
    var chipW = 150, chipX = L.x + L.w - chipW, chipY = g.kicker - 30;
    if (format === 'landscape') text(c.kicker, L.x + (c.flag ? 186 : 0), g.kicker, 24, 800, K.cyan, 'left', L.w - chipW - 24 - (c.flag ? 186 : 0), true, 14, { spacing: 3 });
    else text(c.kicker, L.x + L.w / 2, g.kicker, 30, 800, K.cyan, 'center', L.w - 2 * (chipW + 24), true, 16, { spacing: 4 });
    rect(chipX, chipY, chipW, 40, c.chip.tone === 'major' ? lin(chipX, 0, chipX + chipW, 0, [[0, K.magenta], [1, K.violet]]) : (c.chip.tone === 'notable' ? 'rgba(42,212,255,0.85)' : 'rgba(130,160,230,0.35)'), { r: 10 });
    text(c.chip.text, chipX + chipW / 2, chipY + 29, 22, 800, c.chip.tone === 'notable' ? K.ink : K.text, 'center', chipW - 16, true, 12, { spacing: 2 });
    if (c.flag) {
      rect(L.x, chipY, 170, 40, 'rgba(251,191,36,0.92)', { r: 10 });
      text(c.flag.text, L.x + 85, chipY + 29, 22, 800, K.ink, 'center', 154, true, 12, { spacing: 2 });
    }

    /* ---- the subject: a badge (team, player's team), an icon (model) or nothing (recap) */
    var sy = g.subj, sh = g.subjH, br = g.badgeR, s = c.subject || {};
    var hasBadge = s.team && (s.kind === 'team' || s.kind === 'player');
    var nameX = L.x + (hasBadge || s.icon ? br * 2 + 36 : 0), nameW = L.w - (nameX - L.x);
    if (hasBadge) G.badge(k, s.team, L.x + br + 12, sy + sh / 2, br);
    else if (s.icon) ops.push({ type: 'icon', name: s.icon, x: L.x + 12, y: sy + sh / 2 - br, size: br * 2, color: K.cyan });
    /* the name on one line down to 60% of its size; a longer one wraps to two
       lines rather than shrink past legibility, and its subtitle keeps one */
    var nameSize = format === 'portrait' ? 78 : (format === 'landscape' ? 54 : 70), shadow = { shadow: { color: 'rgba(0,0,0,0.6)', blur: 10 } };
    var one = k.fitWrap(s.name, nameSize, 800, true, nameW, 1, Math.round(nameSize * 0.6));
    var nameFit = k.tw(one.lines[0], one.size, 800, true) <= nameW && one.lines[0].slice(-1) !== '…' ? one : k.fitWrap(s.name, Math.round(nameSize * 0.72), 800, true, nameW, 2, 20);
    var subLines = nameFit.lines.length > 1 ? 1 : 2;
    var subSize = format === 'landscape' ? 18 : 22;
    var blockH = nameFit.lines.length * nameFit.size * 1.02 + (s.sub ? subLines * (subSize + 6) + 10 : 0);
    var ny0 = sy + Math.max(nameFit.size, (sh - blockH) / 2 + nameFit.size * 0.92);
    var nm = null;
    nameFit.lines.forEach(function (l, i) { nm = text(l, nameX, ny0 + i * nameFit.size * 1.02, nameFit.size, 800, K.text, 'left', nameW, true, 18, shadow); });
    if (s.sub) {
      /* break between the subtitle's parts ("A AT B · OCT 25, 4:30 PM ET"), never inside one */
      var parts = String(s.sub).split(' · '), sw = null;
      for (var ss = subSize; ss >= 13 && !sw; ss--) {
        var ls = [], cur = '';
        parts.forEach(function (pt) { var t = cur ? cur + ' · ' + pt : pt; if (!cur || k.tw(t, ss, 700, true) <= nameW) cur = t; else { ls.push(cur); cur = pt; } });
        if (cur) ls.push(cur);
        if (ls.length <= subLines && ls.every(function (l) { return k.tw(l, ss, 700, true) <= nameW; })) sw = { size: ss, lines: ls };
      }
      if (!sw) sw = k.fitWrap(s.sub, subSize, 700, true, nameW, subLines, 12);
      sw.lines.forEach(function (l, i) { text(l, nameX, nm.y + Math.round(sw.size * 1.45) + i * (sw.size + 6), sw.size, 700, '#9fd8ff', 'left', nameW, true, 11); });
    }

    /* ---- the numbers */
    var n = c.numbers || {}, ny = g.nums, nh = g.numsH;
    if (n.mode === 'list') {
      var top = format === 'landscape' ? g.why : ny, bottom = format === 'landscape' ? g.meta + g.metaH : g.why + g.whyH;
      var lx = format === 'landscape' ? P : L.x, lwid = W - 2 * P;
      panel(lx, top, lwid, bottom - top, 'THE LARGEST VERIFIED CHANGES', null);
      var rowsN = n.rows.length, rowH = Math.min(format === 'landscape' ? 74 : 96, (bottom - top - 76) / Math.max(1, rowsN));
      n.rows.forEach(function (r, i) {
        var y = top + 76 + i * rowH;
        text(String(r.rank), lx + 30, y + rowH * 0.6, Math.round(rowH * 0.55), 800, K.cyan, 'left', 60, true, 18);
        text(r.label + ' · ' + r.sport, lx + 90, y + rowH * 0.34, format === 'landscape' ? 15 : 17, 700, K.faint, 'left', lwid - 300, false, 11, { spacing: 1 });
        var tl = k.fitWrap(r.text, format === 'landscape' ? 21 : 26, 700, false, lwid - 300, 1, 13);
        text(tl.lines[0], lx + 90, y + rowH * 0.34 + tl.size + 8, tl.size, 700, K.text, 'left', lwid - 300, false, 12);
        if (r.change) text(r.change, lx + lwid - 30, y + rowH * 0.62, Math.round(rowH * 0.42), 800, K.gold, 'right', 210, true, 16);
        if (i < rowsN - 1) ops.push({ type: 'line', x0: lx + 24, y0: y + rowH - 2, x1: lx + lwid - 24, y1: y + rowH - 2, color: K.line, width: 1 });
      });
    } else {
      panel(L.x, ny, L.w, nh, null, null);
      var half = L.w / 2, lab = format === 'landscape' ? 18 : 22, big = g.big;
      if (n.mode === 'status') big = Math.round(big * 0.62);
      [['left', L.x + half / 2], ['right', L.x + half + half / 2]].forEach(function (sd) {
        var col = n[sd[0]];
        text(col.label, sd[1], ny + 46, lab, 800, K.faint, 'center', half - 30, true, 12, { spacing: 3 });
        text(col.value, sd[1], ny + 46 + big * 0.95, big, 800, sd[0] === 'right' && n.mode !== 'versus' ? K.text : K.dim, 'center', half - 36, true, 16,
          { shadow: { color: 'rgba(42,212,255,0.40)', blur: 16 } });
        if (col.sub) text(col.sub, sd[1], ny + 46 + big * 0.95 + (format === 'landscape' ? 28 : 34), format === 'landscape' ? 15 : 18, 600, K.dim, 'center', half - 30, false, 10);
      });
      ops.push({ type: 'line', x0: L.x + half, y0: ny + 28, x1: L.x + half, y1: ny + nh - 76, color: K.line, width: 2 });
      if (n.mode !== 'versus' && n.mode !== 'status') ops.push({ type: 'icon', name: 'bolt', x: L.x + half - 16, y: ny + 46 + big * 0.45, size: 32, color: K.cyan });
      var cy = ny + nh - 26;
      rect(L.x + 16, ny + nh - 68, L.w - 32, 52, 'rgba(18,40,92,0.85)', { r: 12 });
      var cl = text(n.change.label + ':', L.x + 36, cy, format === 'landscape' ? 20 : 24, 800, K.faint, 'left', 260, true, 12, { spacing: 2 });
      text(n.change.text, L.x + 48 + Math.min(cl.width, 260), cy, format === 'landscape' ? 24 : 30, 800, toneColor(n.change.tone), 'left', L.w - 96 - Math.min(cl.width, 260), true, 13, { spacing: 1 });
    }

    /* ---- why / evidence */
    if (n.mode !== 'list') {
      var wy = g.why, wh = g.whyH;
      panel(R.x, wy, R.w, wh, c.why.title, null);
      var chipT = c.why.chip, cw2 = Math.min(R.w - 48, k.tw(chipT, 18, 800, true, { spacing: 2 }) + 34);
      rect(R.x + 24, wy + 72, cw2, 34, 'rgba(139,92,246,0.55)', { r: 8 });
      text(chipT, R.x + 24 + cw2 / 2, wy + 96, 18, 800, K.text, 'center', cw2 - 20, true, 11, { spacing: 2 });
      var room = wh - 132, wl = k.fitWrap(c.why.text, g.whySize, 500, false, R.w - 52, Math.max(1, Math.min(g.whyLines, Math.floor(room / (g.whySize * 0.75 + 7)))), 15);
      var maxL = Math.max(1, Math.floor(room / (wl.size + 7)));
      if (wl.lines.length > maxL) wl = { size: wl.size, lines: k.wrap(c.why.text, wl.size, 500, false, R.w - 52, maxL) };
      wl.lines.forEach(function (l, i) { text(l, R.x + 26, wy + 138 + i * (wl.size + 7), wl.size, 500, K.dim, 'left', R.w - 52, false, 12); });
    }

    /* ---- source, model and time: the strip that says what the numbers rest on */
    var my = g.meta, mh = g.metaH, mx = g.cols === 2 && n.mode !== 'list' ? R.x : L.x, mw = g.cols === 2 && n.mode !== 'list' ? R.w : L.w;
    if (!(n.mode === 'list' && format === 'landscape')) {
      rect(mx, my, mw, mh, 'rgba(8,16,40,0.78)', { r: 12, stroke: 'rgba(130,160,230,0.30)', lineWidth: 1 });
      var ml = (c.meta || []).filter(Boolean), lineH = Math.floor((mh - 18) / Math.max(1, ml.length));
      ml.forEach(function (t, i) {
        var mw2 = k.fitWrap(t, format === 'landscape' ? 15 : 16, 600, false, mw - 36, 1, 10);
        text(mw2.lines[0], mx + 18, my + 14 + (i + 1) * lineH - Math.round((lineH - mw2.size) / 2), mw2.size, 600, i === 0 ? K.text : K.dim, 'left', mw - 36, false, 10);
      });
    }

    /* ---- footer (the matchup graphic's own) */
    G.footer(k, c, W, g.footer);

    /* ---- what this picture is not: outdated, withdrawn, a fixture, an example */
    var band = c.stamp && SG.STAMPS[c.stamp] ? SG.STAMPS[c.stamp] : (c.fixture ? SG.STAMPS.FIXTURE : null);
    if (band) {
      var by = Math.round(H * 0.44);
      rect(0, by, W, 86, c.stamp === 'WITHDRAWN' ? 'rgba(127,29,29,0.92)' : 'rgba(120,53,15,0.92)', {});
      text(band, W / 2, by + 56, format === 'landscape' ? 30 : 34, 800, '#fff7ed', 'center', W - 60, true, 16, { spacing: 2 });
    }
    return { width: W, height: H, format: format, ops: ops };
  };
  G.LAYOUTS[SG.TEMPLATE] = SG.layout;

  /* every text op inside the canvas and inside its own width; legible sizes */
  SG.check = function (L) {
    var bad = [];
    L.ops.forEach(function (o, i) {
      if (o.type !== 'text') return;
      var left = o.align === 'center' ? o.x - o.width / 2 : (o.align === 'right' ? o.x - o.width : o.x);
      if (left < -1 || left + o.width > L.width + 1) bad.push({ i: i, text: o.text, problem: 'outside the canvas horizontally' });
      if (o.y - o.size * 0.8 < -1 || o.y + o.size * 0.25 > L.height + 1) bad.push({ i: i, text: o.text, problem: 'outside the canvas vertically' });
      if (o.maxW && o.width > o.maxW + 1) bad.push({ i: i, text: o.text, problem: 'wider than its box' });
      if (o.size < 9) bad.push({ i: i, text: o.text, problem: 'smaller than 9 px' });
    });
    return bad;
  };

  /* ================================================================ BROWSER */
  /* render(content, format, { stamp }) -> the renderer's { canvas, blob, url, alt, file_name } */
  SG.render = function (c, format, opts) {
    opts = opts || {};
    format = SG.FORMATS[format] ? format : 'square';
    var cc = opts.stamp ? Object.assign({}, c, { stamp: opts.stamp }) : c;
    var key = [SG.VERSION, c.signal_key || c.file_stem, c.version_hash || (c.version_hashes || []).join('+'), opts.stamp || 'current'].join('|');
    return G.renderContent(cc, key, format, { formats: SG.FORMATS, fresh: opts.fresh });
  };
  return SG;
});
