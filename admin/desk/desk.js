/* ===========================================================================
   The desk page (admin/desk/) — owner only.

   Every database call is a public.desk_* door through the shared operator
   session (lib/edgedesk_admin_session.js); the database checks the owner on
   every one, and the publish gate is a trigger, so nothing this page does (or
   fails to do) can publish an article without its take. The preview is drawn
   by the live renderer (tools/articles/article_render.js) and the desk
   module (lib/edgedesk_desk.js), so what is previewed is what is built.
   =========================================================================== */
(function () {
  'use strict';
  var D = window.EDDesk;
  var RR = (window.EDART && window.EDART.render) || null;
  var S = window.EDAdminSession.create({
    url: SB_URL, key: SB_KEY, storageKey: 'edgedesk_desk_admin_session', adminRpc: 'desk_is_owner',
    onSignedOut: function (why) { showGate(why, false); }
  });
  var ST = { queue: null, art: null, index: null, published: null, takes: null, tab: 'drafts' };

  /* ── helpers ───────────────────────────────────────────────────────── */
  function $(id) { return document.getElementById(id); }
  var esc = D.esc;
  function say(id, kind, t) { var el = $(id); if (!el) return; el.className = 'msg ' + (kind || ''); el.textContent = t || ''; }
  function fail(id, e) {
    if (e && e.kind === 'signed_out') { showGate(e.message, false); return; }
    if (e && e.kind === 'forbidden') { showGate('This account is not the desk owner.', true); return; }
    if (e && e.kind === 'not_installed') { say(id, 'err', 'The desk is not installed: run supabase/desk_articles.sql in the SQL editor.'); return; }
    say(id, 'err', S.message(e));
  }
  function rpc(n, a) { return S.rpc(n, a || {}); }
  function when(x) {
    var t = Date.parse(x); if (!isFinite(t)) return '';
    try { return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(t)); } catch (_) { return new Date(t).toISOString(); }
  }
  function pill(status) {
    var map = { awaiting_take: ['Needs my take', 'warn'], ready: ['Ready to publish', 'ok'], published: ['Published', 'ok'], archived: ['Archived', ''] };
    var m = map[status] || [status, ''];
    return '<span class="pill ' + m[1] + '">' + esc(m[0]) + '</span>';
  }
  function copy(text, btn) {
    var done = function () { var o = btn.textContent; btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = o; }, 1500); };
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, function () { fallback(); });
    else fallback();
    function fallback() { var t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select(); try { document.execCommand('copy'); done(); } catch (_) {} t.remove(); }
  }
  async function getJson(path) {
    var r = await fetch(path, { cache: 'no-cache' });
    if (!r.ok) throw new Error(path + ' HTTP ' + r.status);
    return r.json();
  }

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
    $('gGo').disabled = true; say('gMsg', '', 'Signing in…');
    try { var r = await S.signIn(email, pass); $('gPass').value = ''; if (!r.ok) { say('gMsg', 'err', r.message); return; } await boot(); }
    finally { $('gGo').disabled = false; }
  };
  async function signOutNow() { await S.signOut(); showGate('', false); say('gMsg', 'ok', 'Signed out.'); }
  $('signOut').onclick = signOutNow; $('gOut').onclick = signOutNow;

  /* ── tabs ──────────────────────────────────────────────────────────── */
  var LOADERS = { drafts: loadQueue, editor: function () {}, games: loadGames, kit: loadKitList, perf: loadPerf, set: loadSettings };
  function tab(name) {
    ST.tab = name;
    document.querySelectorAll('.tabs button').forEach(function (b) {
      var on = b.getAttribute('data-tab') === name; b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    Object.keys(LOADERS).forEach(function (k) { $('tab-' + k).classList.toggle('hide', k !== name); });
    Promise.resolve(LOADERS[name]()).catch(function (e) { fail('appMsg', e); $('appMsg').classList.remove('hide'); });
  }
  document.querySelectorAll('.tabs button').forEach(function (b) { b.onclick = function () { tab(b.getAttribute('data-tab')); }; });

  /* ── drafts ────────────────────────────────────────────────────────── */
  async function loadQueue() {
    var q = ST.queue = await rpc('desk_queue');
    var c = q.counts || {};
    var n = (c.awaiting_take || 0) + (c.ready || 0);
    $('nDrafts').textContent = n; $('nDrafts').classList.toggle('hide', !n);
    $('kpis').innerHTML = [
      ['Needs my take', c.awaiting_take, 'drafted, waiting on me'],
      ['Ready to publish', c.ready, 'take written, not published'],
      ['Published', c.published, 'live, or live at the next build'],
      ['Newer data', c.newer_drafts, 'published, with a fresher draft']
    ].map(function (k) { return '<div class="kpi"><i>' + esc(k[0]) + '</i><b>' + esc(k[1] || 0) + '</b><small>' + esc(k[2]) + '</small></div>'; }).join('');
    var rows = q.articles || [];
    if (!rows.length) { $('queue').innerHTML = '<p class="note">No desk drafts yet. The daily job (desk-drafts.yml) writes them; run it from Actions to start now.</p>'; return; }
    $('queue').innerHTML = '<table><thead><tr><th>Status</th><th>Type</th><th>Title</th><th>Drafted</th><th>Data as of</th><th class="r">Numbers</th><th>Checks</th><th class="r">My take</th></tr></thead><tbody>'
      + rows.map(function (a) {
        return '<tr class="click" data-key="' + esc(a.article_key) + '"><td>' + pill(a.status) + (a.newer_draft ? ' <span class="pill warn">newer data</span>' : '') + '</td>'
          + '<td>' + esc(D.typeLabel(a.type)) + '<div class="dim">' + esc(a.sport) + ' ' + esc(a.period || '') + '</div></td>'
          + '<td><b>' + esc(a.title || '') + '</b></td><td>' + esc(when(a.generated_at)) + '</td><td>' + esc(when(a.data_as_of)) + '</td>'
          + '<td class="r">' + esc(a.numbers) + '</td><td>' + (a.checks_ok ? '<span class="pill ok">passed</span>' : '<span class="pill bad">failed</span>') + '</td>'
          + '<td class="r">' + (a.take_ok ? '<span class="pill ok">' + esc(a.take_chars) + '</span>' : '<span class="pill warn">' + esc(a.take_chars || 0) + ' / ' + esc(q.min_take_chars) + '</span>') + '</td></tr>';
      }).join('') + '</tbody></table>';
    $('queue').querySelectorAll('tr.click').forEach(function (tr) { tr.onclick = function () { openEditor(tr.getAttribute('data-key')); }; });
  }

  /* ── editor ────────────────────────────────────────────────────────── */
  function previewDoc(d, take) {
    var blocks = String(d.generated_body || '').split(/\n{2,}/), first = blocks.shift() || '';
    var takeHtml = take && RR ? RR.takeSectionHTML(take)
      : '<section class="a-take"><h2 class="a-takeh">My take</h2><p style="opacity:.6">Not written yet. The page cannot publish without it.</p></section>';
    var by = RR ? RR.bylineHTML({ published: d.generated_at, dataAsOf: d.data_as_of }) : '';
    return '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/articles/articles.css?v=5"></head>'
      + '<body class="a-body"><main class="a-wrap"><article class="a-article"><header class="a-hero"><span class="d-type">' + esc(D.typeLabel(d.type) + ' · ' + d.sport) + '</span>'
      + '<h1 class="a-h1">' + esc(d.title) + '</h1>' + by + '</header>'
      + '<div class="d-body">' + D.mdToHtml(first) + '</div>' + takeHtml + '<div class="d-body">' + D.mdToHtml(blocks.join('\n\n')) + '</div>'
      + '</article></main></body></html>';
  }
  function takeState() {
    var min = (ST.art && ST.art.min_take_chars) || D.MIN_TAKE_CHARS;
    var c = D.takeCheck($('take').value, min);
    var el = $('takeCount');
    el.textContent = c.chars + ' / ' + min + (c.ok ? ' ✓' : ' (' + c.short_by + ' to go)');
    el.className = 'counter ' + (c.ok ? 'ok' : 'short');
    $('takeNotes').textContent = c.notes.join(' ');
    return c;
  }
  function canPublish() {
    var a = ST.art, d = a && a.draft;
    if (!a || !d) return false;
    var saved = a.take && D.takeCheck(a.take.take, a.min_take_chars).ok;
    var checks = d.data_snapshot && d.data_snapshot.checks;
    var ok = checks && checks.verify && checks.verify.ok && checks.voice && checks.voice.ok;
    var unchanged = a.take && a.take.take === $('take').value;
    return !!(saved && ok && unchanged && a.article.status !== 'archived' && (a.article.status !== 'published' || a.article.current_draft_id !== a.article.published_draft_id));
  }
  function paintEditor() {
    var a = ST.art, d = a.draft, art = a.article;
    $('edEmpty').classList.add('hide'); $('ed').classList.remove('hide');
    $('edStatus').innerHTML = pill(art.status);
    $('edTitle').textContent = d.title;
    var newer = art.status === 'published' && art.current_draft_id !== art.published_draft_id;
    $('edNewer').classList.toggle('hide', !newer);
    if (newer) $('edNewer').textContent = 'This article is live with an older draft. The draft below has fresher data; publishing it replaces the page and keeps your take.';
    $('edPreview').srcdoc = previewDoc(d, $('take').value.trim() ? $('take').value : (a.take && a.take.take));
    var snap = d.data_snapshot || {}, ch = snap.checks || {};
    var v = ch.verify || {}, vo = ch.voice || {};
    $('edChecks').innerHTML = '<table><tbody>'
      + '<tr><td>Every number re-derived from its source</td><td>' + (v.ok ? '<span class="pill ok">' + esc(v.checked) + ' checked</span>' : '<span class="pill bad">failed</span> ' + esc((v.problems || []).map(function (p) { return p.key + ': ' + p.why; }).join('; '))) + '</td></tr>'
      + '<tr><td>Voice: first person, no em dashes, no hype</td><td>' + (vo.ok ? '<span class="pill ok">passed</span>' : '<span class="pill bad">failed</span> ' + esc((vo.issues || []).map(function (i) { return i.why + ' ("' + i.found + '")'; }).join('; '))) + '</td></tr>'
      + '<tr><td>My take</td><td>' + (a.take && D.takeCheck(a.take.take, a.min_take_chars).ok ? '<span class="pill ok">saved</span>' : '<span class="pill warn">needed</span>') + '</td></tr>'
      + '<tr><td>Data as of</td><td>' + esc(when(d.data_as_of)) + '</td></tr>'
      + '<tr><td>Source commit</td><td><code>' + esc(String(d.source_commit || '').slice(0, 12)) + '</code></td></tr>'
      + '</tbody></table>';
    var srcMap = {};
    (snap.sources || []).forEach(function (s) { srcMap[s.id] = s; });
    $('edSources').innerHTML = '<table><thead><tr><th>Source</th><th>What it is</th><th>Built</th><th>sha256</th><th>Commit</th></tr></thead><tbody>'
      + (snap.sources || []).map(function (s) {
        return '<tr><td><code>' + esc(s.file) + '</code></td><td>' + esc(s.what) + '</td><td>' + esc(when(s.generated_at)) + '</td><td><code>' + esc(String(s.sha256).slice(0, 12)) + '</code></td><td><code>' + esc(String(s.commit || '').slice(0, 10)) + '</code></td></tr>';
      }).join('') + '</tbody></table>';
    paintNumbers(srcMap);
    $('edHistory').innerHTML = '<table><thead><tr><th>Draft</th><th>Status</th><th>Generated</th><th>Body hash</th><th>Commit</th></tr></thead><tbody>'
      + (a.history || []).map(function (h) {
        return '<tr><td>#' + esc(h.id) + (h.id === art.published_draft_id ? ' <span class="pill ok">live</span>' : '') + (h.id === art.current_draft_id ? ' <span class="pill">current</span>' : '') + '</td><td>' + esc(h.status) + '</td><td>' + esc(when(h.generated_at)) + '</td><td><code>' + esc(String(h.body_hash).slice(0, 12)) + '</code></td><td><code>' + esc(String(h.source_commit || '').slice(0, 10)) + '</code></td></tr>';
      }).join('') + '</tbody></table>';
    $('publish').disabled = !canPublish();
    $('publish').textContent = art.status === 'published' ? 'Publish the newer draft' : 'Publish';
    $('publishNow').classList.toggle('hide', art.status !== 'published');
    $('withdraw').classList.toggle('hide', art.status !== 'published');
  }
  function paintNumbers(srcMap) {
    var d = ST.art.draft, snap = d.data_snapshot || {}, f = ($('numFilter').value || '').toLowerCase();
    var rows = (snap.numbers || []).map(function (n) { return { kind: 'number', key: n.key, shown: n.display, q: n.query }; })
      .concat((snap.facts || []).map(function (x) { return { kind: 'fact', key: x.key, shown: x.value, q: x.query }; }));
    var desc = function (q) { try { return D.describeQuery(q, srcMap); } catch (_) { return JSON.stringify(q); } };
    rows = rows.filter(function (r) { return !f || (r.key + ' ' + r.shown + ' ' + desc(r.q)).toLowerCase().indexOf(f) >= 0; });
    $('edNumbers').innerHTML = '<table><thead><tr><th>Printed</th><th>Key</th><th>Query</th></tr></thead><tbody>'
      + rows.slice(0, 400).map(function (r) {
        return '<tr><td><b>' + esc(r.shown) + '</b>' + (r.kind === 'fact' ? ' <span class="dim">fact</span>' : '') + '</td><td><code>' + esc(r.key) + '</code></td><td><code>' + esc(desc(r.q)) + '</code></td></tr>';
      }).join('') + '</tbody></table>' + (rows.length > 400 ? '<p class="note">' + (rows.length - 400) + ' more; filter to find one.</p>' : '');
  }
  $('numFilter').oninput = function () { if (!ST.art) return; var m = {}; ((ST.art.draft.data_snapshot || {}).sources || []).forEach(function (s) { m[s.id] = s; }); paintNumbers(m); };
  async function openEditor(key) {
    say('edMsg', '', '');
    ST.art = await rpc('desk_article', { p_key: key });
    $('take').value = (ST.art.take && ST.art.take.take) || '';
    takeState();
    tab('editor');
    paintEditor();
  }
  $('take').oninput = function () { takeState(); $('publish').disabled = true; };
  $('saveTake').onclick = async function () {
    if (!ST.art) return;
    $('saveTake').disabled = true;
    try {
      var r = await rpc('article_take_save', { p_article_id: ST.art.article.article_key, p_kind: 'desk', p_take: $('take').value });
      say('edMsg', r.ok ? 'ok' : 'warn', r.ok ? 'Saved. You can publish.' : 'Saved, but it is ' + r.chars + ' of ' + r.min + ' characters: publishing stays locked until it is longer.');
      ST.art = await rpc('desk_article', { p_key: ST.art.article.article_key });
      paintEditor(); loadQueue();
    } catch (e) { fail('edMsg', e); } finally { $('saveTake').disabled = false; }
  };
  $('publish').onclick = async function () {
    if (!ST.art || !canPublish()) return;
    if (!confirm('Publish "' + ST.art.draft.title + '" with your take? The page is built on the next publish run.')) return;
    $('publish').disabled = true;
    try {
      var r = await rpc('desk_publish', { p_key: ST.art.article.article_key });
      say('edMsg', 'ok', 'Published. The page appears at the next build; "Build the page now" starts one.');
      ST.art = await rpc('desk_article', { p_key: r.article_key });
      paintEditor(); loadQueue();
    } catch (e) { fail('edMsg', e); paintEditor(); }
  };
  $('publishNow').onclick = async function () {
    $('publishNow').disabled = true;
    try {
      var r = await S.invoke('desk_cron', { action: 'publish_now' });
      say('edMsg', r && r.ok ? 'ok' : 'err', r && r.ok ? 'The publish workflow is running. The page is usually live within ten minutes.' : 'Could not start it: ' + ((r && r.error) || 'unknown') + '. It will build on the next scheduled run.');
    } catch (e) { fail('edMsg', e); } finally { $('publishNow').disabled = false; }
  };
  $('withdraw').onclick = async function () {
    if (!ST.art || !confirm('Withdraw this article? Its page is removed at the next build. Nothing is deleted.')) return;
    try { await rpc('desk_withdraw', { p_key: ST.art.article.article_key, p_archive: false }); ST.art = await rpc('desk_article', { p_key: ST.art.article.article_key }); paintEditor(); loadQueue(); say('edMsg', 'ok', 'Withdrawn.'); }
    catch (e) { fail('edMsg', e); }
  };

  /* ── game articles held for a take ─────────────────────────────────── */
  async function loadGames() {
    var idx = ST.index = await getJson('/articles/data/index.json');
    var takes = await rpc('article_takes_owner', { p_kind: 'game' });
    var byId = {}; takes.forEach(function (t) { byId[t.article_id] = t; });
    var now = Date.now();
    var rows = (idx.articles || []).filter(function (r) {
      if (r.status === 'published' || r.status === 'archived') return false;
      var held = /(^|, )my_take(,|$)/.test(r.hold || '');
      var upcoming = r.article_type !== 'postgame' && Date.parse(r.game_time) > now;
      return held && (upcoming || r.article_type === 'postgame');
    }).sort(function (a, b) { return String(a.game_time).localeCompare(String(b.game_time)); });
    $('nGames').textContent = rows.length; $('nGames').classList.toggle('hide', !rows.length);
    if (!rows.length) { $('games').innerHTML = '<p class="note">Nothing is held for a take right now. The editorial pipeline adds articles here as it writes them.</p>'; return; }
    var min = (ST.queue && ST.queue.min_take_chars) || D.MIN_TAKE_CHARS;
    $('games').innerHTML = rows.map(function (r) {
      var t = byId[r.id];
      return '<div class="kitc" data-id="' + esc(r.id) + '"><div class="top"><span class="pill">' + esc(D.typeLabel(r.article_type)) + '</span><b>' + esc(r.title) + '</b>'
        + '<span class="dim">' + esc(r.sport) + ' · ' + esc(when(r.game_time)) + '</span>'
        + (t && t.ok ? '<span class="pill ok">take saved, publishes next run</span>' : '<span class="pill warn">needs my take</span>') + '</div>'
        + (r.fair_spread_text ? '<p class="note" style="margin:0 0 8px">My number: ' + esc(r.fair_spread_text) + (r.fair_total ? ', total ' + esc(r.fair_total) : '') + '. <a href="/articles/_preview/' + esc(r.slug) + '/" target="_blank" rel="noopener">Preview</a></p>' : '')
        + '<textarea class="kit" aria-label="My take for ' + esc(r.title) + '">' + esc(t ? t.take : '') + '</textarea>'
        + '<div class="row" style="margin-top:6px"><span class="counter" data-c></span><span class="sp"></span><button class="g sm" type="button" data-save>Save take</button></div><div class="msg" data-m></div></div>';
    }).join('');
    $('games').querySelectorAll('.kitc').forEach(function (box) {
      var ta = box.querySelector('textarea'), c = box.querySelector('[data-c]');
      var paint = function () { var k = D.takeCheck(ta.value, min); c.textContent = k.chars + ' / ' + min; c.className = 'counter ' + (k.ok ? 'ok' : 'short'); };
      ta.oninput = paint; paint();
      box.querySelector('[data-save]').onclick = async function () {
        var m = box.querySelector('[data-m]');
        try {
          var r = await rpc('article_take_save', { p_article_id: box.getAttribute('data-id'), p_kind: 'game', p_take: ta.value });
          m.className = 'msg ' + (r.ok ? 'ok' : 'warn');
          m.textContent = r.ok ? 'Saved. The editorial pipeline publishes it on its next run, with every check run again.' : 'Saved, but too short to publish (' + r.chars + ' of ' + r.min + ').';
        } catch (e) { m.className = 'msg err'; m.textContent = S.message(e); }
      };
    });
  }

  /* ── distribution kit ──────────────────────────────────────────────── */
  async function loadKitList() {
    if (!ST.queue) await loadQueue();
    if (!ST.published) { try { ST.published = await getJson('/articles/data/published.json'); } catch (_) { ST.published = { articles: [] }; } }
    var desk = (ST.queue.articles || []).filter(function (a) { return a.status === 'published'; });
    var games = (ST.published.articles || []).filter(function (a) { return a.type === 'pregame' || a.type === 'postgame'; })
      .sort(function (a, b) { return String(b.updated_at).localeCompare(String(a.updated_at)); }).slice(0, 60);
    $('kitPick').innerHTML = '<option value="">Choose a published article</option>'
      + (desk.length ? '<optgroup label="From my desk">' + desk.map(function (a) { return '<option value="desk:' + esc(a.article_key) + '">' + esc(a.title) + '</option>'; }).join('') + '</optgroup>' : '')
      + '<optgroup label="Game articles">' + games.map(function (g) { return '<option value="game:' + esc(g.slug) + '">' + esc(D.typeLabel(g.type) + ': ' + g.title) + '</option>'; }).join('') + '</optgroup>';
    $('kitPick').onchange = function () { buildKit($('kitPick').value).catch(function (e) { $('kit').innerHTML = '<p class="msg err">' + esc(S.message(e)) + '</p>'; }); };
  }
  async function deskArticle(key) {
    var a = await rpc('desk_article', { p_key: key });
    var d = a.published_draft || a.draft;
    return { type: d.type, slug: d.slug, url: D.SITE + '/articles/' + d.slug + '/', title: d.title, lead: d.lead, highlights: d.highlights || [],
      body_md: d.generated_body, take: a.article.published_take || (a.take && a.take.take), numbers: (d.data_snapshot || {}).numbers || [],
      reddit_title: d.reddit_title, published: a.article.status === 'published' };
  }
  /* A game article's kit leads with the one number the page is built on:
     my fair line for the game (or, after it, how that line did). */
  async function gameArticle(slug) {
    if (!ST.index) ST.index = await getJson('/articles/data/index.json');
    var e = (ST.index.articles || []).filter(function (r) { return r.slug === slug; })[0];
    if (!e) throw new Error('That article is not in the index.');
    var rec = await getJson('/articles/data/records/' + encodeURIComponent(e.id) + '.json');
    var lead = rec.fair_spread_text
      ? 'My number on ' + rec.away_team + ' at ' + rec.home_team + ': ' + rec.fair_spread_text + (rec.fair_total ? ', with a fair total of ' + rec.fair_total : '') + '.'
      : (rec.grading && rec.grading.bet_headline ? rec.away_team + ' at ' + rec.home_team + ': my pregame number went ' + String(rec.grading.bet_headline).toLowerCase() + '.' : rec.title);
    var nums = D.numberTokens(lead).map(function (t) { return { display: t }; });
    return { type: e.article_type, slug: rec.slug, url: D.SITE + '/articles/' + rec.slug + '/', title: rec.title, lead: lead, highlights: [],
      body_md: '', take: rec.my_take || '', numbers: nums, reddit_title: lead, published: rec.status === 'published' };
  }
  async function buildKit(v) {
    if (!v) { $('kit').innerHTML = ''; return; }
    var art = v.indexOf('desk:') === 0 ? await deskArticle(v.slice(5)) : await gameArticle(v.slice(5));
    var k = D.kit(art);
    var card = function (title, sub, parts, chk) {
      return '<div class="kitc"><div class="top"><b>' + esc(title) + '</b><span class="dim">' + esc(sub || '') + '</span>'
        + (chk.ok ? '<span class="pill ok">links the article, quotes its number</span>' : '<span class="pill bad">' + esc(chk.why.join('; ')) + '</span>') + '</div>'
        + parts.map(function (p, i) { return (p.label ? '<label>' + esc(p.label) + '</label>' : '') + '<textarea class="kit" readonly data-i="' + i + '">' + esc(p.text) + '</textarea>'
          + '<div class="row" style="margin:4px 0 8px"><button class="g sm" type="button" data-copy>Copy</button></div>'; }).join('') + '</div>';
    };
    $('kit').innerHTML = (art.take ? '' : '<div class="banner">This article has no "My take". The kit is weaker without your words; write one first where you can.</div>')
      + card('X', k.x.chars + ' / 280 characters', [{ text: k.x.text }], k.x.check)
      + card('LinkedIn', '', [{ text: k.linkedin.text }], k.linkedin.check)
      + card('Discord (EdgeDesk server)', '', [{ text: k.discord.text }], k.discord.check)
      + card('Reddit', 'no link in the body; check the subreddit allows a link comment', [{ label: 'Title', text: k.reddit.title }, { label: 'Body (plain text)', text: k.reddit.text }, { label: 'Comment with the link', text: k.reddit.comment }], k.reddit.check);
    $('kit').querySelectorAll('[data-copy]').forEach(function (b) {
      b.onclick = function () { copy(b.parentNode.previousElementSibling.value, b); };
    });
  }

  /* ── performance ───────────────────────────────────────────────────── */
  async function loadPerf() {
    if (!ST.published) { try { ST.published = await getJson('/articles/data/published.json'); } catch (_) { ST.published = { articles: [] }; } }
    var list = (ST.published.articles || []).map(function (a) { return { slug: a.slug, type: a.type, title: a.title, published_at: a.published_at || null }; });
    var p = await rpc('desk_article_performance', { p_days: Number($('perfDays').value), p_articles: list });
    var m = p.measured || {};
    $('perfMeasured').textContent = 'Measured: page views ' + (m.events ? 'yes' : 'NO') + ' · linked sessions ' + (m.linked_sessions ? 'yes' : 'NO')
      + ' · acquisition ' + (m.acquisition ? 'yes' : 'NO') + ' · Stripe trials and payments ' + (m.billing ? 'yes' : 'NO') + ' · referral codes ' + (m.referral_codes ? 'yes' : 'NO')
      + '. ' + (p.totals && p.totals.views != null ? p.totals.views + ' article views in the window.' : '');
    var types = p.by_type || [];
    var maxPaid = Math.max.apply(null, [1].concat(types.map(function (t) { return t.paid_per_1k_views || 0; })));
    $('perfTypes').innerHTML = types.length ? '<table><thead><tr><th>Type</th><th class="r">Articles</th><th class="r">Views</th><th class="r">Trials</th><th class="r">Paid</th><th class="r">Trials / 1k views</th><th class="r">Paid / 1k views</th><th></th></tr></thead><tbody>'
      + types.map(function (t) {
        return '<tr><td>' + esc(D.typeLabel(t.type)) + '</td><td class="r">' + esc(t.articles) + '</td><td class="r">' + esc(t.views) + '</td><td class="r">' + esc(t.trials_touched) + '</td><td class="r"><b>' + esc(t.paid_touched) + '</b></td>'
          + '<td class="r">' + esc(t.trials_per_1k_views == null ? '' : t.trials_per_1k_views) + '</td><td class="r">' + esc(t.paid_per_1k_views == null ? '' : t.paid_per_1k_views) + '</td>'
          + '<td><span class="bar" style="width:' + Math.round(80 * (t.paid_per_1k_views || 0) / maxPaid) + 'px"></span></td></tr>';
      }).join('') + '</tbody></table>' : '<p class="note">No article was read in this window.</p>';
    var rows = p.articles || [];
    $('perfRows').innerHTML = rows.length ? '<table><thead><tr><th>#</th><th>Article</th><th>Type</th><th class="r">Views</th><th class="r">Readers</th><th>Where views came from</th><th class="r">Trials</th><th class="r">Paid</th><th class="r">Paid, first page</th><th class="r">Paid, last page</th><th class="r">Paid with a code</th></tr></thead><tbody>'
      + rows.map(function (r, i) {
        var ch = Object.keys(r.channels || {}).sort(function (a, b) { return r.channels[b] - r.channels[a]; }).map(function (k) { return k + ' ' + r.channels[k]; }).join(' · ');
        return '<tr><td>' + (i + 1) + '</td><td><a href="/articles/' + esc(r.slug) + '/" target="_blank" rel="noopener">' + esc(r.title || r.slug) + '</a></td><td>' + esc(D.typeLabel(r.type)) + '</td>'
          + '<td class="r">' + esc(r.views) + '</td><td class="r">' + esc(r.visitors) + '</td><td class="dim">' + esc(ch) + '</td>'
          + '<td class="r">' + esc(r.trials_touched) + '</td><td class="r"><b>' + esc(r.paid_touched) + '</b></td><td class="r">' + esc(r.paid_first_touch == null ? '' : r.paid_first_touch) + '</td>'
          + '<td class="r">' + esc(r.paid_last_touch == null ? '' : r.paid_last_touch) + '</td><td class="r">' + esc(r.paid_with_referral_code) + '</td></tr>';
      }).join('') + '</tbody></table>' : '<p class="note">' + esc(p.note || 'Nothing measured yet.') + '</p>';
    $('perfNote').textContent = p.note || '';
  }
  $('perfGo').onclick = function () { loadPerf().catch(function (e) { fail('appMsg', e); $('appMsg').classList.remove('hide'); }); };

  /* ── settings ──────────────────────────────────────────────────────── */
  async function loadSettings() {
    if (!ST.queue) await loadQueue();
    var s = ST.queue.settings || {};
    $('setMin').value = s.min_take_chars || D.MIN_TAKE_CHARS;
    $('setNotify').checked = s.notify_enabled !== false;
    $('setGame').checked = s.require_take_for_game_articles !== false;
    try {
      var r = await fetch(SB_URL + '/functions/v1/desk_cron', { method: 'GET' });
      var h = await r.json();
      var map = { discord_dm: 'a Discord DM', discord_webhook: 'the owner-only Discord channel', dashboard_only: 'this page and the badge in the terminal only (no Discord channel is configured)' };
      $('setChannel').textContent = 'Notifications go to ' + (map[h.notify_channel] || h.notify_channel) + (h.dry_run ? ' (dry run: nothing is sent)' : '') + '. Function ' + h.build + '.';
    } catch (_) { $('setChannel').textContent = 'The desk_cron function did not answer, so notifications are not running yet: deploy it and run supabase/desk_articles_cron.sql.'; }
  }
  $('setSave').onclick = async function () {
    try {
      await rpc('desk_settings_save', { p_min_take_chars: Number($('setMin').value), p_notify: $('setNotify').checked, p_require_game: $('setGame').checked });
      ST.queue = null; await loadSettings(); say('setMsg', 'ok', 'Saved.');
    } catch (e) { fail('setMsg', e); }
  };

  /* ── boot ──────────────────────────────────────────────────────────── */
  async function boot() {
    say('gMsg', '', S.hasSession() ? 'Checking access…' : '');
    var a = await S.checkAdmin();
    if (a.state === 'signed_out') { showGate(a.message, false); return; }
    if (a.state === 'not_admin') { showGate('This account is not the desk owner (site_article_admins).', true); return; }
    if (a.state === 'not_installed') { showGate('The desk is not installed: run supabase/desk_articles.sql in the SQL editor.', false); return; }
    if (a.state !== 'ok') { showGate(a.message, false); return; }
    showApp();
    var m = /[?&]key=([^&]+)/.exec(location.search);
    try { await loadQueue(); } catch (e) { fail('appMsg', e); $('appMsg').classList.remove('hide'); }
    if (m) openEditor(decodeURIComponent(m[1])).catch(function (e) { fail('appMsg', e); });
    else tab('drafts');
  }
  if (S.hasSession()) boot();
})();
