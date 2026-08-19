/* Model Collective embed.
   One script tag renders the full Collective inside a member's site:

     <script src="https://edgedesksports.com/collective/embed.js"
             data-collective-host="your-slug" data-theme="dark" async></script>

   Optional: data-theme="light", data-api="<base>" for testing, and a
   <div id="model-collective"></div> to control placement.

   Contract, enforced here and server side:
   - The Collective renders identically on every host site. The payload arrives
     in canonical order and is NEVER reordered, filtered, or edited client side.
     A host cannot hide a rival, tune a ranking, or trim a bad week. The single
     host privilege is that the server pins the host's own row first and this
     script badges it.
   - Shadow DOM both ways: host CSS cannot reach in, embed CSS cannot leak out.
   - Every creator profile links OUT to that creator's own site and socials.
   - A persistent link back to the Collective is always present.
   - If the API is slow or unreachable this degrades to a readable static
     panel, never a blank box and never raw error text. */
(function () {
  'use strict';
  var DEFAULT_API = 'https://iattxbkbufslbauoumga.supabase.co/functions/v1';
  var SITE = 'https://edgedesksports.com/collective/';
  var TIMEOUT_MS = 6000;

  /* find our own script tag; tolerate double-loading */
  var tag = document.currentScript;
  if (!tag) {
    var scripts = document.querySelectorAll('script[data-collective-host], script[src*="embed.js"]');
    tag = scripts[scripts.length - 1];
  }
  if (!tag) return;
  if (window.__MC_EMBED_LOADED) return;
  window.__MC_EMBED_LOADED = true;

  /* data-collective-host is the member's slug. It may be omitted on the
     Collective's own domain, where the wall renders unpinned. */
  var HOST = (tag.getAttribute('data-collective-host') || '').trim();
  var THEME = tag.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  var API = (tag.getAttribute('data-api') || DEFAULT_API).replace(/\/$/, '');
  var REFQ = HOST ? '?ref=' + encodeURIComponent(HOST) : '';

  /* mount point */
  var mount = document.getElementById('model-collective');
  if (!mount) {
    mount = document.createElement('div');
    mount.id = 'model-collective';
    if (tag.parentNode) tag.parentNode.insertBefore(mount, tag);
    else document.body.appendChild(mount);
  }
  var root = mount.attachShadow ? mount.attachShadow({ mode: 'open' }) : mount;

  /* ---------- tokens ---------- */
  var T = THEME === 'light'
    ? { bg:'#f6f7f9', surface:'#ffffff', surface2:'#eef0f4', border:'#d8dde5', text:'#14181f', dim:'#5b6472', faint:'#8a93a2', accent:'#2f6fe0', pos:'#1e8f60', neg:'#c74e35', warn:'#a87718', gold:'#8a6d1d' }
    : { bg:'#0d0f13', surface:'#13161c', surface2:'#191d25', border:'#262c36', text:'#e7eaf0', dim:'#8a93a2', faint:'#5b6472', accent:'#4d8dff', pos:'#2fb47c', neg:'#e26044', warn:'#d99a2b', gold:'#e3b84d' };

  var CSS = ''
    + ':host{all:initial}'
    + '.mc{font-family:Inter,system-ui,-apple-system,sans-serif;font-size:14px;line-height:1.45;color:' + T.text + ';background:' + T.bg + ';border:1px solid ' + T.border + ';border-radius:12px;overflow:hidden;display:block;max-width:100%}'
    + '.mc *{box-sizing:border-box;margin:0;padding:0}'
    + '.mc a{color:' + T.accent + ';text-decoration:none}.mc a:hover{text-decoration:underline}'
    + '.mono{font-family:"JetBrains Mono",ui-monospace,Menlo,Consolas,monospace}'
    + '.hd{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid ' + T.border + ';background:' + T.surface + '}'
    + '.wm{font-weight:800;font-size:13px;letter-spacing:.06em;color:' + T.text + '!important;white-space:nowrap}'
    + '.wm:hover{text-decoration:none}'
    + '.wm .mk{display:inline-block;width:8px;height:13px;background:' + T.accent + ';border-radius:2px;transform:skewX(-12deg);margin-right:6px;vertical-align:-2px}'
    + '.hd .sub{font-size:10px;color:' + T.faint + ';text-transform:uppercase;letter-spacing:.05em}'
    + '.hd .sp{flex:1}'
    + '.hd .out{font-size:11px;color:' + T.dim + '}'
    + '.sec{padding:12px 14px;border-bottom:1px solid ' + T.border + '}'
    + '.sec:last-child{border-bottom:none}'
    + '.sec h3{font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:' + T.faint + ';margin:0 0 9px;font-weight:700}'
    + '.tw{overflow-x:auto;border:1px solid ' + T.border + ';border-radius:8px;background:' + T.surface + '}'
    + 'table{border-collapse:collapse;width:100%;min-width:640px}'
    + 'th{background:' + T.surface2 + ';color:' + T.faint + ';font-size:9.5px;text-transform:uppercase;letter-spacing:.05em;text-align:left;padding:7px 9px;white-space:nowrap}'
    + 'td{padding:8px 9px;border-top:1px solid ' + T.border + ';font-size:12.5px;white-space:nowrap;vertical-align:middle}'
    + 'th.n,td.n{text-align:right}'
    + 'td.n{font-family:"JetBrains Mono",ui-monospace,monospace;font-size:12px}'
    + '.who{display:flex;align-items:center;gap:8px}'
    + '.mg{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:6px;background:' + T.surface2 + ';border:1px solid ' + T.border + ';font-size:10px;font-weight:800;color:' + T.accent + ';flex:none}'
    + 'img.lg{width:24px;height:24px;border-radius:6px;object-fit:cover;border:1px solid ' + T.border + ';flex:none}'
    + '.nm{font-weight:600}'
    + '.sb{color:' + T.faint + ';font-size:10.5px}'
    + '.chip{display:inline-block;font-size:9px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;border:1px solid ' + T.border + ';border-radius:9px;padding:1px 6px;color:' + T.dim + ';white-space:nowrap}'
    + '.chip.act{color:' + T.pos + ';border-color:' + T.pos + '55}'
    + '.chip.inact{color:' + T.faint + ';border-style:dashed}'
    + '.chip.host{color:' + T.accent + ';border-color:' + T.accent + '66}'
    + '.chip.fnd{color:' + T.gold + ';border-color:' + T.gold + '55}'
    + '.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:9px}'
    + '.card{background:' + T.surface + ';border:1px solid ' + T.border + ';border-radius:9px;padding:11px}'
    + '.card .ln{margin-top:7px;font-size:11.5px}'
    + '.card .ln a{margin-right:10px}'
    + '.game{background:' + T.surface + ';border:1px solid ' + T.border + ';border-radius:9px;margin-bottom:8px;overflow:hidden}'
    + '.g-hd{display:flex;gap:9px;align-items:baseline;padding:9px 11px;border-bottom:1px solid ' + T.border + ';flex-wrap:wrap}'
    + '.g-hd .l{font-weight:700;font-size:13px}'
    + '.g-hd .t{color:' + T.dim + ';font-size:11px}'
    + '.g-hd .f{font-family:"JetBrains Mono",monospace;font-weight:700;font-size:13px;margin-left:auto}'
    + '.mrow{display:flex;gap:9px;align-items:center;padding:7px 11px;border-bottom:1px solid ' + T.border + ';font-size:12px;flex-wrap:wrap}'
    + '.mrow:last-child{border-bottom:none}'
    + '.mrow .sp{flex:1}'
    + '.lock{color:' + T.faint + ';font-size:11.5px}'
    + '.lock:before{content:"\\1F512\\FE0E ";opacity:.7}'
    + '.win{color:' + T.pos + '}.loss{color:' + T.neg + '}.push{color:' + T.warn + '}'
    + '.cta{display:inline-block;background:' + T.accent + ';color:' + (THEME==='light'?'#fff':'#0b1220') + '!important;font-weight:700;font-size:12px;border-radius:7px;padding:7px 13px}'
    + '.cta:hover{text-decoration:none;opacity:.92}'
    + '.ft{padding:11px 14px;background:' + T.surface + ';color:' + T.faint + ';font-size:10.5px;display:flex;gap:10px;flex-wrap:wrap;align-items:center}'
    + '.fallback{padding:26px 18px;text-align:center;color:' + T.dim + ';font-size:13px}'
    + '.note{color:' + T.faint + ';font-size:11px}';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function pct(x, d) { return x == null ? '—' : (100 * x).toFixed(d == null ? 1 : d) + '%'; }
  function num(x, d) { return x == null ? '—' : Number(x).toFixed(d == null ? 1 : d); }
  function spr(x) { if (x == null) return '—'; var n = Number(x); return (n > 0 ? '+' : '') + n.toFixed(1); }
  function chip(m) {
    if (m === 'ACTIVE CONTRIBUTOR') return '<span class="chip act">Active</span>';
    if (m === 'INACTIVE') return '<span class="chip inact">Inactive</span>';
    return '<span class="chip">Member</span>';
  }
  function avatar(r) {
    if (r && r.logo_url) return '<img class="lg" src="' + esc(r.logo_url) + '" alt="">';
    return '<span class="mg">' + esc((r && r.monogram) || '?') + '</span>';
  }
  function ko(iso) {
    if (!iso) return '';
    try {
      var d = new Date(iso);
      return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) + ' ' +
             d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    } catch (e) { return ''; }
  }

  /* ---------- events ---------- */
  var VID = null;
  try {
    VID = localStorage.getItem('mc_visitor');
    if (!VID) {
      VID = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2);
      localStorage.setItem('mc_visitor', VID);
    }
  } catch (e) { VID = 'mem-' + Math.random().toString(36).slice(2); }
  var evq = [];
  var evTimer = null;
  function ev(type, target) {
    evq.push({ type: type, target: target || null, path: location.pathname, at: new Date().toISOString() });
    if (evTimer) return;
    evTimer = setTimeout(flush, 1200);
  }
  function flush() {
    evTimer = null;
    if (!evq.length) return;
    var body = JSON.stringify({ host: HOST, visitor: VID, events: evq.splice(0, 50) });
    var url = API + '/collective_embed/v1/embed/events';
    try {
      /* fetch with keepalive over sendBeacon: beacons always send credentials,
         which trips CORS on origin-echoing servers. keepalive survives unload. */
      fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body, keepalive: true, credentials: 'omit' }).catch(function () {});
    } catch (e) { /* silent */ }
  }
  try { document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') flush(); }); } catch (e) {}

  /* ---------- render ---------- */
  var style = document.createElement('style');
  style.textContent = CSS;
  root.appendChild(style);
  var box = document.createElement('div');
  box.className = 'mc';
  root.appendChild(box);
  box.innerHTML = '<div class="hd"><span class="wm"><span class="mk"></span>MODEL COLLECTIVE</span><span class="sp"></span><span class="sub">loading</span></div>' +
    '<div class="fallback">Loading the Collective…</div>';

  function fallback(forbidden) {
    box.innerHTML =
      '<div class="hd"><a class="wm" href="' + esc(SITE) + '" target="_blank" rel="noopener"><span class="mk"></span>MODEL COLLECTIVE</a><span class="sp"></span><span class="sub">independent models, one record</span></div>' +
      '<div class="fallback">The Model Collective is temporarily unreachable from this page.<br>' +
      '<a href="' + esc(SITE) + REFQ + '" target="_blank" rel="noopener">Open the Collective directly →</a>' +
      (forbidden ? '<br><br><span class="note">Site owner: register this domain in your Collective dashboard to activate the embed here.</span>' : '') +
      '</div>';
  }

  function render(d) {
    var wall = d.wall || [];
    var wallRows = wall.map(function (r) {
      var isHost = d.host && r.creator_slug === d.host.creator_slug;
      var rec = r.record;
      return '<tr>' +
        '<td><span class="who">' + avatar(r) + '<span><span class="nm">' + esc(r.creator_name) + '</span>' +
          (isHost ? ' <span class="chip host">This site’s model</span>' : '') +
          (r.founding ? ' <span class="chip fnd">Founding</span>' : '') +
          '<br><span class="sb">' + esc(r.model_name) + ' · ' + esc(r.sport) + '</span></span></span></td>' +
        '<td>' + chip(r.membership) + '</td>' +
        '<td class="n">' + (rec ? rec.wins + '-' + rec.losses + '-' + rec.pushes : '<span class="sb">pending</span>') + '</td>' +
        '<td class="n">' + (rec ? pct(rec.win_pct) : '—') + '</td>' +
        '<td class="n">' + (rec ? num(rec.margin_mae) : '—') + '</td>' +
        '<td class="n">' + (rec ? num(rec.brier, 3) : '—') + '</td>' +
        '<td class="n">' + (r.coverage_pct != null ? num(r.coverage_pct, 0) + '%' : '—') + '</td>' +
        '</tr>';
    }).join('');
    /* The wall arrives in canonical order with the host pinned by the SERVER.
       Do not reorder or filter here: every host shows the same collective. */

    var creatorCards = (d.creators || []).map(function (c) {
      var m0 = (c.models && c.models[0]) || {};
      var rec = m0.record;
      var links = '';
      if (c.website_url) links += '<a href="' + esc(c.website_url) + '" target="_blank" rel="noopener" data-out="' + esc(c.slug) + '">Site ↗</a>';
      if (c.x_handle) links += '<a href="https://x.com/' + esc(c.x_handle) + '" target="_blank" rel="noopener" data-out="' + esc(c.slug) + '">@' + esc(c.x_handle) + ' ↗</a>';
      links += '<a href="' + esc(SITE) + REFQ + '#/' + esc(c.slug) + '" target="_blank" rel="noopener" data-prof="' + esc(c.slug) + '">Profile →</a>';
      return '<div class="card"><div class="who">' + avatar(c) + '<span><span class="nm">' + esc(c.display_name) + '</span>' +
        (c.founding ? ' <span class="chip fnd">Founding</span>' : '') +
        '<br><span class="sb">' + esc(m0.model_name || '') + (m0.sport ? ' · ' + esc(m0.sport) : '') + '</span></span></div>' +
        '<div class="sb" style="margin-top:7px">' + (rec ? ('Record <span class="mono">' + rec.wins + '-' + rec.losses + '-' + rec.pushes + '</span> · ' + pct(rec.win_pct) + ' · Brier ' + num(rec.brier, 3)) : 'First submission pending') + ' · ' + chip(c.membership) + '</div>' +
        '<div class="ln">' + links + '</div></div>';
    }).join('');

    function gameBlock(g, entitled) {
      var hd = '<div class="g-hd"><span class="l">' + esc(g.label) + '</span><span class="t">' + ko(g.kickoff_at) + '</span>' +
        (g.result ? '<span class="f">' + g.result.away_score + ' - ' + g.result.home_score + '</span>' : '') + '</div>';
      var cons = '';
      if (g.consensus && !g.consensus.locked && g.consensus.n) {
        cons = '<div class="mrow" style="color:' + T.dim + '">consensus <span class="mono">' + spr(g.consensus.spread_mean) + '</span> · total <span class="mono">' + num(g.consensus.total_mean) + '</span> · home win <span class="mono">' + pct(g.consensus.home_win_prob_mean, 0) + '</span> · ' + g.consensus.n + ' models</div>';
      } else if (g.consensus && g.consensus.locked) {
        cons = '<div class="mrow"><span class="lock">Consensus is a subscriber number</span></div>';
      }
      var rows = (g.models || []).map(function (m) {
        var who = '<span class="nm" style="font-size:12px">' + esc(m.creator_slug) + '</span>';
        if (m.locked) return '<div class="mrow">' + who + '<span class="sp"></span><span class="lock">Subscriber number</span></div>';
        var grade = m.grade ? ' <span class="mono ' + esc(m.grade.pick_result) + '">' + esc(m.grade.pick_result) + '</span>' : '';
        return '<div class="mrow">' + who + '<span class="sp"></span>' +
          '<span class="mono">' + (m.pick_side ? 'pick ' + esc(m.pick_side) : 'no pick') + '</span>' +
          '<span class="mono">spr ' + spr(m.projected_spread) + '</span>' +
          (m.home_win_probability != null ? '<span class="mono">hw ' + pct(m.home_win_probability, 0) + '</span>' : '') +
          grade + '</div>';
      }).join('');
      return '<div class="game">' + hd + cons + rows + '</div>';
    }

    var upcoming = (d.upcoming && d.upcoming.games || []).map(function (g) { return gameBlock(g, d.upcoming.entitled); }).join('');
    var settled = (d.settled && d.settled.games || []).map(function (g) { return gameBlock(g, true); }).join('');
    var locked = d.upcoming && d.upcoming.entitled === false;

    box.innerHTML =
      '<div class="hd"><a class="wm" href="' + esc(d.collective_url || SITE) + '" target="_blank" rel="noopener" data-coll><span class="mk"></span>MODEL COLLECTIVE</a>' +
      '<span class="sp"></span><span class="sub">independent models · one record</span></div>' +

      '<div class="sec"><h3>The model wall</h3><div class="tw"><table><thead><tr>' +
      '<th>Creator / model</th><th>Status</th><th class="n">Record</th><th class="n">Win %</th><th class="n">MAE</th><th class="n">Brier</th><th class="n">Coverage</th>' +
      '</tr></thead><tbody>' + (wallRows || '<tr><td colspan="7" class="sb" style="text-align:center;padding:16px">The wall is waiting on its first model.</td></tr>') + '</tbody></table></div></div>' +

      '<div class="sec"><h3>The creators</h3><div class="cards">' + creatorCards + '</div></div>' +

      (upcoming ? '<div class="sec"><h3>Upcoming</h3>' +
        (locked ? '<div class="mrow" style="border:1px solid ' + T.border + ';border-radius:8px;margin-bottom:8px;background:' + T.surface + '">' +
          '<span style="font-size:12px">Pre-kickoff numbers and consensus are one subscription across every model here.</span>' +
          '<span class="sp"></span><a class="cta" href="' + esc(d.subscribe_url || SITE) + '" target="_blank" rel="noopener" data-sub>Unlock the board</a></div>' : '') +
        upcoming + '</div>' : '') +

      (settled ? '<div class="sec"><h3>Settled, the public record</h3>' + settled + '</div>' : '') +

      '<div class="ft"><span>Every model here keeps its own site, price, and methodology.</span><span style="flex:1"></span>' +
      '<a href="' + esc(d.collective_url || SITE) + '" target="_blank" rel="noopener" data-coll>The Model Collective →</a></div>';

    /* event wiring */
    box.addEventListener('click', function (e) {
      var a = e.target && e.target.closest ? e.target.closest('a') : null;
      if (!a) return;
      if (a.hasAttribute('data-sub')) ev('subscribe_click');
      else if (a.hasAttribute('data-coll')) ev('collective_click');
      else if (a.hasAttribute('data-prof')) ev('profile_view', a.getAttribute('data-prof'));
      else if (a.hasAttribute('data-out')) ev('outbound_click', a.getAttribute('data-out'));
    });
    ev('impression');
  }

  /* ---------- fetch ---------- */
  var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, TIMEOUT_MS);
  fetch(API + '/collective_embed/v1/embed/bootstrap?theme=' + THEME + (HOST ? '&host=' + encodeURIComponent(HOST) : ''),
    ctrl ? { signal: ctrl.signal } : {})
    .then(function (r) {
      clearTimeout(timer);
      if (r.status === 403) { fallback(true); return null; }
      if (!r.ok) { fallback(false); return null; }
      return r.json();
    })
    .then(function (d) { if (d) render(d); })
    .catch(function () { clearTimeout(timer); fallback(false); });
})();
