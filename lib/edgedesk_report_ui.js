/* ===========================================================================
   EdgeDesk — the "Report a problem" screen.

   Deliberately separate from lib/edgedesk_report.js: that file decides what a
   report contains and whether it was stored, and is tested without a browser.
   This one is only pixels and event handlers, and carries its own styles so it
   looks the same on the landing page, in the terminal, inside Games and on the
   404 page without inheriting four different design systems.

   THE RULES IT EXISTS TO KEEP
     * The button never lies. It says "Sending…", then either an id the
       reporter can quote or the real reason it failed.
     * A failed write does not lose the report. The same text comes back as a
       prefilled email, and the typed words stay in the form.
     * The metadata is shown before it is sent. Somebody reporting a bug is
       entitled to see what they are attaching, and it is the fastest way to
       be trusted about what is NOT attached.
   =========================================================================== */
(function (root) {
  'use strict';
  var R = root.EDReport;
  if (!R || !root.document) return;
  var d = root.document, MOUNTED = false;

  var CSS = ''
  + '.edrp-back{position:fixed;inset:0;z-index:2147483000;background:rgba(4,6,10,.72);'
  +   'display:flex;align-items:flex-start;justify-content:center;overflow-y:auto;'
  +   'padding:max(16px,env(safe-area-inset-top)) 14px calc(28px + env(safe-area-inset-bottom));'
  +   '-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px)}'
  + '.edrp-back[hidden]{display:none}'
  + '.edrp{width:100%;max-width:460px;margin:auto;background:#11132f;color:#eceaf6;border:1px solid #222852;'
  +   'border-radius:16px;padding:20px 18px;font:400 14px/1.5 Inter,system-ui,-apple-system,sans-serif;'
  +   'box-shadow:0 24px 60px rgba(0,0,0,.5);position:relative;box-sizing:border-box}'
  /* The modal renders inside four different design systems. Anything it does
     not state, it inherits — and /games styles h2 uppercase, which turned the
     title into REPORT A PROBLEM there and nowhere else. Every text property
     the dialog cares about is therefore declared, not assumed. */
  + '.edrp,.edrp *{text-transform:none;letter-spacing:normal}'
  + '.edrp h2{margin:0 30px 4px 0;font-size:17px;font-weight:800;letter-spacing:-.01em;'
  +   'font-family:inherit;text-align:left;color:#eceaf6}'
  + '.edrp .edrp-ld{margin:0 0 14px;font-size:12.5px;color:#9095b8}'
  + '.edrp .edrp-x{position:absolute;top:12px;right:12px;width:32px;height:32px;line-height:1;'
  +   'background:none;border:1px solid #222852;border-radius:9px;color:#9095b8;font-size:17px;cursor:pointer}'
  + '.edrp label{display:block;font:700 10px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;'
  +   'letter-spacing:.07em!important;text-transform:uppercase!important;color:#787da4;margin:12px 0 5px}'
  + '.edrp input,.edrp select,.edrp textarea{width:100%;box-sizing:border-box;background:#171a3a;'
  +   'border:1px solid #222852;color:#eceaf6;border-radius:9px;padding:11px 12px;font:400 15px/1.45 inherit}'
  + '.edrp textarea{resize:vertical;min-height:96px}'
  + '.edrp input:focus,.edrp select:focus,.edrp textarea:focus{outline:2px solid #c9d94a;outline-offset:-1px}'
  + '.edrp-act{display:flex;gap:9px;margin-top:16px;flex-wrap:wrap}'
  + '.edrp-btn{flex:1 1 150px;min-height:46px;border-radius:10px;font:700 14px/1 inherit;cursor:pointer;'
  +   'border:1px solid #c9d94a;background:#c9d94a;color:#1b1f08;padding:0 14px}'
  + '.edrp-btn.ghost{background:none;color:#9095b8;border-color:#222852}'
  + '.edrp-btn[disabled]{opacity:.55;cursor:default}'
  + '.edrp-msg{margin-top:12px;font-size:12.5px;line-height:1.55;border-radius:9px;padding:10px 12px;display:none}'
  + '.edrp-msg.on{display:block}'
  + '.edrp-msg.ok{color:#2fb47c;background:rgba(47,180,124,.09);border:1px solid rgba(47,180,124,.3)}'
  + '.edrp-msg.err{color:#e26044;background:rgba(226,96,68,.09);border:1px solid rgba(226,96,68,.32)}'
  + '.edrp-msg a{color:inherit;font-weight:700}'
  + '.edrp-meta{margin-top:14px;border-top:1px solid #222852;padding-top:10px}'
  + '.edrp-meta summary{font-size:11.5px;color:#787da4;cursor:pointer}'
  + '.edrp-meta dl{margin:8px 0 0;font:400 11px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;color:#9095b8;'
  +   'display:grid;grid-template-columns:auto 1fr;gap:2px 10px;word-break:break-word}'
  + '.edrp-meta dt{color:#5f6488}.edrp-meta dd{margin:0}'
  + '.edrp-foot{margin-top:12px;font-size:11px;color:#5f6488;line-height:1.55}'
  + '.edrp-launch{position:fixed;right:14px;bottom:calc(14px + env(safe-area-inset-bottom));z-index:2147482000;'
  +   'background:#11132f;color:#9095b8;border:1px solid #222852;border-radius:999px;padding:9px 14px;'
  +   'font:600 12px/1 Inter,system-ui,sans-serif;cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.35)}'
  + '.edrp-launch:hover{color:#eceaf6;border-color:#c9d94a}'
  + '@media(max-width:420px){.edrp{padding:18px 14px}.edrp-btn{flex:1 1 100%}}';

  function style() {
    if (d.getElementById('edrp-style')) return;
    var el = d.createElement('style'); el.id = 'edrp-style'; el.textContent = CSS;
    (d.head || d.documentElement).appendChild(el);
  }

  function metaRows() {
    var m = R.metadata(), rows = [
      ['where', m.route], ['when', m.reported_at], ['build', m.app_version + ' · ' + m.surface],
      ['signed in', m.auth_state === 'authenticated' ? (m.user_email || 'yes') : m.auth_state.replace(/_/g, ' ')],
      ['screen', m.viewport], ['browser', m.user_agent.slice(0, 90)]
    ];
    return rows.map(function (r) {
      return '<dt>' + R.esc(r[0]) + '</dt><dd>' + R.esc(r[1] || '—') + '</dd>';
    }).join('');
  }

  var lastFocus = null;
  function build() {
    if (MOUNTED) return;
    style();
    var back = d.createElement('div');
    back.className = 'edrp-back'; back.id = 'edrpBack'; back.hidden = true;
    back.setAttribute('role', 'dialog'); back.setAttribute('aria-modal', 'true');
    back.setAttribute('aria-labelledby', 'edrpTitle');
    back.innerHTML =
      '<form class="edrp" id="edrpForm" novalidate>'
      + '<button type="button" class="edrp-x" id="edrpX" aria-label="Close">&times;</button>'
      + '<h2 id="edrpTitle">Report a problem</h2>'
      + '<p class="edrp-ld">Tell us what went wrong. It goes straight to the people who build EdgeDesk, and you will see here whether it was received.</p>'
      + '<label for="edrpCat">What kind of problem</label>'
      + '<select id="edrpCat">' + R.CATEGORIES.map(function (c) {
          return '<option>' + R.esc(c) + '</option>'; }).join('') + '</select>'
      + '<label for="edrpSum">One-line summary</label>'
      + '<input id="edrpSum" maxlength="200" placeholder="e.g. Confirming my email did nothing">'
      + '<label for="edrpDet">What happened</label>'
      + '<textarea id="edrpDet" rows="5" placeholder="What you did, what you expected, and what you saw instead."></textarea>'
      + '<label for="edrpSteps">Anything that would help us reproduce it <span style="text-transform:none;letter-spacing:0;color:#5f6488">(optional)</span></label>'
      + '<textarea id="edrpSteps" rows="2" placeholder="Optional."></textarea>'
      + '<div id="edrpContactWrap" hidden><label for="edrpContact">Your email, if you would like a reply <span style="text-transform:none;letter-spacing:0;color:#5f6488">(optional)</span></label>'
      + '<input id="edrpContact" type="email" autocomplete="email" inputmode="email" placeholder="you@email.com"></div>'
      + '<div class="edrp-act"><button class="edrp-btn" type="submit" id="edrpGo">Send report</button>'
      + '<button class="edrp-btn ghost" type="button" id="edrpCancel">Cancel</button></div>'
      + '<div class="edrp-msg" id="edrpMsg" role="status" aria-live="polite"></div>'
      + '<details class="edrp-meta"><summary>What gets sent with this</summary><dl id="edrpMeta"></dl>'
      + '<div class="edrp-foot">No password, no login token and no payment detail is ever included.</div></details>'
      + '</form>';
    d.body.appendChild(back);

    var form = d.getElementById('edrpForm'), msg = d.getElementById('edrpMsg');
    function say(t, kind) { msg.className = 'edrp-msg on ' + (kind || 'err'); msg.innerHTML = t; }
    function clear() { msg.className = 'edrp-msg'; msg.innerHTML = ''; }

    d.getElementById('edrpX').addEventListener('click', close);
    d.getElementById('edrpCancel').addEventListener('click', close);
    back.addEventListener('click', function (e) { if (e.target === back) close(); });
    d.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !back.hidden) close(); });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var go = d.getElementById('edrpGo'), label = go.textContent;
      var input = {
        category: d.getElementById('edrpCat').value,
        summary: d.getElementById('edrpSum').value,
        details: d.getElementById('edrpDet').value,
        steps: d.getElementById('edrpSteps').value,
        contact_email: d.getElementById('edrpContact').value
      };
      clear(); go.disabled = true; go.textContent = 'Sending…';
      R.submit(input).then(function (r) {
        go.disabled = false; go.textContent = label;
        if (r.ok) {
          /* A real receipt, not a thank-you. The id is what an operator
             searches for, so the reporter is given it. */
          form.innerHTML = '<h2>Report received</h2>'
            + '<p class="edrp-ld">Thank you — it is stored and will be read.'
            + (r.id ? ' Your reference is <b>' + R.esc(String(r.id).slice(0, 8)) + '</b>.' : '') + '</p>'
            + '<div class="edrp-act"><button class="edrp-btn" type="button" id="edrpDone">Close</button></div>';
          d.getElementById('edrpDone').addEventListener('click', close);
          return;
        }
        if (r.reason === 'input') { say(R.esc(r.message)); return; }
        /* The write failed. The report is not lost: it leaves as an email
           with every field already in it, and the form keeps what was typed. */
        say(R.esc(r.message) + ' <a href="' + R.esc(R.mailtoFor(r.row)) + '">Send it by email instead</a>.');
        try { console.error('issue report not stored', r.reason, r.status || ''); } catch (_) {}
      });
    });
    MOUNTED = true;
  }

  function open(opts) {
    opts = opts || {};
    build();
    var back = d.getElementById('edrpBack');
    lastFocus = d.activeElement;
    d.getElementById('edrpMeta').innerHTML = metaRows();
    /* Only ask for an address we do not already have. */
    d.getElementById('edrpContactWrap').hidden = (R.authState() === 'authenticated');
    if (opts.category && R.CATEGORIES.indexOf(opts.category) >= 0) d.getElementById('edrpCat').value = opts.category;
    if (opts.summary) d.getElementById('edrpSum').value = opts.summary;
    back.hidden = false;
    setTimeout(function () { try { d.getElementById('edrpSum').focus(); } catch (_) {} }, 40);
  }
  function close() {
    var back = d.getElementById('edrpBack');
    if (back) back.hidden = true;
    try { if (lastFocus && lastFocus.focus) lastFocus.focus(); } catch (_) {}
  }

  /* The floating button. Off by default — a page asks for it — so it never
     covers a control on a screen that already has a link to this. */
  function mountLauncher(label) {
    if (d.getElementById('edrpLaunch')) return;
    style();
    var b = d.createElement('button');
    b.id = 'edrpLaunch'; b.type = 'button'; b.className = 'edrp-launch';
    b.textContent = label || 'Report a problem';
    b.addEventListener('click', function () { open(); });
    d.body.appendChild(b);
  }

  R.open = open; R.close = close; R.mountLauncher = mountLauncher;

  /* Any element with data-ed-report anywhere on the page opens it, so a page
     can put the entry point where it belongs rather than accepting a floater. */
  d.addEventListener('click', function (e) {
    var t = e.target;
    while (t && t !== d.body) {
      if (t.getAttribute && t.hasAttribute('data-ed-report')) {
        e.preventDefault();
        open({ category: t.getAttribute('data-ed-report') || undefined });
        return;
      }
      t = t.parentNode;
    }
  });
})(typeof window !== 'undefined' ? window : globalThis);
