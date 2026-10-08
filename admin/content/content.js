/* ===========================================================================
   The Content Engine page (admin/content/) — owner only.

   Every database call is a public.content_engine_* door through the shared
   operator session (lib/edgedesk_admin_session.js); the database checks the
   owner on every one. The research, discovery, the deterministic writer,
   the checks and the exports are lib/content_engine.js, the same code the
   weekly job and the Edge Function run. The Edge Function (content_engine)
   does the two things a browser must not: call Claude and fetch the feeds.

   Nothing on this page publishes anything, and nothing is ever emailed on its
   own. The one email is the owner's: “Send to <contact>” in the publishing
   queue, after a confirmation naming the address, of the approved version
   only, to a contact on the article's publisher (the database checks every
   one of those). “Record a send made elsewhere” records a send the owner made
   from their own mail.
   =========================================================================== */
(function () {
  'use strict';
  var CE = window.EDContentEngine;
  var FN = 'content_engine';
  var S = window.EDAdminSession.create({
    url: SB_URL, key: SB_KEY, storageKey: 'edgedesk_content_admin_session', adminRpc: 'content_engine_is_owner',
    onSignedOut: function (why) { showGate(why, false); }
  });
  var ST = { overview: null, publishers: [], opps: [], articles: [], art: null, opp: null, tab: 'opps', snapshot: null, dirty: false };

  /* ── small helpers ─────────────────────────────────────────────────── */
  function $(id) { return document.getElementById(id); }
  var esc = CE.util.esc;
  function say(id, kind, t) { var el = $(id); if (!el) return; el.className = 'msg ' + (kind || ''); el.textContent = t || ''; }
  function fail(id, e) {
    if (e && e.kind === 'signed_out') { showGate(e.message, false); return; }
    if (e && e.kind === 'forbidden') { showGate('This account is not a Content Engine owner.', true); return; }
    if (e && e.kind === 'not_installed') { say(id, 'err', 'The Content Engine database is not installed: run supabase/content_engine.sql in the SQL editor.'); return; }
    say(id, 'err', S.message(e));
  }
  function rpc(n, a) { return S.rpc(n, a || {}); }
  function link(url, text) { return /^https:\/\//.test(String(url || '')) ? '<a href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(text || url) + '</a>' : esc(text || ''); }
  function when(x) { if (!x) return '—'; var t = Date.parse(x); return isFinite(t) ? CE.util.whenText(t) : esc(x); }
  function ago(x) {
    var t = Date.parse(x); if (!isFinite(t)) return '';
    var m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return 'just now';
    return m < 60 ? m + ' min ago' : m < 2880 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' days ago';
  }
  function pill(status) {
    var cls = { approved: 'ok', ready_to_send: 'ok', published: 'ok', sent: 'ok', in_review: 'warn', draft: '', archived: '' }[status] || '';
    return '<span class="pill ' + cls + '">' + esc(CE.STATUS_LABELS[status] || status) + '</span>';
  }
  function pubName(id) { var p = ST.publishers.filter(function (x) { return x.id === id; })[0]; return p ? p.name : 'EdgeDesk (house)'; }
  function download(name, text, type) {
    var blob = new Blob([text], { type: type || 'text/plain' });
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  function copy(text, msgId) {
    var done = function () { say(msgId, 'ok', 'Copied.'); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { say(msgId, 'err', 'The browser refused the clipboard; use Download instead.'); });
  }
  function num(v) { return v == null ? '—' : String(v); }
  function rate(a, b) { return a == null || b == null || !b ? '—' : (Math.round(1000 * a / b) / 10) + '%'; }

  /* ── gate ──────────────────────────────────────────────────────────── */
  function showGate(text, signedInButNotOwner) {
    $('app').classList.add('hide'); $('gate').classList.remove('hide'); $('signOut').classList.add('hide'); $('who').textContent = '';
    $('gFields').classList.toggle('hide', !!signedInButNotOwner);
    $('gSwitch').classList.toggle('hide', !signedInButNotOwner);
    say('gMsg', text ? 'err' : '', text || '');
  }
  function showApp() {
    $('gate').classList.add('hide'); $('app').classList.remove('hide'); $('signOut').classList.remove('hide');
    $('who').textContent = S.email() || '';
  }
  $('gate').onsubmit = async function (ev) {
    ev.preventDefault();
    var email = $('gEmail').value.trim(), pass = $('gPass').value;
    if (window.EDAuth && !window.EDAuth.validEmail(email)) { say('gMsg', 'err', 'That email address does not look right.'); return; }
    $('gGo').disabled = true; say('gMsg', '', 'Signing in…');
    try { var r = await S.signIn(email, pass); $('gPass').value = ''; if (!r.ok) { say('gMsg', 'err', r.message); return; } await boot(); }
    finally { $('gGo').disabled = false; }
  };
  async function signOutNow() { await S.signOut(); showGate('', false); say('gMsg', 'ok', 'Signed out.'); }
  $('signOut').onclick = signOutNow; $('gOut').onclick = signOutNow;

  /* ── tabs ──────────────────────────────────────────────────────────── */
  var LOADERS = { opps: loadOpps, gen: fillGenerator, review: loadReview, pub: loadQueue, perf: loadPerf, pubs: loadPublishers, set: loadSettings };
  function tab(name) {
    ST.tab = name;
    document.querySelectorAll('.tabs button').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-tab') === name); });
    Object.keys(LOADERS).forEach(function (k) { $('tab-' + k).classList.toggle('hide', k !== name); });
    var f = LOADERS[name]; if (f) f().catch(function (e) { fail('appMsg', e); $('appMsg').classList.remove('hide'); });
  }
  document.querySelectorAll('.tabs button').forEach(function (b) { b.onclick = function () { tab(b.getAttribute('data-tab')); }; });

  async function loadOverview() {
    var ov = ST.overview = await rpc('content_engine_overview');
    var a = ov.articles || {}, o = ov.opportunities || {};
    var k = [
      ['Open topics', (o['new'] || 0) + (o.shortlisted || 0), 'new + shortlisted'],
      ['Drafts', a.draft || 0, 'not yet in review'],
      ['In review', a.in_review || 0, 'waiting for you'],
      ['Approved / ready', (a.approved || 0) + (a.ready_to_send || 0), 'waiting for you to send'],
      ['Sent / published', (a.sent || 0) + (a.published || 0), 'by you, never on its own'],
      ['AI calls today', ov.budget.llm.used + ' / ' + ov.budget.llm.cap, 'daily cap (Settings)']
    ];
    $('kpis').innerHTML = k.map(function (x) { return '<div class="kpi"><i>' + esc(x[0]) + '</i><b>' + esc(x[1]) + '</b><small>' + esc(x[2]) + '</small></div>'; }).join('');
  }
  async function loadPublishersData() {
    ST.publishers = await rpc('content_engine_publishers');
    var opts = ST.publishers.filter(function (p) { return p.status !== 'ended'; }).map(function (p) { return '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>'; }).join('');
    var def = ST.overview && ST.overview.settings && ST.overview.settings.default_publisher;
    $('dPub').innerHTML = opts + '<option value="">No publisher (EdgeDesk house style)</option>';
    $('gPubSel').innerHTML = opts + '<option value="">EdgeDesk (house)</option>';
    var d = ST.publishers.filter(function (p) { return p.slug === def; })[0];
    if (d) { $('dPub').value = d.id; $('gPubSel').value = d.id; }
  }
  function publisherById(id) { return ST.publishers.filter(function (p) { return p.id === id; })[0] || null; }

  /* ======================================================================
     OPPORTUNITIES
     ====================================================================== */
  function getJson(path) {
    return fetch('/' + path, { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  }
  async function loadArtifacts() {
    var A = CE.ARTIFACTS;
    var got = await Promise.all([A.cfb_games, A.cfb_brief, A.rankings, A.nfl_slate, A.nfl_injuries, A.published, A.evidence].map(getJson));
    /* the football evidence packets (tools/content/evidence.js builds and commits them):
       without them every draft fails the evidence gate, by design */
    var art = { cfbGames: got[0], cfbBrief: got[1], rankings: got[2], nflSlate: got[3], nflInjuries: got[4], published: got[5], evidence: got[6], marketSnapshots: [] };
    var season = (art.nflSlate && art.nflSlate.season) || (art.cfbGames && art.cfbGames.season) || new Date().getUTCFullYear();
    var weeks = [];
    if (art.nflSlate) { var w = CE.research.chooseWeek(art.nflSlate.games || [], Date.now()); if (w) weeks.push(w); }
    if (art.cfbBrief && art.cfbBrief.week) weeks.push(art.cfbBrief.week);
    var snaps = await Promise.all(weeks.filter(function (w, i) { return weeks.indexOf(w) === i; }).map(function (w) {
      return getJson(A.market.replace('{season}', season).replace('{ww}', (w < 10 ? '0' : '') + w));
    }));
    art.marketSnapshots = snaps.filter(Boolean);
    return art;
  }

  $('dGo').onclick = async function () {
    var btn = $('dGo'); btn.disabled = true;
    try {
      say('dMsg', '', 'Reading EdgeDesk’s research files…');
      var art = await loadArtifacts();
      if (!art.cfbGames && !art.nflSlate) { say('dMsg', 'err', 'Could not read the research files from this site.'); return; }
      var snap = ST.snapshot = CE.research.fromArtifacts(art, { now: Date.now() });
      var notes = [];
      var news = [];
      if ($('dNews').checked) {
        say('dMsg', '', 'Fetching trending headlines through the Edge Function…');
        try {
          var tr = await S.invoke(FN, { action: 'trending' }, { timeoutMs: 90000 });
          news = CE.news.match((tr && tr.items) || [], snap);
          notes.push((tr.items || []).length + ' headlines read, ' + news.length + ' about teams on this week’s slates' + ((tr.problems || []).length ? ' (' + tr.problems.length + ' feed(s) unavailable)' : ''));
        } catch (e) { notes.push('trending headlines unavailable: ' + S.message(e)); }
      }
      var pub = publisherById($('dPub').value);
      var opps = CE.discover(snap, { now: Date.now(), publisher: pub, news: news });
      if ($('dGsc').checked && opps.length) {
        try {
          var terms = opps.map(function (o) { return o.seo && o.seo.primary_keyword; }).filter(Boolean);
          var ev = await rpc('content_engine_search_evidence', { p_terms: terms });
          if (ev && ev._installed) {
            var gsc = {}; Object.keys(ev).forEach(function (k) { if (k[0] !== '_' && ev[k].impressions > 0) gsc[k] = ev[k]; });
            opps = CE.discover(snap, { now: Date.now(), publisher: pub, news: news, gsc: gsc });
            notes.push('Search Console: ' + Object.keys(gsc).length + ' keyword(s) with measured impressions');
          } else notes.push('Search Console data is not installed: demand stays an estimate');
        } catch (e) { notes.push('Search Console unavailable: ' + S.message(e)); }
      }
      say('dMsg', '', 'Saving ' + opps.length + ' opportunities…');
      var made = 0, refreshed = 0, bad = 0;
      for (var i = 0; i < opps.length; i++) {
        var o = opps[i];
        var r = await rpc('content_engine_opportunity_upsert', { p: Object.assign({}, o, { research_hash: CE.util.hash(JSON.stringify(o.research)) }), p_run: null });
        if (r && r.ok) { if (r.created) made++; else refreshed++; } else bad++;
      }
      await rpc('content_engine_log', { p_kind: 'discovery_run', p_detail: { found: opps.length, created: made, refreshed: refreshed, refused: bad, news: news.length, cfb_week: snap.cfb && snap.cfb.week, nfl_week: snap.nfl && snap.nfl.week } });
      say('dMsg', bad ? 'err' : 'ok', opps.length + ' opportunities: ' + made + ' new, ' + refreshed + ' refreshed' + (bad ? ', ' + bad + ' refused' : '') + '. '
        + 'Research: CFB week ' + (snap.cfb ? snap.cfb.week + ' (' + when(snap.cfb.generated_at) + ')' : '—') + ', NFL week ' + (snap.nfl ? snap.nfl.week + ' (' + when(snap.nfl.generated_at) + ')' : '—') + '.'
        + (notes.length ? '\n' + notes.join(' · ') : ''));
      await loadOverview(); await loadOpps();
    } catch (e) { fail('dMsg', e); }
    finally { btn.disabled = false; }
  };

  function scoreBlock(scores) {
    return '<div class="scores">' + Object.keys(CE.SCORE_WEIGHTS).map(function (k) {
      var s = scores && scores[k] || {};
      var v = Math.max(0, Math.min(100, +s.score || 0));
      return '<div class="sc" title="' + esc(s.basis || '') + '">' + esc(CE.SCORE_LABELS[k]) + '<b>' + v + '</b><div class="meter"><span style="width:' + v + '%"></span></div><div class="basis">' + esc(s.basis || '') + '</div></div>';
    }).join('') + '</div>';
  }
  function sourcesBlock(srcs) {
    return '<div class="srcs">' + (srcs || []).map(function (s) {
      return (s.kind === 'external_report' ? 'Reported: ' : 'EdgeDesk research: ') + link(s.url, s.publisher ? s.publisher + ' — ' + (s.title || '') : (s.label || s.path || s.url))
        + ' <span class="dim">· ' + esc(s.published_at ? 'published ' + when(s.published_at) : s.as_of ? 'as of ' + when(s.as_of) : '') + (s.retrieved_at ? ' · read ' + when(s.retrieved_at) : '') + '</span>';
    }).join('<br>') + '</div>';
  }
  async function loadOpps() {
    await loadOverview();
    if (!ST.publishers.length) await loadPublishersData();
    var list = await rpc('content_engine_opportunities', { p_status: $('oFilter').value || null, p_limit: 80 });
    var lg = $('oLeague').value;
    ST.opps = list;
    list = list.filter(function (o) { return !lg || o.league === lg; });
    if (!list.length) { $('oList').innerHTML = '<p class="note">No opportunities yet. Press <b>Discover now</b>, or wait for the weekly job.</p>'; return; }
    $('oList').innerHTML = list.map(function (o) {
      var p = o.priority, cls = p >= 75 ? 'hi' : p >= 60 ? 'mid' : 'lo';
      var d = o.demand || {};
      return '<div class="opp"><div class="top"><div class="prio ' + cls + '" title="editorial priority (weighted score)">' + esc(p) + '</div>'
        + '<div style="flex:1;min-width:240px"><div class="otitle">' + esc(o.title) + '</div>'
        + '<div class="sub"><span class="pill">' + esc(o.league.toUpperCase()) + '</span> <span class="pill">' + esc(CE.KINDS[o.kind] || o.kind) + '</span> '
        + (d.measured ? '<span class="pill ok">demand: measured (Search Console)</span>' : '<span class="pill est" title="' + esc(d.note || '') + '">demand: estimate</span>')
        + ' <span class="pill">' + esc(o.status) + '</span>' + (o.articles ? ' <span class="pill ok">' + o.articles + ' article(s)</span>' : '') + '</div>'
        + '<div class="sub">' + esc(o.angle || '') + '</div><div class="sub dim">' + esc(o.summary || '') + '</div>'
        + '<div class="sub">SEO: <b>' + esc(o.seo && o.seo.primary_keyword || '') + '</b> · ' + esc(o.seo && o.seo.headline || '') + '</div>'
        + '<div class="sub dim">Research as of ' + when(o.research_as_of) + ' · found ' + ago(o.discovered_at) + ' by ' + esc(o.discovered_by) + (o.expires_at ? ' · expires ' + when(o.expires_at) : '') + '</div></div>'
        + '<div class="row" style="gap:6px"><button class="sm" data-act="write" data-id="' + esc(o.id) + '">Write article</button>'
        + (o.status !== 'shortlisted' ? '<button class="g sm" data-act="shortlist" data-id="' + esc(o.id) + '">Shortlist</button>' : '')
        + (o.status !== 'dismissed' ? '<button class="d sm" data-act="dismiss" data-id="' + esc(o.id) + '">Dismiss</button>' : '<button class="g sm" data-act="restore" data-id="' + esc(o.id) + '">Restore</button>') + '</div></div>'
        + '<details style="margin-top:8px"><summary class="sub">Scores, demand and sources</summary>' + scoreBlock(o.scores)
        + '<div class="sub" style="margin-top:8px">' + esc(d.note || '') + '</div>' + sourcesBlock(o.sources) + '</details></div>';
    }).join('');
  }
  $('oFilter').onchange = function () { loadOpps().catch(function (e) { fail('dMsg', e); }); };
  $('oLeague').onchange = $('oFilter').onchange;
  $('oList').onclick = async function (ev) {
    var b = ev.target.closest('button[data-act]'); if (!b) return;
    var id = b.getAttribute('data-id'), act = b.getAttribute('data-act');
    try {
      if (act === 'write') { tab('gen'); await fillGenerator(); $('gOpp').value = id; onOppChange(); return; }
      if (act === 'dismiss') { var why = window.prompt('Why dismiss this topic? (kept in the log)', 'not right for this week'); if (why === null) return; await rpc('content_engine_opportunity_set_status', { p_id: id, p_status: 'dismissed', p_reason: why }); }
      if (act === 'shortlist') await rpc('content_engine_opportunity_set_status', { p_id: id, p_status: 'shortlisted', p_reason: null });
      if (act === 'restore') await rpc('content_engine_opportunity_set_status', { p_id: id, p_status: 'new', p_reason: null });
      await loadOpps();
    } catch (e) { fail('dMsg', e); }
  };

  /* ======================================================================
     GENERATOR + EDITOR
     ====================================================================== */
  async function fillGenerator() {
    if (!ST.publishers.length) await loadPublishersData();
    if (!ST.opps.length) ST.opps = await rpc('content_engine_opportunities', { p_status: null, p_limit: 80 });
    var cur = $('gOpp').value;
    $('gOpp').innerHTML = ST.opps.map(function (o) { return '<option value="' + esc(o.id) + '">[' + esc(o.priority) + '] ' + esc(o.league.toUpperCase()) + ' · ' + esc(o.title) + '</option>'; }).join('')
      || '<option value="">No open opportunities — discover first</option>';
    if (cur) $('gOpp').value = cur;
    onOppChange();
  }
  function onOppChange() {
    var o = ST.opps.filter(function (x) { return x.id === $('gOpp').value; })[0];
    /* only the formats this topic can honestly fill (a slate is not a news story) */
    var rec = (o && o.formats && o.formats.length) ? o.formats : Object.keys(CE.FORMATS);
    $('gFormat').innerHTML = rec.map(function (f, i) {
      return '<option value="' + f + '">' + esc(CE.FORMATS[f] ? CE.FORMATS[f].label : f) + (i === 0 ? ' (recommended)' : '') + '</option>';
    }).join('');
  }
  $('gOpp').onchange = onOppChange;
  async function fullOpp() {
    var id = $('gOpp').value; if (!id) throw new Error('Choose a topic first.');
    return rpc('content_engine_opportunity', { p_id: id });
  }
  function seoBriefHtml(o, outline) {
    var s = o.seo || {};
    var d = s.demand || o.demand || {};
    return '<div class="card"><h3 style="margin-top:0">SEO brief</h3><table>'
      + [['Primary keyword', s.primary_keyword], ['Secondary keywords', (s.secondary_keywords || []).join(' · ')], ['Search intent', s.intent],
         ['Recommended headline', outline ? outline.title : s.headline], ['Alternatives', (s.alternatives || []).join(' | ')],
         ['Meta description', outline ? outline.meta_description : s.meta_description], ['URL slug', outline ? outline.slug : s.slug],
         ['Teams', (s.teams || []).join(', ')], ['Players', (s.players || []).join(', ')], ['Audience', s.audience], ['Angle', s.angle],
         ['Search demand', (d.measured ? 'MEASURED — ' : 'ESTIMATE — ') + (d.note || '')]]
        .map(function (r) { return '<tr><th>' + esc(r[0]) + '</th><td>' + esc(r[1] || '—') + '</td></tr>'; }).join('')
      + '<tr><th>Internal links</th><td>' + (s.internal_links || []).map(function (l) { return link(l.url, l.anchor); }).join('<br>') + '</td></tr>'
      + '<tr><th>External links</th><td>' + ((s.external_links || []).map(function (l) { return link(l.url, l.anchor); }).join('<br>') || '—') + '</td></tr>'
      + '<tr><th>Structure</th><td>' + esc((s.structure || []).join(' → ')) + '</td></tr></table></div>';
  }
  $('gOutline').onclick = async function () {
    try {
      var o = await fullOpp(); ST.opp = o;
      var pub = publisherById($('gPubSel').value);
      var out = CE.outline(o, { publisher: pub, format: $('gFormat').value, angle: $('gAngle').value });
      $('gOutlineOut').innerHTML = seoBriefHtml(o, out) + '<div class="card"><h3 style="margin-top:0">Outline</h3><p class="sub"><i>' + esc(out.standfirst) + '</i></p><ol style="margin:8px 0 0 18px">'
        + out.sections.map(function (s) { return '<li style="margin:6px 0"><b>' + esc(s.heading || 'Introduction') + '</b><div class="sub">' + esc(s.plan) + '</div></li>'; }).join('') + '</ol></div>';
      $('gOutlineOut').classList.remove('hide');
      say('gMsgGen', 'ok', 'Outline ready. “Generate full draft” writes it out and saves it as a draft.');
    } catch (e) { fail('gMsgGen', e); }
  };
  $('gDraft').onclick = async function () {
    var btn = $('gDraft'); btn.disabled = true;
    try {
      var o = await fullOpp();
      var pubId = $('gPubSel').value || null;
      var pub = publisherById(pubId);
      var a = CE.draft(o, { publisher: pub, format: $('gFormat').value, angle: $('gAngle').value, now: Date.now() });
      var rep = CE.validate(a, o, { publisher: pub, now: Date.now() });
      var r = await rpc('content_engine_article_create', { p_opportunity: o.id, p_publisher: pubId, p_format: a.format, p_angle: a.angle, p: Object.assign({}, a, { checks: rep }), p_run: null });
      if (!r || !r.ok) { say('gMsgGen', 'err', 'Not created: ' + (r && (r.detail || r.reason))); return; }
      loadOverview().catch(function () {});
      say('gMsgGen', 'ok', r.existing ? 'This topic already has a live article for that publisher, format and angle — opened it instead of writing a copy.' : 'Draft saved (' + a.word_count + ' words). Edit it below, rewrite it with AI, then submit it for review.');
      await openEditor(r.id);
    } catch (e) { fail('gMsgGen', e); }
    finally { btn.disabled = false; }
  };

  async function openEditor(id) {
    var row = await rpc('content_engine_article', { p_id: id });
    ST.art = row; ST.opp = row.opportunity; ST.dirty = false;
    var editable = row.status === 'draft' || row.status === 'in_review' || row.status === 'approved' || row.status === 'ready_to_send';
    var stale = row.opportunity && row.research_hash !== row.opportunity.research_hash;
    var html = '<div class="card"><div class="row" style="align-items:center"><div style="flex:1"><div class="otitle">' + esc(row.title) + '</div>'
      + '<div class="sub">' + pill(row.status) + ' · ' + esc(pubName(row.publisher_id)) + ' · ' + esc(CE.FORMATS[row.format] ? CE.FORMATS[row.format].label : row.format)
      + ' · revision ' + esc(row.revision) + ' · ' + esc(row.generator) + ' · campaign <span class="mono">' + esc(row.campaign_code) + '</span></div>'
      + '<div class="sub dim">Research as of ' + when(row.research_as_of) + ' (' + ago(row.research_as_of) + ')</div></div></div>'
      + (stale ? '<div class="banner">The opportunity’s research has been refreshed since this draft was written. Regenerate from the new research or check every number against it before approving.</div>' : '')
      + (row.status === 'approved' || row.status === 'ready_to_send' ? '<div class="banner">This article is approved. Saving any change sends it back to review.</div>' : '')
      + '</div>';
    html += '<div class="grid2"><div>';
    html += '<div class="card"><div class="f"><label for="eTitle">Headline</label><input id="eTitle" value="' + esc(row.title) + '"' + (editable ? '' : ' disabled') + '></div>'
      + '<div class="row" style="margin-top:8px"><div class="f"><label for="eSlug">Slug</label><input id="eSlug" class="mono" value="' + esc(row.slug) + '"' + (editable ? '' : ' disabled') + '></div>'
      + '<div class="f"><label for="eKw">Primary keyword</label><input id="eKw" value="' + esc(row.primary_keyword || '') + '"' + (editable ? '' : ' disabled') + '></div></div>'
      + '<div class="f" style="margin-top:8px"><label for="eMeta">Meta description <span class="dim" id="eMetaN"></span></label><textarea id="eMeta" style="min-height:52px"' + (editable ? '' : ' disabled') + '>' + esc(row.meta_description || '') + '</textarea></div>'
      + '<div class="f" style="margin-top:8px"><label for="eStand">Standfirst</label><textarea id="eStand" style="min-height:52px"' + (editable ? '' : ' disabled') + '>' + esc(row.standfirst || '') + '</textarea></div></div>';
    (row.sections || []).forEach(function (s, i) {
      html += '<div class="sec" data-key="' + esc(s.key) + '"><div class="sh"><span class="pill">' + esc(s.key) + '</span>'
        + '<input data-h="' + i + '" value="' + esc(s.heading || '') + '" placeholder="(no heading)"' + (editable ? '' : ' disabled') + '>'
        + (editable ? '<button class="g sm" data-act="aisec" data-key="' + esc(s.key) + '">Rewrite with AI</button>' : '') + '</div>'
        + '<textarea data-b="' + i + '"' + (editable ? '' : ' disabled') + '>' + esc(s.body) + '</textarea></div>';
    });
    html += '<div class="card" style="margin-top:10px"><div class="row">'
      + (editable ? '<button data-act="save">Save</button><button class="g" data-act="check">Run checks</button><button class="g" data-act="aiall">Rewrite whole draft with AI</button>' : '')
      + (row.status === 'draft' ? '<button class="g" data-act="submit">Submit for review</button>' : '')
      + (row.status === 'in_review' ? '<button class="g" data-act="toreview">Open in review</button>' : '')
      + '</div><div class="msg" id="eMsg" role="status" aria-live="polite"></div></div>';
    html += '</div><div><div class="card"><h3 style="margin-top:0">Checks</h3><div id="eChecks"></div></div>'
      + '<div class="card"><h3 style="margin-top:0">Preview</h3><div class="preview" id="ePreview"></div></div>'
      + '<div class="card"><h3 style="margin-top:0">Research packet</h3>' + researchTable(row.opportunity) + sourcesBlock(row.opportunity && row.opportunity.sources) + '</div></div></div>';
    $('gEditor').innerHTML = html; $('gEditor').classList.remove('hide');
    renderChecks(row.checks, 'eChecks'); renderPreview();
    $('gEditor').oninput = function () { ST.dirty = true; renderPreview(); };
    $('gEditor').onclick = editorClick;
  }
  function collect() {
    var row = ST.art;
    var secs = (row.sections || []).map(function (s, i) {
      var h = document.querySelector('#gEditor [data-h="' + i + '"]'), b = document.querySelector('#gEditor [data-b="' + i + '"]');
      return { key: s.key, heading: h ? (h.value.trim() || null) : s.heading, body: b ? b.value : s.body };
    });
    var a = {
      format: row.format, angle: row.angle, title: $('eTitle').value.trim(), slug: CE.util.slugify($('eSlug').value.trim() || $('eTitle').value),
      meta_description: $('eMeta').value.trim(), standfirst: $('eStand').value.trim(), primary_keyword: $('eKw').value.trim(),
      secondary_keywords: row.secondary_keywords || [], sections: secs, generator: row.generator, research_as_of: row.research_as_of
    };
    a.word_count = CE.util.wordCount(a.standfirst + ' ' + secs.map(function (s) { return s.body; }).join(' '));
    return a;
  }
  function checkNow() {
    var row = ST.art;
    return CE.validate(collect(), row.opportunity, { publisher: row.publisher_profile, siblings: row.siblings || [], now: Date.now() });
  }
  function renderChecks(rep, id) {
    var el = $(id); if (!el) return;
    if (!rep || !rep.checks) { el.innerHTML = '<p class="note">Not checked yet.</p>'; return; }
    var cls = { pass: 'ok', warn: 'warn', fail: 'bad' };
    var rd = { READY: '<span class="pill ok">ready</span>', HOLD_FOR_REVIEW: '<span class="pill warn">hold for review</span>', BLOCKED: '<span class="pill bad">blocked</span>' }[rep.readiness] || '';
    el.innerHTML = '<div class="sub">' + (rep.ok ? '<span class="pill ok">all hard checks pass</span>' : '<span class="pill bad">' + (rep.failed || []).length + ' failing</span>')
      + ' ' + rd + ' <span class="dim">checked ' + when(rep.checked_at) + '</span></div>'
      + ((rep.holds || []).length ? '<div class="banner">Confirm before approving (the source verification point): <ul>' + rep.holds.map(function (h) { return '<li>' + esc(h) + '</li>'; }).join('') + '</ul></div>' : '')
      + '<ul class="checks">' + rep.checks.map(function (c) {
        return '<li><span class="pill ' + cls[c.status] + '">' + esc(c.status) + '</span><div><div>' + esc(c.label) + '</div>' + (c.detail ? '<div class="d">' + esc(c.detail) + '</div>' : '') + '</div></li>';
      }).join('') + '</ul>';
  }
  /* every claim the article cites: what it says, where it came from, when, and how far it is verified */
  function evidenceRecord(rep) {
    var rec = (rep && rep.evidence_record) || [];
    if (!rec.length) return '<p class="note">No evidence cited.</p>';
    return '<table class="t"><tr><th>Claim</th><th>Source</th><th>As of</th><th>Status</th></tr>' + rec.map(function (r) {
      var src = r.source ? (r.source.url ? '<a href="' + esc(r.source.url) + '" rel="noopener" target="_blank">' + esc(r.source.publisher || r.source.label) + '</a>' : esc(r.source.label || '')) : '';
      return '<tr><td>' + esc(r.text) + '</td><td>' + src + '</td><td>' + esc(r.observed_at ? when(r.observed_at) : '') + '</td><td><span class="pill ' + (r.needs_confirmation ? 'warn' : (/MODEL|MARKET/.test(r.verification) ? '' : 'ok')) + '">' + esc(r.verification.replace(/_/g, ' ').toLowerCase()) + '</span></td></tr>';
    }).join('') + '</table>';
  }
  function exportCtx(row) {
    return { publisher: row.publisher_profile, campaign: row.campaign_code, opportunity: row.opportunity, landing: row.landing_url };
  }
  function renderPreview() {
    var el = $('ePreview'); if (!el || !ST.art) return;
    var a = collect();
    el.innerHTML = CE.toHtml(a, exportCtx(ST.art));
    var n = $('eMetaN'); if (n) n.textContent = '(' + a.meta_description.length + ' characters)';
  }
  function researchTable(o) {
    if (!o || !o.research) return '';
    var gs = (o.research.games || []).slice(0, 8);
    if (!gs.length) return '<p class="note">No game-level numbers in this packet.</p>';
    return '<div class="tw"><table><tr><th>Game</th><th>Model</th><th>Win</th><th>Market</th><th>Kickoff</th></tr>' + gs.map(function (p) {
      var ms = p.market && p.market.status;
      return '<tr><td>' + esc(p.away + ' at ' + p.home) + '</td><td>' + esc(p.display && p.display.fair || '—') + '</td><td>' + esc(p.display && p.display.win || '—') + '</td>'
        + '<td>' + esc(p.display && p.display.market || 'none') + ' ' + (ms ? '<span class="pill ' + (ms === 'current' ? 'ok' : 'warn') + '">' + esc(ms) + '</span>' : '') + '</td><td>' + esc(p.kickoff_text || '') + '</td></tr>';
    }).join('') + '</table></div><p class="note">From the opportunity’s frozen packet, as of ' + when(o.research.as_of) + '. Every number in the article must appear here or in the packet’s context.</p>';
  }
  async function saveEditor(reason) {
    var a = collect(), rep = checkNow();
    var r = await rpc('content_engine_article_save', { p_id: ST.art.id, p: Object.assign({}, a, { checks: rep }), p_reason: reason || 'owner edit', p_expected_hash: ST.art.content_hash });
    if (!r || !r.ok) {
      say('eMsg', 'err', r && r.reason === 'changed_since_loaded' ? 'Someone (or the engine) saved a newer version since you opened this. Reload it before saving.' : 'Not saved: ' + (r && (r.detail || r.reason)));
      return false;
    }
    await openEditor(ST.art.id); loadOverview().catch(function () {});
    say('eMsg', rep.ok ? 'ok' : 'err', 'Saved as revision ' + r.revision + (r.status === 'in_review' && a ? ' — back in review' : '') + (rep.ok ? '. Every hard check passes.' : '. Some checks fail: fix them before submitting.'));
    return true;
  }
  async function aiRewrite(section) {
    if (ST.dirty && !(await saveEditor('saved before AI rewrite'))) return;
    say('eMsg', '', section ? 'Asking Claude to rewrite “' + section + '”… (checked before anything is saved)' : 'Asking Claude to rewrite the whole draft… (checked before anything is saved; up to two tries)');
    try {
      var r = await S.invoke(FN, { action: 'draft', article_id: ST.art.id, section: section || null }, { timeoutMs: 280000 });
      if (r && r.ok) { await openEditor(ST.art.id); loadOverview().catch(function () {}); say('eMsg', 'ok', 'Claude’s version passed every check and was saved as revision ' + r.revision + '.'); return; }
      var why = { ai_not_configured: 'AI is not configured (ANTHROPIC_API_KEY is not set on the Edge Function). The deterministic draft stands.',
        budget_exhausted: 'Today’s AI budget is used up (Settings). The draft stands.', not_editable: 'Only drafts and articles in review are rewritten.' }[r && r.reason];
      say('eMsg', 'err', why || ('Claude’s version did not pass the checks, so nothing was saved; the draft stands.' + (r && r.objections && r.objections.length ? '\nReasons: ' + r.objections.join(' · ') : '') + (r && r.detail ? '\n' + r.detail : '')));
    } catch (e) { fail('eMsg', e); }
  }
  async function editorClick(ev) {
    var b = ev.target.closest('button[data-act]'); if (!b) return;
    var act = b.getAttribute('data-act');
    b.disabled = true;
    try {
      if (act === 'save') await saveEditor('owner edit');
      if (act === 'check') { var rep = checkNow(); renderChecks(rep, 'eChecks'); say('eMsg', rep.ok ? 'ok' : 'err', rep.ok ? 'Every hard check passes (not saved yet).' : 'Some checks fail.'); }
      if (act === 'aiall') await aiRewrite(null);
      if (act === 'aisec') await aiRewrite(b.getAttribute('data-key'));
      if (act === 'submit') {
        if (ST.dirty && !(await saveEditor('saved before submitting'))) return;
        var r = await rpc('content_engine_article_submit', { p_id: ST.art.id });
        if (r && r.ok) { await openEditor(ST.art.id); loadOverview().catch(function () {}); say('eMsg', 'ok', 'In review. Open the Editorial review tab to verify and approve it.'); }
        else say('eMsg', 'err', 'Not submitted: ' + (r && r.reason === 'checks_failed' ? 'the saved version fails ' + JSON.stringify(r.failed) : (r && r.reason)));
      }
      if (act === 'toreview') { tab('review'); await openReview(ST.art.id); }
    } catch (e) { fail('eMsg', e); }
    finally { b.disabled = false; }
  }

  /* ======================================================================
     REVIEW
     ====================================================================== */
  var REVIEW_POINTS = [
    ['source_verification', 'Source verification', 'Every external report is attributed and linked; every EdgeDesk number traces to the research packet.'],
    ['data_freshness', 'Data freshness', 'Research and prices are recent enough; old prices are labelled with their capture time; no featured game has started.'],
    ['model_accuracy', 'Model accuracy', 'The projections in the copy match the packet (favorite, margin, win chance, totals) and are described as projections, not picks.'],
    ['seo_review', 'SEO review', 'Headline, slug, meta description and keyword use are natural and accurate.'],
    ['compliance', 'Compliance', 'No pick, lock, guarantee or staking language; disclaimer and attribution present; publisher’s requirements met.']
  ];
  async function loadReview() {
    await loadOverview();
    var list = await rpc('content_engine_articles', { p_status: 'in_review', p_limit: 50 });
    $('rList').innerHTML = list.length ? '<div class="card tw"><table><tr><th>Article</th><th>Publisher</th><th>Checks</th><th>Review</th><th>Updated</th><th></th></tr>' + list.map(function (a) {
      return '<tr><td>' + esc(a.title) + (a.research_stale ? ' <span class="pill warn">research refreshed</span>' : '') + '</td><td>' + esc(a.publisher ? a.publisher.name : 'EdgeDesk') + '</td><td>'
        + (a.checks_ok ? '<span class="pill ok">pass</span>' : '<span class="pill bad">fail</span>') + '</td><td>' + (a.review_complete ? '<span class="pill ok">complete</span>' : '<span class="pill">open</span>')
        + '</td><td>' + esc(ago(a.updated_at)) + '</td><td><button class="sm" data-open="' + esc(a.id) + '">Review</button></td></tr>';
    }).join('') + '</table></div>' : '<p class="note">Nothing is waiting for review.</p>';
  }
  $('rList').onclick = function (ev) { var b = ev.target.closest('button[data-open]'); if (b) openReview(b.getAttribute('data-open')).catch(function (e) { fail('appMsg', e); }); };
  async function openReview(id) {
    var row = await rpc('content_engine_article', { p_id: id });
    ST.art = row;
    var a = { format: row.format, title: row.title, slug: row.slug, meta_description: row.meta_description, standfirst: row.standfirst, primary_keyword: row.primary_keyword,
      secondary_keywords: row.secondary_keywords, sections: row.sections, word_count: row.word_count, research_as_of: row.research_as_of };
    var rep = CE.validate(a, row.opportunity, { publisher: row.publisher_profile, siblings: row.siblings || [], now: Date.now() });
    var rv = row.review || {};
    var reviewCurrent = rv.content_hash === row.content_hash;
    $('rDetail').innerHTML = '<div class="card"><div class="otitle">' + esc(row.title) + '</div><div class="sub">' + pill(row.status) + ' · ' + esc(pubName(row.publisher_id)) + ' · ' + esc(row.word_count) + ' words · '
      + esc(row.generator) + ' · revision ' + esc(row.revision) + '</div></div>'
      + '<div class="grid2"><div><div class="card"><h3 style="margin-top:0">Checks, re-run now</h3><div id="rChecks"></div></div>'
      + '<div class="card"><h3 style="margin-top:0">Sources</h3>' + sourcesBlock(row.opportunity && row.opportunity.sources) + '<p class="note">Research as of ' + when(row.research_as_of) + ' (' + ago(row.research_as_of) + ').</p></div>'
      + '<div class="card"><h3 style="margin-top:0">Evidence record</h3>' + evidenceRecord(rep) + '</div>'
      + '<div class="card"><h3 style="margin-top:0">Model numbers to verify</h3>' + researchTable(row.opportunity) + '</div>'
      + '<div class="card"><h3 style="margin-top:0">SEO sheet</h3><pre class="mono sub" style="white-space:pre-wrap">' + esc(CE.seoSheet(a, row.opportunity)) + '</pre></div>'
      + '<div class="card"><h3 style="margin-top:0">Editorial review</h3>' + REVIEW_POINTS.map(function (p) {
        return '<label class="chk" style="margin:6px 0;align-items:flex-start"><input type="checkbox" data-rv="' + p[0] + '"' + (reviewCurrent && rv[p[0]] ? ' checked' : '') + '><span><b>' + esc(p[1]) + '</b><div class="sub">' + esc(p[2]) + '</div></span></label>';
      }).join('') + '<div class="f" style="margin-top:6px"><label for="rNotes">Notes</label><textarea id="rNotes">' + esc(reviewCurrent ? rv.notes || '' : '') + '</textarea></div>'
      + (rv.content_hash && !reviewCurrent ? '<div class="banner">The content changed after the last review: review it again.</div>' : '')
      + '<div class="row" style="margin-top:10px"><button class="g" id="rSave">Save review</button><button id="rApprove"' + (rep.ok && row.checks_ok ? '' : ' disabled title="every automated check must pass first"') + '>Approve this exact version</button>'
      + '<button class="g" id="rEdit">Edit</button><button class="d" id="rBack">Send back to draft</button></div><div class="msg" id="rMsg" role="status" aria-live="polite"></div></div></div>'
      + '<div><div class="card"><h3 style="margin-top:0">The article as it will be exported</h3><div class="preview">' + CE.toHtml(a, exportCtx(row)) + '</div></div></div></div>';
    renderChecks(rep, 'rChecks');
    function reviewObj() { var o = { notes: $('rNotes').value }; document.querySelectorAll('#rDetail [data-rv]').forEach(function (c) { o[c.getAttribute('data-rv')] = c.checked; }); return o; }
    $('rSave').onclick = async function () { try { var r = await rpc('content_engine_article_review', { p_id: id, p_review: reviewObj() }); say('rMsg', 'ok', r.review_complete ? 'Review saved: all five points confirmed.' : 'Review saved (not complete).'); } catch (e) { fail('rMsg', e); } };
    $('rApprove').onclick = async function () {
      try {
        var r1 = await rpc('content_engine_article_review', { p_id: id, p_review: reviewObj() });
        if (!r1.review_complete) { say('rMsg', 'err', 'Confirm all five review points first.'); return; }
        var r = await rpc('content_engine_article_approve', { p_id: id, p_content_hash: row.content_hash });
        if (r && r.ok) { say('rMsg', 'ok', 'Approved. It is now in the publishing queue: mark it ready, export it, and send it yourself.'); await loadReview(); await loadOverview(); }
        else say('rMsg', 'err', 'Not approved: ' + ({ checks_failed: 'automated checks fail', review_incomplete: 'the review is incomplete', changed_since_loaded: 'the article changed since you opened it — reload', language: 'banned language: ' + JSON.stringify(r.terms), review_is_for_an_older_version: 'the review is for an older version' }[r && r.reason] || (r && r.reason)));
      } catch (e) { fail('rMsg', e); }
    };
    $('rEdit').onclick = async function () { tab('gen'); await openEditor(id); };
    $('rBack').onclick = async function () { try { var r = await rpc('content_engine_article_transition', { p_id: id, p_to: 'draft', p: { reason: 'sent back from review' } }); say('rMsg', r.ok ? 'ok' : 'err', r.ok ? 'Back to draft.' : r.reason); await loadReview(); } catch (e) { fail('rMsg', e); } };
    $('rDetail').scrollIntoView({ behavior: 'smooth' });
  }

  /* ======================================================================
     PUBLISHING QUEUE
     ====================================================================== */
  async function loadQueue() {
    await loadOverview();
    if (!ST.publishers.length) await loadPublishersData();
    var live = await rpc('content_engine_articles', { p_status: null, p_limit: 300 });
    var arch = await rpc('content_engine_articles', { p_status: 'archived', p_limit: 30 });
    ST.articles = live.concat(arch);
    $('pCols').innerHTML = CE.STATUSES.map(function (st) {
      var items = ST.articles.filter(function (a) { return a.status === st; });
      return '<div class="col"><h4>' + esc(CE.STATUS_LABELS[st]) + ' <span class="dim">' + items.length + '</span></h4>' + (items.map(function (a) {
        return '<div class="item"><button class="lnk" data-open="' + esc(a.id) + '">' + esc(a.title) + '</button><div class="sub">' + esc(a.publisher ? a.publisher.name : 'EdgeDesk') + ' · '
          + (a.checks_ok ? 'checks pass' : 'checks fail') + ' · ' + esc(ago(a.updated_at)) + '</div></div>';
      }).join('') || '<div class="sub dim">—</div>') + '</div>';
    }).join('');
  }
  $('pCols').onclick = function (ev) { var b = ev.target.closest('button[data-open]'); if (b) openQueueItem(b.getAttribute('data-open')).catch(function (e) { fail('appMsg', e); }); };
  async function openQueueItem(id) {
    if (!ST.publishers.length) await loadPublishersData();
    var row = await rpc('content_engine_article', { p_id: id });
    ST.art = row;
    var st = row.status;
    var exportable = ['approved', 'ready_to_send', 'sent', 'published'].indexOf(st) >= 0;
    var utm = CE.tagLink(row.landing_url || CE.SITE + '/today/', { source: row.publisher_profile ? row.publisher_profile.utm_source : 'direct', medium: 'publisher', campaign: row.campaign_code, content: row.format });
    var acts = '';
    if (st === 'draft') acts += '<button data-q="edit">Edit</button>';
    if (st === 'in_review') acts += '<button data-q="review">Review</button>';
    if (st === 'approved') acts += '<button data-q="ready">Mark ready to send</button><button class="g" data-q="toreview">Back to review</button>';
    if (st === 'ready_to_send') acts += '<button class="g" data-q="unready">Back to approved</button>';
    if (st === 'sent') acts += '<button data-q="published">Mark published…</button>';
    if (st === 'archived' && !row.sent_at) acts += '<button class="g" data-q="restore">Restore to draft</button>';
    if (st !== 'archived') acts += '<button class="d" data-q="archive">Archive</button>';
    $('pDetail').innerHTML = '<div class="card" style="margin-top:14px"><div class="otitle">' + esc(row.title) + '</div><div class="sub">' + pill(st) + ' · ' + esc(pubName(row.publisher_id)) + ' · revision ' + esc(row.revision)
      + (row.approved_at ? ' · approved ' + when(row.approved_at) : '') + (row.sent_at ? ' · sent ' + when(row.sent_at) : '') + (row.published_url ? ' · ' + link(row.published_url, 'published copy') : '') + '</div>'
      + '<div class="row" style="margin-top:10px">' + acts + '</div>'
      + '<h3>Export</h3><div class="row"><button class="g" data-q="docx"' + (exportable ? '' : ' disabled') + '>Download Word (.docx)</button><button class="g" data-q="pdf"' + (exportable ? '' : ' disabled') + '>Save as PDF</button><button class="g" data-q="md"' + (exportable ? '' : ' disabled') + '>Download Markdown</button><button class="g" data-q="html"' + (exportable ? '' : ' disabled') + '>Download HTML</button>'
      + '<button class="g" data-q="copyhtml"' + (exportable ? '' : ' disabled') + '>Copy HTML</button><button class="g" data-q="seo"' + (exportable ? '' : ' disabled') + '>Download SEO sheet</button></div>'
      + (exportable ? '' : '<p class="note">Export unlocks once the owner approves this exact version. Use the editor’s preview until then.</p>')
      + '<h3>Tagged referral link</h3><div class="sub mono" style="overflow-wrap:anywhere">' + esc(utm) + '</div><p class="note">Every EdgeDesk link in the export carries utm_source=' + esc(row.publisher_profile ? row.publisher_profile.utm_source : 'direct') + ', utm_medium=publisher and utm_campaign=' + esc(row.campaign_code) + ': visits, sign-ups, trials and paid conversions through it appear under Performance (counts only).</p>'
      + sendPanel(row)
      + (row.deliveries && row.deliveries.length ? '<h3>Sends recorded</h3>' + row.deliveries.map(function (d) { return '<div class="sub">' + when(d.delivered_at) + ' · ' + esc(d.method) + (d.note ? ' · ' + esc(d.note) : '') + '</div>'; }).join('') : '')
      + '<div class="msg" id="qMsg" role="status" aria-live="polite"></div></div>';
    if ($('sTo')) $('sTo').onchange = function () {
      /* the button and the greeting follow the chosen contact */
      var o = this.options[this.selectedIndex], nm = o.getAttribute('data-name') || '', fn = firstName(nm);
      var btn = document.querySelector('#pDetail button[data-q="email"]'); if (btn) btn.textContent = 'Send to ' + (fn || this.value);
      var n = $('sNote'); n.value = n.value.replace(/^Hi [^,\n]*,/, 'Hi ' + (fn || 'there') + ',');
    };
    $('pDetail').onclick = async function (ev) {
      var b = ev.target.closest('button[data-q]'); if (!b) return;
      var q = b.getAttribute('data-q');
      if (q === 'email' || q === 'emailtest') { await sendNow(row, q === 'emailtest', b); return; }
      var a = { format: row.format, title: row.title, slug: row.slug, meta_description: row.meta_description, standfirst: row.standfirst, primary_keyword: row.primary_keyword,
        secondary_keywords: row.secondary_keywords, sections: row.sections };
      try {
        var r;
        if (q === 'edit') { tab('gen'); await openEditor(id); return; }
        if (q === 'review') { tab('review'); await openReview(id); return; }
        if (q === 'ready') r = await rpc('content_engine_article_transition', { p_id: id, p_to: 'ready_to_send', p: {} });
        if (q === 'toreview') r = await rpc('content_engine_article_transition', { p_id: id, p_to: 'in_review', p: {} });
        if (q === 'unready') r = await rpc('content_engine_article_transition', { p_id: id, p_to: 'approved', p: {} });
        if (q === 'archive') { if (!window.confirm('Archive this article?')) return; r = await rpc('content_engine_article_transition', { p_id: id, p_to: 'archived', p: {} }); }
        if (q === 'restore') r = await rpc('content_engine_article_transition', { p_id: id, p_to: 'draft', p: {} });
        if (q === 'sent') {
          var msel = $('qMethod'), method = msel ? msel.value : 'manual_email';
          if (!window.confirm('Mark “' + row.title + '” as sent to ' + pubName(row.publisher_id) + '?\n\nUse this once you have sent it yourself. EdgeDesk sends nothing for this.')) return;
          if (st === 'approved') {
            r = await rpc('content_engine_article_transition', { p_id: id, p_to: 'ready_to_send', p: {} });
            if (r && r.ok === false) { say('qMsg', 'err', 'Not done: ' + (r.detail || r.reason)); return; }
          }
          r = await rpc('content_engine_article_transition', { p_id: id, p_to: 'sent', p: { method: method,
            note: 'sent by the owner: ' + (msel ? msel.options[msel.selectedIndex].text : 'emailed it myself').toLowerCase() } });
        }
        if (q === 'published') {
          var url = window.prompt('The published article’s URL (https://…)', ''); if (url === null) return;
          r = await rpc('content_engine_article_transition', { p_id: id, p_to: 'published', p: { url: url.trim() } });
        }
        if (q === 'md' || q === 'html' || q === 'copyhtml' || q === 'seo' || q === 'docx' || q === 'pdf') {
          var ctx = exportCtx(row);
          if (q === 'docx') download(row.slug + '.docx', CE.toDocx(a, ctx), CE.DOCX_TYPE);
          if (q === 'pdf') {
            /* the clean standalone article in its own window, then the browser's print dialog,
               where "Save as PDF" is the destination; opened before any await so no pop-up blocker objects */
            var w = window.open('', '_blank');
            if (!w) { say('qMsg', 'err', 'The browser blocked the PDF window: allow pop-ups for this page, then press Save as PDF again.'); return; }
            w.document.open(); w.document.write(CE.toHtml(a, Object.assign({ standalone: true }, ctx))); w.document.close();
            w.focus(); setTimeout(function () { try { w.print(); } catch (_) { /* the reader can still print from the window */ } }, 400);
          }
          if (q === 'md') download(row.slug + '.md', CE.toMarkdown(a, Object.assign({ frontMatter: true }, ctx)), 'text/markdown');
          if (q === 'html') download(row.slug + '.html', CE.toHtml(a, Object.assign({ standalone: true }, ctx)), 'text/html');
          if (q === 'copyhtml') copy(CE.toHtml(a, ctx), 'qMsg');
          if (q === 'seo') download(row.slug + '-seo.txt', CE.seoSheet(a, row.opportunity), 'text/plain');
          await rpc('content_engine_log', { p_kind: 'exported', p_detail: { as: q, revision: row.revision, content_hash: row.content_hash }, p_article: id });
          if (q === 'pdf') say('qMsg', 'ok', 'Opened revision ' + row.revision + ' to print: choose “Save as PDF” as the destination.');
          else if (q !== 'copyhtml') say('qMsg', 'ok', 'Exported revision ' + row.revision + '.');
          return;
        }
        if (r && r.ok === false) { say('qMsg', 'err', 'Not done: ' + (r.detail || r.reason)); return; }
        await loadQueue(); await openQueueItem(id); say('qMsg', 'ok', 'Done.');
      } catch (e) { fail('qMsg', e); }
    };
  }

  /* ── SEND TO PUBLISHER: the owner's own send, two ways ─────────────────
     1  Send it yourself: download the Word file (the editor touches it up),
        email it from your own inbox, then "Mark as sent" (one confirmation).
     2  Or email it from EdgeDesk: only the approved version; only once it is
        marked ready; only to a contact on the publisher's profile; the page
        names the address and asks first. The database checks all of it again
        (content_engine_send_claim). */
  function firstName(n) { return String(n || '').trim().split(/\s+/)[0] || ''; }
  function sendPanel(row) {
    var st = row.status;
    if (['approved', 'ready_to_send', 'sent', 'published'].indexOf(st) < 0) return '';
    var pub = publisherById(row.publisher_id);
    var contacts = ((pub && pub.contacts) || []).filter(function (c) { return c && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(c.email || '').trim()); });
    var sender = ST.overview && ST.overview.sender;
    var sends = row.sends || [];
    var hist = sends.length ? '<div class="sub" style="margin-top:8px">' + sends.map(function (x) {
      return (x.is_test ? 'Test to ' : 'To ') + esc(x.recipient_name ? x.recipient_name + ' <' + x.recipient + '>' : x.recipient) + ' · ' + esc(x.status) + ' · ' + esc(ago(x.finished_at || x.claimed_at)) + (x.error ? ' · ' + esc(x.error) : '');
    }).join('<br>') + '</div>' : '';
    if (st === 'sent' || st === 'published') return sends.length ? '<h3>Emails</h3>' + hist : '';
    if (!row.publisher_id) return '<h3>Send to publisher</h3><p class="note">This article has no publisher.</p>';
    var pname = pub ? pub.name : 'the publisher';
    var who = contacts.length && contacts[0].name ? firstName(contacts[0].name) : 'the editor';
    /* 1 — send it yourself: the editable Word file, then one click to record it */
    var self = '<div class="card" style="background:var(--bg)"><div class="otitle" style="font-size:14px">Send it yourself</div>'
      + '<p class="note" style="margin:6px 0 10px">Download the Word file and email it to ' + esc(who) + ' from your own inbox; they can touch it up in Word or Google Docs. It keeps the tagged EdgeDesk link and the disclaimer, and its last page (for the editor, not for publication) has the SEO details. Then mark it sent here.</p>'
      + '<div class="row"><button data-q="docx" type="button">Download Word file</button><button class="g" data-q="pdf" type="button" title="opens the article’s print view: choose Save as PDF">Save as PDF</button>'
      + '<div class="f" style="max-width:240px;flex:0 1 240px"><label for="qMethod">How you sent it</label><select id="qMethod">'
      + [['manual_email', 'I emailed it myself'], ['shared_document', 'I shared a document'], ['cms_upload', 'I uploaded it to their CMS'], ['other', 'Some other way']].map(function (m) { return '<option value="' + m[0] + '">' + esc(m[1]) + '</option>'; }).join('')
      + '</select></div><button class="g" data-q="sent" type="button">Mark as sent</button></div></div>';
    var head = '<h3>Send to ' + esc(pname) + '</h3>' + self;
    if (!contacts.length) return head + '<p class="note">To email it from EdgeDesk instead, add ' + esc(pname) + '’s contact (name and email) under <b>Publishers</b>.</p>' + hist;
    var c0 = contacts[0];
    var note = 'Hi ' + (firstName(c0.name) || 'there') + ',\n\n'
      + 'Here is “' + row.title + '” from EdgeDesk' + (pub ? ', ready for ' + pub.name : '') + '. It is attached as a Word document you can edit, and it is also below. The last page of the Word file has the headline, slug, meta description and keywords.\n\n'
      + 'Feel free to touch it up. Happy to adjust anything before it runs.\n\n'
      + 'Thanks,\n' + ((sender && sender.name) || '');
    return head + '<div class="card" style="background:var(--bg);margin-top:10px"><div class="otitle" style="font-size:14px">Or email it from EdgeDesk</div>'
      + '<div class="row" style="margin-top:8px"><div class="f"><label for="sTo">To</label><select id="sTo">' + contacts.map(function (c, i) {
          return '<option value="' + esc(String(c.email).trim().toLowerCase()) + '"' + (i === 0 ? ' selected' : '') + ' data-name="' + esc(c.name || '') + '">' + esc((c.name ? c.name + ' — ' : '') + String(c.email).trim()) + (c.role ? ' (' + esc(c.role) + ')' : '') + '</option>';
        }).join('') + '</select></div>'
      + '<div class="f" style="flex:2"><label for="sSubj">Subject</label><input id="sSubj" maxlength="150" value="' + esc(row.title) + '"></div></div>'
      + '<div class="f" style="margin-top:8px"><label for="sNote">Note (above the article)</label><textarea id="sNote" style="min-height:130px">' + esc(note) + '</textarea></div>'
      + '<div class="sub" style="margin-top:6px">From ' + esc(sender ? sender.from : 'the engine’s sender (Settings)') + ' · replies to ' + esc(sender ? sender.reply_to : '—') + ' · the approved version, with the Word file attached, the tagged EdgeDesk link and the disclaimer</div>'
      + '<div class="row" style="margin-top:10px"><button class="g" data-q="emailtest" type="button">Send a test to me</button>'
      + '<button data-q="email" type="button"' + (st === 'ready_to_send' ? '' : ' disabled title="mark it ready to send first"') + '>Send to ' + esc(c0.name ? firstName(c0.name) : c0.email) + '</button></div>'
      + (st === 'approved' ? '<p class="note">Mark it ready to send to unlock this. A test to yourself works now.</p>' : '')
      + hist + '</div>';
  }
  async function sendNow(row, test, btn) {
    var sel = $('sTo'), to = test ? String(S.email() || '').toLowerCase() : (sel && sel.value);
    var name = test ? 'you' : (sel && sel.options[sel.selectedIndex].getAttribute('data-name')) || to;
    if (!to) { say('qMsg', 'err', test ? 'Your sign-in address is unknown: sign in again.' : 'Choose a recipient.'); return; }
    var subj = $('sSubj').value.trim(), note = $('sNote').value;
    var ok = window.confirm(test
      ? 'Send a TEST of “' + row.title + '” to your own address (' + to + ')? It does not count as sent.'
      : 'Email “' + row.title + '” to ' + name + ' <' + to + '> now?\n\nThis sends the approved version, with the article attached, from ' + ((ST.overview && ST.overview.sender && ST.overview.sender.from) || 'the engine’s sender') + '.');
    if (!ok) return;
    btn.disabled = true; say('qMsg', '', test ? 'Sending the test…' : 'Sending to ' + name + '…');
    try {
      var r = await S.invoke(FN, { action: 'send', article_id: row.id, recipient: to, subject: subj, note: note, test: !!test }, { timeoutMs: 60000 });
      if (r && r.ok) {
        if (!test) { await loadQueue(); await openQueueItem(row.id); loadOverview().catch(function () {}); }
        say('qMsg', 'ok', r.already ? 'Already sent to ' + to + ' — nothing was sent twice.' : (test ? 'Test sent to ' + to + '.' : 'Sent to ' + name + ' <' + to + '>. Recorded as sent.')
          + (r.retried ? ' It went as first written: edits made after the unanswered try were not applied.' : '') + (r.warning ? ' ' + r.warning : ''));
        return;
      }
      var why = { email_not_configured: 'Email is not configured: RESEND_API_KEY is not set on the Supabase project.', not_ready: 'Mark it ready to send first.',
        not_approved: 'Only the approved version can be sent.', changed_since_loaded: 'The article changed since you opened it: reload it.', not_a_contact: 'That address is not one of the publisher’s contacts.',
        test_goes_to_you: 'A test goes only to your own sign-in address.', no_sender: 'Set an edgedesksports.com sender in Settings.', publisher_inactive: 'This publisher is paused or ended.',
        provider_rejected: 'Resend refused it: ', outcome_unknown: '' }[r && r.reason];
      say('qMsg', 'err', (why != null ? why : 'Not sent: ' + (r && r.reason) + '. ') + (r && r.detail ? r.detail : ''));
    } catch (e) { fail('qMsg', e); }
    finally { btn.disabled = false; }
  }

  /* ======================================================================
     PERFORMANCE
     ====================================================================== */
  async function loadPerf() {
    if (!ST.publishers.length) await loadPublishersData();
    var p = await rpc('content_engine_performance');
    var m = p.measured || {};
    var rows = p.articles || [];
    var tot = { visits: 0, signups: 0, trials: 0, paid: 0 };
    rows.forEach(function (r) { var f = r.first_party || {}; ['visits', 'signups', 'trials', 'paid'].forEach(function (k) { if (f[k] != null) tot[k] += f[k]; }); });
    var html = '<div class="kpis" style="margin-top:12px">'
      + [['Visits', m.visits ? tot.visits : null, 'first-party, tagged links'], ['Sign-ups', m.signups ? tot.signups : null, 'free accounts'], ['Trials', m.trials_paid ? tot.trials : null, 'trial starts'], ['Paid', m.trials_paid ? tot.paid : null, 'paid subscriptions'],
         ['Visit → sign-up', m.signups ? rate(tot.signups, tot.visits) : null, 'conversion'], ['Sign-up → paid', m.trials_paid ? rate(tot.paid, tot.signups) : null, 'conversion']]
        .map(function (k) { return '<div class="kpi"><i>' + esc(k[0]) + '</i><b>' + esc(k[1] == null ? '—' : k[1]) + '</b><small>' + esc(k[1] == null ? 'not measured' : k[2]) + '</small></div>'; }).join('') + '</div>';
    html += '<div class="card tw" style="margin-top:12px"><table><tr><th>Article</th><th>Publisher</th><th>Status</th><th>Campaign</th><th class="r">Visits</th><th class="r">Sessions</th><th class="r">Sign-ups</th><th class="r">Trials</th><th class="r">Paid</th><th class="r">Visit→sign-up</th><th class="r">Publisher views</th><th class="r">Referral clicks (reported)</th></tr>'
      + (rows.map(function (r) {
        var f = r.first_party || {}, pr = r.publisher_reported || {};
        return '<tr><td>' + esc(r.title) + (r.published_url ? ' ' + link(r.published_url, '↗') : '') + '</td><td>' + esc(r.publisher ? r.publisher.name : 'EdgeDesk') + '</td><td>' + pill(r.status) + '</td><td class="mono">' + esc(r.campaign_code) + '</td>'
          + '<td class="r">' + num(f.visits) + '</td><td class="r">' + num(f.sessions) + '</td><td class="r">' + num(f.signups) + '</td><td class="r">' + num(f.trials) + '</td><td class="r">' + num(f.paid) + '</td><td class="r">' + rate(f.signups, f.visits) + '</td>'
          + '<td class="r">' + (pr.page_views ? esc(pr.page_views.value) + ' <span class="dim">(' + esc(ago(pr.page_views.reported_at)) + ')</span>' : '—') + '</td><td class="r">' + (pr.referral_clicks ? esc(pr.referral_clicks.value) : '—') + '</td></tr>';
      }).join('') || '<tr><td colspan="12" class="dim">No sent or published articles yet.</td></tr>') + '</table></div>';
    html += '<h2>Benchmarks (user-reported reference values)</h2><div class="card tw"><table><tr><th>Publisher</th><th>What</th><th class="r">Value</th><th>Sample</th><th>Period</th><th>Source</th><th>Recorded</th></tr>'
      + ((p.benchmarks || []).map(function (b) {
        return '<tr><td>' + esc(b.publisher) + '</td><td>' + esc(b.label) + '</td><td class="r">' + esc(b.value != null ? b.value : b.value_low + '–' + b.value_high) + '</td><td>' + esc(b.sample_size ? b.sample_size + ' articles' : '—') + '</td><td>' + esc(b.period_label || '—') + '</td><td><span class="pill est">' + esc(b.source.replace('_', ' ')) + '</span></td><td>' + esc(ago(b.recorded_at)) + '</td></tr>';
      }).join('') || '<tr><td colspan="7" class="dim">None recorded. Add them under Publishers.</td></tr>') + '</table><p class="note">' + esc(p.note || '') + ' A benchmark is a reference point for comparison, not a target the engine optimises for.</p></div>';
    html += '<div class="row"><button class="g sm" id="perfCopy">Copy a publisher-safe summary</button></div><div class="msg" id="perfMsg"></div>';
    $('perfOut').innerHTML = html;
    $('pfArt').innerHTML = rows.map(function (r) { return '<option value="' + esc(r.id) + '">' + esc(r.title) + '</option>'; }).join('') || '<option value="">No sent articles yet</option>';
    $('perfCopy').onclick = function () {
      /* aggregate counts only, small numbers suppressed: nothing about any one reader */
      var s = function (n) { return n == null ? 'not measured' : n < 5 ? 'fewer than 5' : String(n); };
      var lines = ['EdgeDesk referral summary (first-party, counts only)'];
      rows.forEach(function (r) { var f = r.first_party || {}; lines.push('- ' + r.title + ': visits ' + s(f.visits) + ', new free accounts ' + s(f.signups)); });
      copy(lines.join('\n'), 'perfMsg');
    };
  }
  $('pfAdd').onclick = async function () {
    try {
      var r = await rpc('content_engine_performance_add', { p: { article_id: $('pfArt').value, metric: $('pfMetric').value, value: $('pfValue').value, source: $('pfSource').value,
        period_start: $('pfStart').value || null, period_end: $('pfEnd').value || null, note: $('pfNote').value || null } });
      say('pfMsg', r.ok ? 'ok' : 'err', r.ok ? 'Recorded.' : 'Not recorded: ' + (r.detail || r.reason));
      if (r.ok) await loadPerf();
    } catch (e) { fail('pfMsg', e); }
  };

  /* ======================================================================
     PUBLISHERS
     ====================================================================== */
  async function loadPublishers() {
    await loadPublishersData();
    $('pbList').innerHTML = '<div class="card tw"><table><tr><th>Publisher</th><th>Status</th><th>UTM source</th><th class="r">Articles</th><th class="r">Benchmarks</th><th></th></tr>' + ST.publishers.map(function (p) {
      return '<tr><td>' + esc(p.name) + (p.website ? ' ' + link(p.website, '↗') : '') + '</td><td>' + esc(p.status) + '</td><td class="mono">' + esc(p.utm_source) + '</td><td class="r">' + esc(p.articles) + '</td><td class="r">' + esc((p.benchmarks || []).length) + '</td><td><button class="sm g" data-edit="' + esc(p.id) + '">Edit</button></td></tr>';
    }).join('') + '</table></div>';
  }
  $('pbList').onclick = function (ev) { var b = ev.target.closest('button[data-edit]'); if (b) editPublisher(publisherById(b.getAttribute('data-edit'))); };
  $('pbNew').onclick = function () { editPublisher(null); };
  function editPublisher(p) {
    var isNew = !p;
    p = p || { name: '', slug: '', website: '', status: 'prospect', utm_source: '', editorial: {}, contacts: [], partnership: {}, distribution: { method: 'manual_email' }, approval: {}, benchmarks: [] };
    var e = p.editorial || {};
    var len = e.length || {};
    var cb = function (name, val, on) { return '<label><input type="checkbox" data-' + name + '="' + esc(val) + '"' + (on ? ' checked' : '') + '> ' + esc(name === 'sport' ? val.toUpperCase() : CE.KINDS[val] || val) + '</label>'; };
    var contacts = (p.contacts || []).map(function (c) { return contactRow(c); }).join('');
    $('pbEdit').innerHTML = '<div class="card" style="margin-top:14px"><h3 style="margin-top:0">' + (isNew ? 'New publisher' : esc(p.name)) + '</h3>'
      + '<div class="row"><div class="f"><label>Name</label><input id="pbName" value="' + esc(p.name) + '"></div>'
      + '<div class="f"><label>Slug</label><input id="pbSlug" class="mono" value="' + esc(p.slug) + '"' + (isNew ? '' : ' disabled') + '></div>'
      + '<div class="f"><label>Website (https)</label><input id="pbWeb" value="' + esc(p.website || '') + '"></div>'
      + '<div class="f" style="max-width:150px"><label>Status</label><select id="pbStatus">' + ['prospect', 'active', 'paused', 'ended'].map(function (s) { return '<option' + (p.status === s ? ' selected' : '') + '>' + s + '</option>'; }).join('') + '</select></div>'
      + '<div class="f" style="max-width:160px"><label>UTM source</label><input id="pbUtm" class="mono" value="' + esc(p.utm_source || '') + '"></div></div>'
      + '<fieldset style="margin-top:12px"><legend>Editorial profile</legend>'
      + '<div class="cbs">' + ['cfb', 'nfl'].map(function (s) { return cb('sport', s, (e.preferred_sports || []).indexOf(s) >= 0); }).join('') + '<label><input type="checkbox" id="pbBroad"' + (e.prefer_broad ? ' checked' : '') + '> prefers broad, searchable topics over single matchups</label></div>'
      + '<div class="cbs">' + Object.keys(CE.KINDS).map(function (k) { return cb('cat', k, (e.categories || []).indexOf(k) >= 0); }).join('') + '</div>'
      + '<div class="row" style="margin-top:8px"><div class="f" style="max-width:110px"><label>Min words</label><input id="pbMin" type="number" value="' + esc(len.min || '') + '"></div><div class="f" style="max-width:110px"><label>Max words</label><input id="pbMax" type="number" value="' + esc(len.max || '') + '"></div>'
      + '<div class="f" style="max-width:110px"><label>Max games</label><input id="pbGames" type="number" value="' + esc(e.max_games || '') + '"></div><div class="f"><label>Publishing cadence</label><input id="pbCad" value="' + esc(e.cadence || '') + '"></div></div>'
      + '<div class="f" style="margin-top:8px"><label>Editorial tone</label><textarea id="pbTone">' + esc(e.tone || '') + '</textarea></div>'
      + '<div class="f" style="margin-top:8px"><label>Audience</label><input id="pbAud" value="' + esc(e.audience || '') + '"></div>'
      + '<div class="f" style="margin-top:8px"><label>SEO requirements</label><textarea id="pbSeo">' + esc(e.seo_requirements || '') + '</textarea></div>'
      + '<div class="f" style="margin-top:8px"><label>Attribution requirement (added after EdgeDesk’s own line)</label><input id="pbAttr" value="' + esc(e.attribution || '') + '"></div>'
      + '<label class="chk" style="margin-top:8px"><input type="checkbox" id="pbLinks"' + (e.links_allowed !== false ? ' checked' : '') + '> the publisher allows a link back to EdgeDesk</label>'
      + '<div class="f" style="margin-top:8px"><label>Section order (keys, comma-separated, for publisher-specific articles)</label><input id="pbSecs" class="mono" value="' + esc((e.sections || []).join(', ')) + '"></div>'
      + '<div class="f" style="margin-top:8px"><label>Editorial notes</label><textarea id="pbNotes">' + esc(e.notes || '') + '</textarea></div></fieldset>'
      + '<fieldset><legend>Contacts (owner-only)</legend><div id="pbContacts">' + contacts + '</div><button class="g sm" type="button" id="pbAddC">Add contact</button></fieldset>'
      + '<fieldset><legend>Partnership &amp; distribution (owner-only)</legend><div class="f"><label>Arrangement / terms</label><textarea id="pbTerms">' + esc((p.partnership || {}).terms || '') + '</textarea></div>'
      + '<div class="row" style="margin-top:8px"><div class="f" style="max-width:220px"><label>Distribution method</label><select id="pbMethod">' + ['manual_email', 'cms_upload', 'shared_document', 'other'].map(function (m) { return '<option' + ((p.distribution || {}).method === m ? ' selected' : '') + '>' + m + '</option>'; }).join('') + '</select></div>'
      + '<div class="f"><label>Distribution notes</label><input id="pbDist" value="' + esc((p.distribution || {}).notes || '') + '"></div>'
      + '<label class="chk"><input type="checkbox" id="pbPubRev"' + ((p.approval || {}).publisher_review ? ' checked' : '') + '> the publisher reviews before publishing</label></div></fieldset>'
      + '<div class="row"><button id="pbSave">Save publisher</button></div><div class="msg" id="pbMsg"></div>'
      + (isNew ? '' : benchmarksHtml(p)) + '</div>';
    $('pbAddC').onclick = function () { $('pbContacts').insertAdjacentHTML('beforeend', contactRow({})); };
    $('pbContacts').onclick = function (ev) { var b = ev.target.closest('button[data-rmc]'); if (b) b.parentElement.remove(); };
    $('pbSave').onclick = async function () {
      var sel = function (attr) { return Array.prototype.map.call(document.querySelectorAll('#pbEdit [data-' + attr + ']:checked'), function (c) { return c.getAttribute('data-' + attr); }); };
      var ed = Object.assign({}, e, {
        preferred_sports: sel('sport'), categories: sel('cat'), prefer_broad: $('pbBroad').checked, tone: $('pbTone').value.trim(), audience: $('pbAud').value.trim(),
        length: $('pbMin').value && $('pbMax').value ? { min: +$('pbMin').value, max: +$('pbMax').value } : undefined, max_games: $('pbGames').value ? +$('pbGames').value : undefined,
        seo_requirements: $('pbSeo').value.trim(), attribution: $('pbAttr').value.trim() || null, links_allowed: $('pbLinks').checked, cadence: $('pbCad').value.trim(),
        sections: $('pbSecs').value.split(',').map(function (s) { return s.trim(); }).filter(function (s) { return CE.SECTION_HEADINGS.hasOwnProperty(s); }), notes: $('pbNotes').value.trim()
      });
      var cs = Array.prototype.map.call(document.querySelectorAll('#pbContacts .crow'), function (r) {
        return { name: r.querySelector('[data-c=name]').value.trim(), role: r.querySelector('[data-c=role]').value.trim(), email: r.querySelector('[data-c=email]').value.trim() };
      }).filter(function (c) { return c.name || c.email; });
      var body = { name: $('pbName').value.trim(), website: $('pbWeb').value.trim(), status: $('pbStatus').value, utm_source: $('pbUtm').value.trim().toLowerCase(), editorial: ed, contacts: cs,
        partnership: Object.assign({}, p.partnership, { terms: $('pbTerms').value.trim() }), distribution: { method: $('pbMethod').value, notes: $('pbDist').value.trim() },
        approval: Object.assign({}, p.approval, { owner_approval_required: true, publisher_review: $('pbPubRev').checked }) };
      if (isNew) body.slug = CE.util.slugify($('pbSlug').value || $('pbName').value); else body.id = p.id;
      try {
        var r = await rpc('content_engine_publisher_save', { p: body });
        say('pbMsg', r.ok ? 'ok' : 'err', r.ok ? 'Saved.' : 'Not saved: ' + (r.detail || r.reason));
        if (r.ok) { await loadPublishers(); editPublisher(publisherById(r.id)); }
      } catch (er) { fail('pbMsg', er); }
    };
    if (!isNew) wireBenchmarks(p);
  }
  function contactRow(c) {
    return '<div class="row crow" style="margin-bottom:6px"><div class="f"><label>Name</label><input data-c="name" value="' + esc(c.name || '') + '"></div><div class="f"><label>Role</label><input data-c="role" value="' + esc(c.role || '') + '"></div>'
      + '<div class="f"><label>Email</label><input data-c="email" type="email" value="' + esc(c.email || '') + '"></div><button class="d sm" type="button" data-rmc="1">Remove</button></div>';
  }
  function benchmarksHtml(p) {
    return '<h3>Benchmarks — historical, user-reported reference values</h3><div class="tw"><table><tr><th>What</th><th class="r">Value</th><th>Sample</th><th>Period</th><th>Source</th><th>Note</th></tr>'
      + ((p.benchmarks || []).map(function (b) {
        return '<tr><td>' + esc(b.label) + '</td><td class="r">' + esc(b.value != null ? b.value : b.value_low + '–' + b.value_high) + '</td><td>' + esc(b.sample_size || '—') + '</td><td>' + esc(b.period_label || '—') + '</td><td>' + esc(b.source) + '</td><td>' + esc(b.note || '') + '</td></tr>';
      }).join('') || '<tr><td colspan="6" class="dim">None yet.</td></tr>') + '</table></div>'
      + '<div class="row" style="margin-top:8px"><div class="f"><label>Metric</label><select id="bmMetric"><option value="avg_article_views">Average article views (publisher)</option><option value="edgedesk_article_views">EdgeDesk article views (earlier)</option><option value="referral_clicks">Referral clicks</option><option value="other">Other</option></select></div>'
      + '<div class="f" style="flex:2"><label>Label</label><input id="bmLabel" placeholder="e.g. Average views, five recent articles"></div>'
      + '<div class="f" style="max-width:100px"><label>Value</label><input id="bmVal" type="number" min="0"></div><div class="f" style="max-width:90px"><label>or low</label><input id="bmLo" type="number" min="0"></div><div class="f" style="max-width:90px"><label>high</label><input id="bmHi" type="number" min="0"></div></div>'
      + '<div class="row" style="margin-top:8px"><div class="f" style="max-width:120px"><label>Sample size</label><input id="bmN" type="number" min="1"></div><div class="f"><label>Period</label><input id="bmPer" placeholder="e.g. Sept. 2026"></div>'
      + '<div class="f"><label>Source</label><select id="bmSrc"><option value="user_reported">User-reported</option><option value="publisher_reported">Publisher-reported</option></select></div><div class="f" style="flex:2"><label>Note</label><input id="bmNote"></div>'
      + '<div class="f" style="flex:0 0 auto"><label>&nbsp;</label><button class="g" id="bmAdd" type="button">Add benchmark</button></div></div><div class="msg" id="bmMsg"></div>'
      + '<p class="note">Benchmarks are stored as reported, with their source, and are never shown as live analytics. They are a comparison point, not a success threshold.</p>';
  }
  function wireBenchmarks(p) {
    var btn = $('bmAdd'); if (!btn) return;
    btn.onclick = async function () {
      var body = { publisher_id: p.id, metric: $('bmMetric').value, label: $('bmLabel').value.trim(), value: $('bmVal').value || null, value_low: $('bmLo').value || null, value_high: $('bmHi').value || null,
        sample_size: $('bmN').value || null, period_label: $('bmPer').value.trim() || null, source: $('bmSrc').value, note: $('bmNote').value.trim() || null };
      try {
        var r = await rpc('content_engine_benchmark_add', { p: body });
        say('bmMsg', r.ok ? 'ok' : 'err', r.ok ? 'Recorded.' : 'Not recorded: ' + (r.detail || r.reason));
        if (r.ok) { await loadPublishersData(); editPublisher(publisherById(p.id)); }
      } catch (e) { fail('bmMsg', e); }
    };
  }

  /* ======================================================================
     SETTINGS & LOG
     ====================================================================== */
  async function loadSettings() {
    await loadOverview();
    if (!ST.publishers.length) await loadPublishersData();
    var s = ST.overview.settings;
    $('setForm').innerHTML = '<div class="row">'
      + '<div class="f"><label>Drafts per weekly run</label><input id="sDrafts" type="number" min="0" max="10" value="' + esc(s.drafts_per_run) + '"></div>'
      + '<div class="f"><label>Minimum priority to draft</label><input id="sMin" type="number" min="0" max="100" value="' + esc(s.min_priority) + '"></div>'
      + '<div class="f"><label>AI calls per day</label><input id="sLlm" type="number" min="0" max="200" value="' + esc(s.llm_calls_per_day) + '"></div>'
      + '<div class="f"><label>Feed fetches per day</label><input id="sFetch" type="number" min="0" max="500" value="' + esc(s.fetch_calls_per_day) + '"></div></div>'
      + '<div class="row" style="margin-top:8px"><div class="f"><label>Default publisher</label><select id="sPub"><option value="">None</option>' + ST.publishers.map(function (p) { return '<option value="' + esc(p.slug) + '"' + (p.slug === s.default_publisher ? ' selected' : '') + '>' + esc(p.name) + '</option>'; }).join('') + '</select></div>'
      + '<div class="f" style="flex:2"><label>Landing page for tagged links</label><input id="sLand" value="' + esc(s.landing_url) + '"></div>'
      + '<label class="chk"><input type="checkbox" id="sSched"' + (s.schedule_enabled ? ' checked' : '') + '> weekly job enabled</label>'
      + '<div class="f" style="flex:0 0 auto"><label>&nbsp;</label><button id="sSave" type="button">Save</button></div></div><div class="msg" id="sMsg"></div>'
      + '<h3>Send to publisher: the sender</h3><div class="row"><div class="f"><label>Sender name</label><input id="sSName" maxlength="60" value="' + esc(s.sender_name || '') + '" placeholder="' + esc(ST.overview.sender ? ST.overview.sender.name : '') + '"></div>'
      + '<div class="f"><label>Sender address (@edgedesksports.com)</label><input id="sSEmail" value="' + esc(s.sender_email || '') + '" placeholder="' + esc(ST.overview.sender ? ST.overview.sender.email : '') + '"></div>'
      + '<div class="f"><label>Replies go to</label><input id="sSReply" value="' + esc(s.reply_to_email || '') + '" placeholder="' + esc(ST.overview.sender ? ST.overview.sender.reply_to : '') + '"></div>'
      + '<div class="f" style="flex:0 0 auto"><label>&nbsp;</label><button class="g" id="sSSave" type="button">Save sender</button></div></div>'
      + '<p class="note">Now sending as <b>' + esc(ST.overview.sender ? ST.overview.sender.from : 'no sender set') + '</b>' + (s.sender_email ? '' : ' (the outbound engine’s sender, until you set one here)') + '. Leave a field empty to use the outbound engine’s.</p>'
      + '<p class="note">The weekly job (.github/workflows/content-engine.yml) discovers topics and drafts at most this many top opportunities above the priority floor, checks them, and puts the passing ones in your review queue. It never approves, sends or publishes. Budgets are enforced by the database before every AI call or feed fetch.</p>';
    $('sSave').onclick = async function () {
      try {
        var r = await rpc('content_engine_settings_save', { p: { drafts_per_run: +$('sDrafts').value, min_priority: +$('sMin').value, llm_calls_per_day: +$('sLlm').value, fetch_calls_per_day: +$('sFetch').value,
          default_publisher: $('sPub').value, landing_url: $('sLand').value.trim(), schedule_enabled: $('sSched').checked } });
        say('sMsg', r.ok ? 'ok' : 'err', r.ok ? 'Saved.' : 'Not saved: ' + (r.detail || r.reason));
      } catch (e) { fail('sMsg', e); }
    };
    $('sSSave').onclick = async function () {
      try {
        var r = await rpc('content_engine_sender_save', { p: { sender_name: $('sSName').value, sender_email: $('sSEmail').value, reply_to_email: $('sSReply').value } });
        say('sMsg', r.ok ? 'ok' : 'err', r.ok ? 'Sender saved: ' + (r.sender ? r.sender.from : '—') + '.' : 'Not saved: ' + (r.detail || r.reason));
        if (r.ok) await loadSettings();
      } catch (e) { fail('sMsg', e); }
    };
    var ov = ST.overview;
    $('runs').innerHTML = '<table><tr><th>Job</th><th>Period</th><th>By</th><th>Status</th><th>Counts</th><th>Started</th></tr>' + ((ov.runs || []).map(function (r) {
      return '<tr><td>' + esc(r.job) + '</td><td class="mono">' + esc(r.period_key) + '</td><td>' + esc(r.started_by) + '</td><td>' + esc(r.status) + (r.error ? ' <span class="dim">' + esc(r.error) + '</span>' : '') + '</td><td class="mono">' + esc(JSON.stringify(r.counts)) + '</td><td>' + esc(ago(r.started_at)) + '</td></tr>';
    }).join('') || '<tr><td colspan="6" class="dim">No runs yet.</td></tr>') + '</table>';
    $('problems').innerHTML = '<table><tr><th>When</th><th>Kind</th><th>By</th><th>Detail</th></tr>' + ((ov.problems || []).map(function (e) {
      return '<tr><td>' + esc(ago(e.at)) + '</td><td>' + esc(e.kind) + '</td><td>' + esc(e.actor) + '</td><td class="mono" style="white-space:normal">' + esc(JSON.stringify(e.detail).slice(0, 400)) + '</td></tr>';
    }).join('') || '<tr><td colspan="4" class="dim">Nothing has failed recently.</td></tr>') + '</table>';
    try {
      var st = await S.invoke(FN, { action: 'status' }, { timeoutMs: 20000 });
      $('aiStatus').innerHTML = (st.ai_configured ? 'AI drafting is configured (model <span class="mono">' + esc(st.model) + '</span>). Every AI draft is checked against the research before it is kept.'
        : 'AI drafting is <b>not configured</b>: set ANTHROPIC_API_KEY on the content_engine Edge Function. Until then every draft is EdgeDesk’s deterministic writer, which is complete on its own.')
        + '<br>' + (st.email_configured ? 'Send to publisher is configured (Resend).' : 'Send to publisher is <b>not configured</b>: set RESEND_API_KEY on the Supabase project (the newsletter’s key works).');
    } catch (e) { $('aiStatus').textContent = 'The content_engine Edge Function did not answer (' + S.message(e) + '). Deploy it to enable AI rewrites and trending headlines; everything else works without it.'; }
  }

  /* ── boot ──────────────────────────────────────────────────────────── */
  async function boot() {
    say('gMsg', '', S.hasSession() ? 'Checking access…' : '');
    var a = await S.checkAdmin();
    if (a.state === 'signed_out') { showGate(a.message, false); return; }
    if (a.state === 'not_admin') { showGate('This account is not a Content Engine owner (the outbound owner list).', true); return; }
    if (a.state === 'not_installed') { showGate('The Content Engine is not installed: run supabase/content_engine.sql in the SQL editor.', false); return; }
    if (a.state !== 'ok') { showGate(a.message, false); return; }
    showApp();
    try { await loadOverview(); await loadPublishersData(); } catch (e) { fail('appMsg', e); $('appMsg').classList.remove('hide'); }
    tab('opps');
  }
  if (S.hasSession()) boot();
})();
