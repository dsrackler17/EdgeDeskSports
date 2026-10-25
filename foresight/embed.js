/* ===========================================================================
   MARKET FORESIGHT — the embed: one model's top line, linking to its
   complete record. docs/market-foresight/README.md §Embed

     <div id="edgedesk-foresight"></div>
     <script src="https://edgedesksports.com/foresight/embed.js"
             data-source="edgedesk" data-model="edgedesk_cfb_p4_v1.0.1" async></script>

   One anonymous door (mf_embed): it answers only while Market Foresight is
   live and only for a publishable model (a Collective model only while it and
   its creator are listed). It returns counts and their samples, never a
   forecast, a price or a timeline. Rendered in a shadow root, text only.
   =========================================================================== */
(function () {
  'use strict';
  if (window.__MF_EMBED_LOADED) return;
  window.__MF_EMBED_LOADED = true;
  var SB_URL = 'https://iattxbkbufslbauoumga.supabase.co';
  var SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlhdHR4YmtidWZzbGJhdW91bWdhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2MzY4MDUsImV4cCI6MjA5NzIxMjgwNX0.Mly5G587o5IFRnEigU2wRp9buWEk3dFwH9RNPJK7Uo8';
  var SITE = 'https://edgedesksports.com';
  var me = document.currentScript || document.querySelector('script[src*="foresight/embed.js"]');
  var source = me && me.getAttribute('data-source'), model = me && me.getAttribute('data-model');
  var host = document.getElementById('edgedesk-foresight');
  if (!host) { host = document.createElement('div'); host.id = 'edgedesk-foresight'; if (me && me.parentNode) me.parentNode.insertBefore(host, me); else document.body.appendChild(host); }
  var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
  var MK = { spread: 'Spread', total: 'Total', moneyline: 'Win probability' }, VN = { draftkings: 'DraftKings', kalshi: 'Kalshi' }, SP = { nfl: 'NFL', cfb: 'College football' };
  var link = SITE + '/foresight/?model=' + encodeURIComponent((source || '') + ':' + (model || ''));
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
  var style = el('style');
  style.textContent = ':host{all:initial}.w{font:14px/1.45 Inter,system-ui,sans-serif;color:#f1ebdf;background:#191510;border:1px solid #332a1b;border-radius:12px;padding:12px 14px;max-width:520px}'
    + '.k{font:700 10px ui-monospace,Menlo,monospace;letter-spacing:.12em;text-transform:uppercase;color:#2fa79a}.t{font-weight:700;margin:4px 0 8px}'
    + 'table{width:100%;border-collapse:collapse;font-size:12.5px}th,td{text-align:left;padding:5px 4px;border-top:1px solid #332a1b;vertical-align:top}th{color:#a29581;font-weight:600}'
    + '.n{color:#887e70;font-size:11.5px}a{color:#2fa79a}.f{margin-top:8px;font-size:12px;color:#a29581}';
  root.appendChild(style);
  var box = el('div', 'w');
  box.setAttribute('role', 'region');
  box.setAttribute('aria-label', 'EdgeDesk Market Foresight record');
  box.appendChild(el('div', 'k', 'EdgeDesk Market Foresight'));
  var title = el('div', 't', 'Loading the record\u2026');
  box.appendChild(title);
  root.appendChild(box);
  function foot() {
    var f = el('div', 'f');
    var a = el('a', null, 'Complete record, misses included \u2192');
    a.href = link; a.target = '_blank'; a.rel = 'noopener';
    f.appendChild(a);
    f.appendChild(el('div', 'n', 'Observational research: when the market moved relative to this model\u2019s published forecasts. Not a grade, not picks.'));
    box.appendChild(f);
  }
  if (!source || !model) { title.textContent = 'Missing data-source or data-model.'; foot(); return; }
  var ctl = typeof AbortController === 'function' ? new AbortController() : null;
  var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 6000);
  fetch(SB_URL + '/rest/v1/rpc/mf_embed', { method: 'POST', signal: ctl ? ctl.signal : undefined, headers: { apikey: SB_KEY, authorization: 'Bearer ' + SB_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ p_source: source, p_model_key: model }) })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      clearTimeout(timer);
      if (!d || !d.found) { title.textContent = 'No published record for this model yet.'; foot(); return; }
      title.textContent = d.model_label + ' \u00b7 ' + d.methodology;
      var t = el('table'), head = el('tr');
      ['Market', 'Closes closer', 'Sustained move toward', 'Sample'].forEach(function (h) { var th = el('th', null, h); th.scope = 'col'; head.appendChild(th); });
      t.appendChild(head);
      var shown = d.rows.filter(function (r) { return r.measured > 0; }), rest = d.rows.length - shown.length;
      shown.forEach(function (r) {
        var tr = el('tr');
        tr.appendChild(el('td', null, (SP[r.sport] || r.sport) + ' \u00b7 ' + (MK[r.market] || r.market) + ' vs ' + (VN[r.venue] || r.venue) + (r.model_version ? ' (' + r.model_version + ')' : '')));
        tr.appendChild(el('td', null, r.closer && r.closer.n ? r.closer.k + ' of ' + r.closer.n : '\u2014'));
        tr.appendChild(el('td', null, r.qualifying && r.qualifying.n ? r.qualifying.k + ' of ' + r.qualifying.n + (r.precedence ? ' (' + r.precedence.preceded + ' preceded)' : '') : '\u2014'));
        tr.appendChild(el('td', 'n', r.evidence === 'OK' ? 'n = ' + r.measured : (r.evidence === 'THIN' ? 'thin: n = ' + r.measured : 'insufficient: n = ' + r.measured)));
        t.appendChild(tr);
      });
      if (shown.length) box.appendChild(t);
      else box.appendChild(el('div', 'n', 'Nothing measured yet.'));
      if (rest) box.appendChild(el('div', 'n', rest + ' other market' + (rest === 1 ? '' : 's') + ' not measured yet (each reason is on the complete record).'));
      foot();
    })
    .catch(function () { clearTimeout(timer); title.textContent = 'The record could not be loaded just now.'; foot(); });
})();
