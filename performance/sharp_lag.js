/* ===========================================================================
   The Performance page's Sharp-lag record (Experimental). Public.

   Reads, as any visitor (the public anon key every page already ships):
     public.sharp_lag_progress()  the counts and the registered threshold,
                                  always public, no price
     public.sharp_lag_flags()     every flag of a game that has STARTED, with
                                  its grade, once an operator has read The
                                  Odds API's terms and switched public display
                                  on (until then it answers nothing)
   The record is computed here, straight from those append-only rows
   (EDSharpLag.record): every flag counts, losses included, and nothing is
   edited on the way. docs/sharp-lag/README.md.
   =========================================================================== */
(function () {
  'use strict';
  var SB_URL = 'https://iattxbkbufslbauoumga.supabase.co';
  /* the public anon key every page already ships (lib/edgedesk_public.js) */
  var SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlhdHR4YmtidWZzbGJhdW91bWdhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2MzY4MDUsImV4cCI6MjA5NzIxMjgwNX0.Mly5G587o5IFRnEigU2wRp9buWEk3dFwH9RNPJK7Uo8';
  var SL = window.EDSharpLag;
  var el = document.getElementById('pf-sharplag');
  if (!el || !SL) return;
  SL.injectStyle(document);
  function rpc(name, body) {
    return fetch(SB_URL + '/rest/v1/rpc/' + name, { method: 'POST', headers: { apikey: SB_KEY, authorization: 'Bearer ' + SB_KEY, 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
      .then(function (r) { if (r.status === 404) return { notDeployed: true }; if (!r.ok) throw new Error(name + ' answered ' + r.status); return r.json(); });
  }
  var MODELS = [{ key: SL.MODELS.sharp_lag.key, title: 'Sharp-lag flags: Kalshi and DraftKings against Pinnacle',
    note: 'Lag to converge is measured only to the snapshot cadence (hourly boards, 5-minute Kalshi snapshots); the resolution column says how coarse.' }];
  MODELS.push({ key: SL.MODELS.role_shift.key, title: 'NBA role-shift flags: player props after a rotation absence',
    note: 'Each flag is graded at its own book and line against that book\u2019s close, with the player\u2019s actual stat stored beside it. Its resolution is the time from the injury report to the one price check that followed it.' });
  el.innerHTML = SL.pendingSection({ text: 'Loading the Sharp-lag record…' });
  Promise.all([rpc('sharp_lag_progress'), rpc('sharp_lag_flags', { p_sport: null, p_from: null, p_to: null })]).then(function (x) {
    var pr = x[0], rows = x[1];
    if (!pr || pr.notDeployed) { el.innerHTML = SL.pendingSection({ text: 'The Sharp-lag research record is not deployed yet.' }); return; }
    rows = Array.isArray(rows) ? rows : [];
    var pub = pr.public_display === 'on';
    el.innerHTML = MODELS.map(function (m) {
      var mine = rows.filter(function (r) { return r.model_key === m.key; });
      var counts = (pr.models || []).filter(function (c) { return c.model_key === m.key; })[0] || { flags: 0, graded: 0, no_close: 0, pending: 0 };
      if (!pub) {
        return '<section class="sl-sec" aria-label="' + SL.esc(m.title) + '"><h2 class="sl-h">' + SL.esc(m.title) + ' <span class="sl-badge exp">Experimental</span></h2>'
          + '<p class="sl-note">' + SL.esc(SL.EXPERIMENTAL_NOTE) + '</p>'
          + SL.progressLine(SL.validationFrom(pr, [], m.key))
          + '<p class="sl-note">' + counts.flags + ' flag' + (counts.flags === 1 ? '' : 's') + ' written, ' + counts.no_close + ' without a usable close, ' + counts.pending + ' waiting for the game to start. '
          + 'The graded record with every flag is published here once EdgeDesk has confirmed the price source’s terms allow it.</p></section>';
      }
      var rec = SL.record(mine, { model_key: m.key });
      /* the counts are the record's own (a flag before its game starts is not public) */
      rec.overall.flags = counts.flags; rec.overall.pending = counts.pending;
      rec.validation = SL.validationFrom(pr, mine, m.key);
      return SL.recordSection({ title: m.title, record: rec, note: m.note });
    }).join('');
  }).catch(function () { el.innerHTML = SL.pendingSection({ text: 'The Sharp-lag research record could not be read just now.' }); });
})();
