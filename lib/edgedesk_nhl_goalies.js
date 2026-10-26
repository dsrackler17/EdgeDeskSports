/* ===========================================================================
   EDGEDESK NHL GOALIES — the goalie block of an NHL game card.

   Browser and Node (window.EDNHLGoalies / module.exports). Pure apart from
   load(): it lays out what the starter sync recorded (rpc/nhl_goalie_card,
   supabase/nhl_goalie_layer.sql) and never computes a probability.

     load(gameId)        the live card for one game, from Supabase with the
                         public key (cached a minute); null when the layer is
                         not reachable
     fromSlate(g, slate) the same shape built from hockey/slate.json's goalie
                         block, when the live layer has not answered: the
                         usage projection (Projected) or a manual confirmation
     html(res, g, o)     the block

   THE DISPLAY RULES (docs/engine/NHL_GOALIES.md; the provenance rules: every
   value says what it is and where it came from)
     * each starter with a status badge — Confirmed / Likely / Projected (or
       Unknown) — its source and its "as of" time; Daily Faceoff, the NHL's
       boxscore and a manual entry are Observed (T0), EdgeDesk's usage
       projection is T2 and says so;
     * unless BOTH are Confirmed (and no source disagrees), the full pairing
       range: win % and fair line for every realistic pairing, and the Known
       Limitations line "Starter not confirmed. Numbers may change.";
     * a starter that changed after the card first posted: "Updated: starter
       changed from X to Y" with both versions' win %;
     * a single goalie is never shown as fact unless Confirmed;
     * the headline price (the production model) carries no goalie term, and
       the block says so: the pairing numbers are its goalie-aware variant.
   =========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.EDNHLGoalies = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (W) {
  'use strict';
  var VERSION = 'edgedesk_nhl_goalies_ui_v1';
  var NOT_CONFIRMED = 'Starter not confirmed. Numbers may change.';
  var TTL = 60000;
  var BADGE = { confirmed: ['Confirmed', 'ok'], likely: ['Likely', 'ok2'], projected: ['Projected', 'warn'], unknown: ['Unknown', 'none'] };
  var SOURCES = {
    daily_faceoff: ['Daily Faceoff', 'T0'], nhl_api_boxscore: ['NHL.com game boxscore', 'T0'], manual: ['Manual entry', 'T0'],
    edgedesk_projection: ['EdgeDesk usage projection', 'T2'], slate: ['the slate (EdgeDesk usage projection)', 'T2']
  };
  var cache = {};

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function num(v) { if (v === null || v === undefined || v === '') return null; var n = Number(v); return isFinite(n) ? n : null; }
  function pct(v) { var n = num(v); return n == null ? '—' : (Math.round(n * 1000) / 10).toFixed(1) + '%'; }
  function am(v) { var n = num(v); return n == null ? '—' : (n > 0 ? '+' : '') + Math.round(n); }
  function p2am(p) { var n = num(p); if (n == null || !(n > 0 && n < 1)) return null; var d = 1 / n; return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)); }
  function chip(t, cls, title) { return '<span class="xe-chip ' + (cls || '') + '"' + (title ? ' title="' + esc(title) + '"' : '') + '>' + esc(t) + '</span>'; }
  var ETF = null;
  try { ETF = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch (e) { ETF = null; }
  function et(iso) { var t = Date.parse(iso); if (!isFinite(t)) return null; return ETF ? ETF.format(new Date(t)) + ' ET' : new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'; }

  /* ------------------------------------------------------------ the live card */
  function sb() { return W && W.SB_URL && W.SB_KEY ? { url: String(W.SB_URL).replace(/\/$/, ''), key: W.SB_KEY } : null; }
  function load(gameId, force) {
    var k = String(gameId), c = cache[k];
    if (c && c.loading) return c.loading;
    if (c && !force && Date.now() - c.at < TTL) return Promise.resolve(c.data);
    var s = sb();
    if (!s || typeof fetch !== 'function') { cache[k] = { data: null, err: 'the starter sync is not reachable from this page', at: Date.now() }; return Promise.resolve(null); }
    var h = { apikey: s.key, authorization: 'Bearer ' + s.key, 'content-type': 'application/json' };
    var p = fetch(s.url + '/rest/v1/rpc/nhl_goalie_card', { method: 'POST', headers: h, body: JSON.stringify({ p_game_id: k }) })
      .then(function (r) { if (!r.ok) throw new Error('the starter sync answered HTTP ' + r.status + (r.status === 404 ? ' (the NHL goalie layer is not deployed)' : '')); return r.json(); })
      .then(function (d) { if (!d || !d.state) throw new Error('the starter sync answered without a state'); cache[k] = { data: d, err: null, at: Date.now() }; return d; })
      /* .catch, not .then's second argument: an answer with no state is the card's error too, never a
         rejection left unhandled with the card stuck "loading" (tools/hockey/nhl_goalie_ui.test.js) */
      .catch(function (e) { cache[k] = { data: null, err: (e && e.message) || 'could not be read', at: Date.now() }; return null; });
    cache[k] = { data: c ? c.data : null, err: c ? c.err : null, at: c ? c.at : 0, loading: p };
    return p;
  }
  function state(gameId) { var c = cache[String(gameId)]; return c ? { data: c.data, err: c.err, loading: !!c.loading } : { data: null, err: null, loading: false }; }
  /** the live answer when it holds a card, else the slate's own block */
  function resolve(g, slate) {
    var st = state(g.game_id);
    if (st.data && st.data.card) return st.data;
    var f = fromSlate(g, slate);
    f.live_error = st.err || (st.data && st.data.state === 'NO_CARD' ? 'the starter sync has no card for this game yet' : null);
    return f;
  }

  /* ------------------------------------------------------------ the slate's own block, in the same shape */
  function fromSlate(g, slate) {
    var G = (g && g.goalies) || {}, cert = String(G.certainty || '');
    var conf = cert === 'CONFIRMED' && G.confirmed_source;
    var side = function (s) {
      var L = (G[s] || []).slice().sort(function (a, b) { return (num(b.p_start) || 0) - (num(a.p_start) || 0); })[0];
      if (!L) return { goalie_id: null, goalie_name: null, status: 'unknown', source: null, basis: 'none' };
      return conf && L.confirmed
        ? { goalie_id: String(L.goalie), goalie_name: L.name, status: 'confirmed', source: 'manual', source_label: 'Manual entry (' + (G.confirmed_source.source || 'source on file') + ')', as_of: G.confirmed_source.recorded_at || null }
        : { goalie_id: String(L.goalie), goalie_name: L.name, status: 'projected', source: 'slate', p_start: num(L.p_start), as_of: (slate && slate.generated_at) || null, basis: 'projection' };
    };
    var P = { home: side('home'), away: side('away') };
    var both = P.home.status === 'confirmed' && P.away.status === 'confirmed';
    var top = function (s) { return P[s].goalie_id; };
    var range = (G.scenarios || []).map(function (x) {
      return { home_goalie_id: String(x.home_goalie), home_goalie_name: x.home_goalie_name, away_goalie_id: String(x.away_goalie), away_goalie_name: x.away_goalie_name, p_home: num(x.p_home),
        fair_home: x.fair_home != null ? x.fair_home : p2am(x.p_home), fair_away: x.fair_away != null ? x.fair_away : p2am(1 - x.p_home), exp_total: num(x.exp_total), fair_total_line: x.fair_total_line != null ? x.fair_total_line : null,
        puck_line: x.puck_line || null, total: x.total || null, p_scenario: num(x.p_scenario), used: String(x.home_goalie) === top('home') && String(x.away_goalie) === top('away') };
    });
    var used = range.filter(function (x) { return x.used; })[0] || null;
    var lim = [];
    if (!both) lim.push(NOT_CONFIRMED);
    ['home', 'away'].forEach(function (s) { if (P[s].basis === 'projection') lim.push('No starter report is on file for ' + g[s] + ': ' + (P[s].goalie_name || 'the likeliest goalie') + ' is EdgeDesk’s usage projection' + (P[s].p_start != null ? ' (' + Math.round(P[s].p_start * 100) + '% to start)' : '') + '.'); });
    return {
      state: 'SLATE', freshness: 'SLATE', versions: 0,
      card: { game_id: String(g.game_id), version: null, generated_at: (slate && slate.generated_at) || null, home: g.home, away: g.away, goalie_pairing_used: P,
        goalie_status_home: P.home.status, goalie_status_away: P.away.status, conflict: false, show_range: !both, edge_gate_state: both ? 'OPEN' : 'GATED',
        pairing_range: range, pairing_price: used, known_limitations: lim, change_note: null,
        notes: ['The headline numbers are the production model, which carries no goalie term; the pairing numbers are its goalie-aware variant (the slate’s goalie scenarios).'] }
    };
  }

  /* ------------------------------------------------------------ the block */
  function srcText(p) {
    var s = SOURCES[p.source] || null;
    var label = p.source_label || (s ? s[0] : (p.source || 'no source'));
    var tier = s ? s[1] : (p.source ? 'T0' : null);
    var at = et(p.as_of || p.source_updated_at);
    return (tier ? chip(tier, 'tier', tier === 'T0' ? 'Observed: reported by the source, stored as reported' : 'EdgeDesk’s own estimate (recent starts and the back-to-back rule), not a report') + ' ' : '')
      + esc(label) + (at ? ' · as of ' + esc(at) : '') + (p.p_start != null ? ' · ' + Math.round(p.p_start * 100) + '% to start' : '');
  }
  function sideRow(team, p) {
    var b = BADGE[p.status] || BADGE.unknown;
    return '<div class="xe-row xe-gl"><span class="k">' + esc(team) + '</span><span class="v"><b>' + esc(p.goalie_name || 'No starter named') + '</b> ' + chip(b[0], b[1], 'starter status: ' + b[0]) +
      (p.conflict ? ' ' + chip('sources disagree', 'bad', (p.conflict_detail || []).map(function (c) { return (c.goalie_name || '?') + ' per ' + ((SOURCES[c.source] || [c.source])[0]) + ' (' + c.status + ')'; }).join(' vs ')) : '') +
      '</span><span class="xe-dim">' + srcText(p) + '</span></div>';
  }
  function html(res, g, o) {
    o = o || {};
    if (!res || !res.card) return '';
    var c = res.card, P = c.goalie_pairing_used || {}, H = g.home, A = g.away;
    var both = c.goalie_status_home === 'confirmed' && c.goalie_status_away === 'confirmed' && !c.conflict;
    var out = '<section class="xe-goalies" aria-label="Starting goalies"><div class="xe-sechd"><span>Starting goalies</span><span class="r">' +
      (res.state === 'SLATE' ? 'from the slate' : 'card version ' + esc(c.version) + (c.generated_at ? ' · ' + esc(et(c.generated_at)) : '')) + '</span></div>';
    if (res.freshness === 'FAILED' || res.freshness === 'STALE') out += '<div class="xe-banner warn" role="status"><b>Starter status may be out of date.</b> ' + esc(res.reason || 'the starter sync has not checked recently') + '.</div>';
    if (res.state === 'SLATE' && res.live_error) out += '<p class="xe-dim">The live starter sync did not answer (' + esc(res.live_error) + '); this is the slate’s own goalie block.</p>';
    out += sideRow(A, P.away || {}) + sideRow(H, P.home || {});
    var n = c.change_note;
    if (n && n.text) {
      out += '<div class="xe-banner info" role="status"><b>' + esc(n.text) + '.</b> ' + esc(H) + ' ' + pct(n.first_p_home) + ' under version ' + esc(n.first_version || 1) +
        (n.first_generated_at ? ' (' + esc(et(n.first_generated_at)) + ')' : '') + ' → ' + pct(n.current_p_home) + ' now, each with the pairing it used (goalie-aware variant).</div>';
    }
    var R = (c.pairing_range || []).slice().sort(function (a, b) { return (num(a.p_home) || 0) - (num(b.p_home) || 0); });
    if (!both || c.show_range) {
      var ps = R.map(function (x) { return num(x.p_home); }).filter(function (x) { return x != null; });
      out += '<p>Not every starter is Confirmed, so the number is a range: ' + esc(H) + ' ' + (ps.length ? pct(Math.min.apply(null, ps)) + ' to ' + pct(Math.max.apply(null, ps)) : '—') + ' across ' + R.length + ' realistic pairing' + (R.length === 1 ? '' : 's') + '.</p>' +
        '<div class="xe-tw"><table class="xe-t"><caption>Every realistic pairing <span class="xe-dim">(goalie-aware variant)</span></caption><tr><th>' + esc(H) + ' goalie</th><th>' + esc(A) + ' goalie</th><th>' + esc(H) + ' wins</th><th>Fair ' + esc(H) + ' / ' + esc(A) + '</th><th>Total</th></tr>' +
        R.map(function (x) { return '<tr' + (x.used ? ' class="on"' : '') + '><td>' + esc(x.home_goalie_name || 'prior') + '</td><td>' + esc(x.away_goalie_name || 'prior') + '</td><td class="num">' + pct(x.p_home) + (x.used ? ' <span class="xe-dim" title="the pairing named above">(above)</span>' : '') + '</td><td class="num">' + am(x.fair_home) + ' / ' + am(x.fair_away) + '</td><td class="num">' + (x.exp_total == null ? '—' : x.exp_total) + '</td></tr>'; }).join('') +
        '</table></div>';
    } else if (c.pairing_price) {
      var u = c.pairing_price;
      out += '<p>With these starters <span class="xe-dim">(goalie-aware variant)</span>: ' + esc(H) + ' ' + pct(u.p_home) + ' · fair ' + esc(H) + ' ' + am(u.fair_home) + ' / ' + esc(A) + ' ' + am(u.fair_away) + (u.exp_total != null ? ' · total ' + u.exp_total : '') + '.</p>';
    }
    out += '<p class="xe-dim">Edge flag: ' + (both ? 'open — both starters are Confirmed.' : '<b>gated</b> — no EDGE on the moneyline, puck line or total unless it holds under every pairing above.') + '</p>';
    var L = c.known_limitations || [];
    if (L.length) out += '<div class="xe-k">Known limitations</div><ul class="xe-lim">' + L.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>';
    (c.notes || []).forEach(function (x) { out += '<p class="xe-note">' + esc(x) + '</p>'; });
    return out + '</section>';
  }

  /** what EDNHLMarket / EDNHLCompare read from this answer */
  function gateContext(res) {
    var c = res && res.card;
    if (!c) return null;
    return { goalie_status: { home: c.goalie_status_home, away: c.goalie_status_away, conflict: !!c.conflict }, pairings: c.pairing_range || [] };
  }

  return { VERSION: VERSION, NOT_CONFIRMED: NOT_CONFIRMED, load: load, state: state, resolve: resolve, fromSlate: fromSlate, html: html, gateContext: gateContext, _cache: cache };
});
