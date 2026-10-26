/* ===========================================================================
   EdgeDesk MODEL INTEGRITY — the reader's view of engine/model_integrity.json
   (tools/model_integrity/build.js; lib/edgedesk_model_integrity.js is the
   contract). The terminal only: the public page shows no EdgeDesk number.

     EDIntegrityUI.load()              reads the audit once (and again on a
                                       later call after INTERVAL); resolves
                                       to the file or null, never throws
     EDIntegrityUI.forEvent(id)        a Today's Games event id
                                       ('nba:espn:401909868') → its audit
     EDIntegrityUI.chipsHTML(a, max)   the warnings, as the board's chips
     EDIntegrityUI.detailHTML(a)       the matchup view's section: who and
                                       what the number assumed, the market it
                                       was compared with and when, which
                                       component raised each warning, and why
                                       the number differs from the market
     EDIntegrityUI.holdsSignal(a)      true when an input error, stale data or
                                       an unresolved critical input means no
                                       confident signal badge may show

   It renders what the audit says and nothing else: it computes no number,
   and a missing or unreadable file shows nothing rather than a guess.
   Browser only: window.EDIntegrityUI.
   =========================================================================== */
(function () {
  'use strict';
  var U = { VERSION: 'edgedesk_model_integrity_ui/1', URL: '/engine/model_integrity.json', INTERVAL: 10 * 60000 };
  var S = { file: null, byId: {}, at: 0, loading: null };
  var HOLD = { INPUT_ERROR: 1, STALE_DATA: 1, MISSING_CRITICAL_INPUT: 1 };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function when(t) { var v = Date.parse(t); if (!isFinite(v)) return '—'; try { return new Date(v).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch (_) { return new Date(v).toISOString(); } }
  function signed(x, d) { if (x == null || !isFinite(x)) return '—'; var r = Math.round(x * Math.pow(10, d || 1)) / Math.pow(10, d || 1); return (r > 0 ? '+' : r < 0 ? '−' : '') + Math.abs(r); }

  U.load = function (url) {
    if (S.loading) return S.loading;
    if (S.file && Date.now() - S.at < U.INTERVAL) return Promise.resolve(S.file);
    S.loading = fetch(url || U.URL, { cache: 'no-cache' }).then(function (r) { if (!r.ok) throw new Error('model_integrity.json ' + r.status); return r.json(); })
      .then(function (j) {
        if (!j || j.schema !== 'edgedesk_model_integrity_v1' || !Array.isArray(j.games)) throw new Error('model_integrity.json is not in the expected format');
        var by = {}; j.games.forEach(function (g) { if (g && g.slate_id) by[g.slate_id] = g; });
        S.file = j; S.byId = by; S.at = Date.now();
        return j;
      }).catch(function () { return S.file; }).then(function (j) { S.loading = null; return j; });
    return S.loading;
  };
  U.forEvent = function (id) { return id && S.byId[id] || null; };
  U.holdsSignal = function (a) { return !!(a && (a.codes || []).some(function (c) { return HOLD[c]; })); };

  /* the board's chips: the audit's own labels, in its precedence order */
  U.chipsHTML = function (a, max) {
    if (!a || !a.chips || !a.chips.length) return '';
    return a.chips.slice(0, max || 2).map(function (c) {
      var why = (a.classifications || []).filter(function (x) { return x.chip === c.label; }).map(function (x) { return x.message; }).join(' ');
      return '<span class="gm-chip warn" data-mi-code="' + esc(c.code) + '" title="' + esc(why + ' (model integrity audit, ' + when(S.file && S.file.generated_at) + ')') + '">' + esc(c.label) + '</span>';
    }).join('');
  };

  function who(a) {
    var x = a.assumptions || {}, out = [];
    if (x.qb) ['away', 'home'].forEach(function (k) { var q = x.qb[k]; if (q && q.name) out.push((k === 'home' ? a.home : a.away) + ' QB: ' + q.name + (q.status ? ' (' + String(q.status).toLowerCase().replace(/_/g, ' ') + ')' : '')); });
    if (x.goalies) ['away', 'home'].forEach(function (k) { var g = x.goalies[k] || []; if (g.length) out.push((k === 'home' ? a.home : a.away) + ' goalie: ' + g.map(function (y) { return (y.name || y.goalie) + ' ' + Math.round(100 * (y.p_start || 0)) + '%' + (y.confirmed ? ', confirmed' : ''); }).join(' / ')); });
    if (x.assumed_active) ['away', 'home'].forEach(function (k) { var l = x.assumed_active[k] || []; if (l.length) out.push((k === 'home' ? a.home : a.away) + ' assumed active: ' + l.slice(0, 8).join(', ') + (l.length > 8 ? ' +' + (l.length - 8) : '')); });
    if (x.left_team) ['away', 'home'].forEach(function (k) { var l = x.left_team[k] || []; if (l.length) out.push((k === 'home' ? a.home : a.away) + ' left the team: ' + l.join(', ')); });
    if (x.rotation_source) out.push('Rotation: ' + x.rotation_source + ' (projected, not a confirmed lineup)');
    if (x.weather) out.push(x.weather);
    return out;
  }
  /* the matchup view's section */
  U.detailHTML = function (a) {
    if (!a) return '';
    var m = a.model || {}, mk = a.market || {}, c = mk.compared, d = a.disagreement;
    var h = '<section class="gm-dsec gm-mi"><h4>Model integrity</h4>';
    h += '<p><b>' + esc(a.status === 'OK' ? 'No warning' : (a.chips && a.chips[0] ? a.chips[0].label : a.status)) + '</b> · ' + esc(m.id || 'model') + ' · predicted ' + esc(when(m.predicted_at)) + (m.data_cutoff ? ' · data through ' + esc(String(m.data_cutoff).slice(0, 16).replace('T', ' ')) : '') + '</p>';
    if ((a.classifications || []).length) h += '<ul class="gm-mi-list">' + a.classifications.map(function (x) { return '<li><b>' + esc(x.chip) + '.</b> ' + esc(x.message) + ' <span class="gm-note">(' + esc(x.component) + ')</span></li>'; }).join('') + '</ul>';
    var w = who(a);
    if (w.length) h += '<p class="gm-note"><b>What the number assumed:</b> ' + w.map(esc).join(' · ') + '</p>';
    if (c) {
      h += '<p class="gm-note"><b>Against the market:</b> ' + esc(c.book || 'captured price') + ', captured ' + esc(when(c.captured_at)) + ' (before the projection)'
        + (d && d.spread_pts != null ? '; spread ' + esc(signed(d.spread_pts)) + ' pts' : '') + (d && d.total_pts != null ? '; total ' + esc(signed(d.total_pts, 2)) : '') + (d && d.win_prob_pp != null ? '; win probability ' + esc(signed(d.win_prob_pp)) + ' pts vs the no-vig price' : '')
        + '. A disagreement is a reason to look, not proof that either number is wrong.</p>';
    } else h += '<p class="gm-note"><b>Against the market:</b> ' + esc(mk.basis || 'no quote on file') + '.</p>';
    h += '<p class="gm-note">Audit ' + esc(when(S.file && S.file.generated_at)) + '. It changes no number; research, not picks.</p></section>';
    return h;
  };
  window.EDIntegrityUI = U;
})();
