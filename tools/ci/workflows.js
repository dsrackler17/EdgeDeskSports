'use strict';
/* ===========================================================================
   THE WORKFLOWS, READ THE WAY GITHUB READS THEM — without a dependency.

   tools/ci/verify.js runs, on a laptop or in a session, the steps GitHub
   Actions would run on a pull request; tools/ci/integrity.js checks that every
   path a workflow names exists. Both need the workflow files as GitHub sees
   them, so this module holds:

     parseYaml(text)            the YAML subset .github/workflows/ uses: block
                                maps and sequences, plain / 'single' / "double"
                                scalars, [flow] and {flow} on one line, | and >
                                block scalars with chomping, comments. No
                                anchors, tags or multi-document streams (none
                                is used; an unsupported construct THROWS, it is
                                never guessed). workflows.test.js holds it equal
                                to PyYAML on every workflow in the repository.
     globToRegExp / pathsMatch  GitHub's filter-pattern rules (*, **, ?, +,
                                [..], leading ! to exclude, later patterns win)
     evalExpr(expr, ctx)        ${{ }} expressions on a pull_request; a value
                                that cannot be known locally is UNKNOWN, and
                                UNKNOWN is never read as true
     loadWorkflows / plan       which workflows a change triggers, and each
                                step: run it, or say exactly why it cannot run
                                here (a secret, a service, a step output)

   Run its tests: node tools/ci/workflows.test.js
   =========================================================================== */
const fs = require('fs');
const path = require('path');

/* ------------------------------------------------------------------ YAML */
function YamlError(msg, line) { const e = new Error(msg + (line != null ? ' (line ' + (line + 1) + ')' : '')); e.yamlLine = line; return e; }

function parseYaml(text) {
  const L = String(text).replace(/\r\n?/g, '\n').split('\n');
  if (L.some((s) => /^\t/.test(s))) throw YamlError('a tab in the indentation');
  let i = 0;
  const ind = (s) => /^ */.exec(s)[0].length;
  const blank = (s) => /^\s*(#.*)?$/.test(s);
  function skip() { while (i < L.length && blank(L[i])) i++; }
  /* a "key: value" line (the key plain or quoted); null when the content is not one */
  function keyOf(c) {
    let m = /^"((?:[^"\\]|\\.)*)"\s*:(?:\s+|$)(.*)$/.exec(c);
    if (m) return { key: dq(m[1]), rest: m[2] };
    m = /^'((?:[^']|'')*)'\s*:(?:\s+|$)(.*)$/.exec(c);
    if (m) return { key: m[1].replace(/''/g, "'"), rest: m[2] };
    if (/^[-?:,\[\]{}#&*!|>'"%@`]/.test(c) && !/^-[^\s]/.test(c)) return null;
    m = /^([^#]*?)\s*:(?:\s+|$)(.*)$/.exec(c);
    if (!m || m[1] === '' || /^\s/.test(m[1])) return null;
    return { key: m[1], rest: m[2] };
  }
  function dq(s) {
    return s.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_, e) => {
      if (e[0] === 'u' || e[0] === 'x') return String.fromCharCode(parseInt(e.slice(1), 16));
      return ({ n: '\n', t: '\t', r: '\r', '0': '\0', '"': '"', '\\': '\\', '/': '/', ' ': ' ', e: '\x1b' })[e] != null
        ? ({ n: '\n', t: '\t', r: '\r', '0': '\0', '"': '"', '\\': '\\', '/': '/', ' ': ' ', e: '\x1b' })[e] : e;
    });
  }
  function resolve(s) {
    if (s === '' || s === '~' || /^(null|Null|NULL)$/.test(s)) return null;
    if (/^(true|True|TRUE)$/.test(s)) return true;
    if (/^(false|False|FALSE)$/.test(s)) return false;
    if (/^[-+]?[0-9]+$/.test(s)) return Number(s);
    if (/^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/.test(s)) return Number(s);
    return s;
  }
  /* a plain scalar ends at " #" (a comment), whatever quotes it holds */
  function plainOf(s) { const k = s.search(/(^|\s)#/); return (k < 0 ? s : s.slice(0, k)).trim(); }
  /* a flow collection on one line: [a, 'b', {c: d}] or {a: b, c: [d]} */
  function flow(s, lineNo) {
    let p = 0;
    const ws = () => { while (p < s.length && /\s/.test(s[p])) p++; };
    function scalarUntil(stops) {
      ws();
      if (s[p] === '"') { const m = /^"((?:[^"\\]|\\.)*)"/.exec(s.slice(p)); if (!m) throw YamlError('an unclosed "string"', lineNo); p += m[0].length; return dq(m[1]); }
      if (s[p] === "'") { const m = /^'((?:[^']|'')*)'/.exec(s.slice(p)); if (!m) throw YamlError("an unclosed 'string'", lineNo); p += m[0].length; return m[1].replace(/''/g, "'"); }
      const st = p;
      while (p < s.length && stops.indexOf(s[p]) < 0 && !(s[p] === ':' && /[\s,\]}]/.test(s[p + 1] || ' '))) p++;
      return resolve(s.slice(st, p).trim());
    }
    function value() {
      ws();
      if (s[p] === '[') {
        p++; const out = []; ws();
        if (s[p] === ']') { p++; return out; }
        for (;;) { out.push(value()); ws(); if (s[p] === ',') { p++; ws(); if (s[p] === ']') { p++; return out; } continue; } if (s[p] === ']') { p++; return out; } throw YamlError('a malformed [flow sequence]', lineNo); }
      }
      if (s[p] === '{') {
        p++; const out = {}; ws();
        if (s[p] === '}') { p++; return out; }
        for (;;) {
          const k = scalarUntil(',}'); ws();
          if (s[p] !== ':') throw YamlError('a {flow mapping} key without a value', lineNo);
          p++; out[String(k)] = value(); ws();
          if (s[p] === ',') { p++; ws(); if (s[p] === '}') { p++; return out; } continue; }
          if (s[p] === '}') { p++; return out; }
          throw YamlError('a malformed {flow mapping}', lineNo);
        }
      }
      return scalarUntil(',]}');
    }
    const v = value(); ws();
    if (p < s.length && s[p] !== '#') throw YamlError('text after a flow collection', lineNo);
    return v;
  }
  /* the scalar after "key:" or "- ": quoted (may run on), flow, block, or plain (may run on) */
  function inline(rest, parentIndent) {
    const lineNo = i;
    const r = rest.trim();
    const bm = /^([|>])([+-]?)([1-9]?)([+-]?)\s*(#.*)?$/.exec(r);
    if (bm) { i++; return block(bm[1], bm[2] || bm[4], bm[3] ? Number(bm[3]) : 0, parentIndent); }
    if (r[0] === '[' || r[0] === '{') { i++; return flow(r, lineNo); }
    if (r[0] === '"' || r[0] === "'") {
      const q = r[0];
      let buf = r, line = i;
      const re = q === '"' ? /^"((?:[^"\\]|\\.)*)"\s*(#.*)?$/ : /^'((?:[^']|'')*)'\s*(#.*)?$/;
      for (;;) {
        const m = re.exec(buf);
        if (m) { i = line + 1; return q === '"' ? dq(m[1]) : m[1].replace(/''/g, "'"); }
        line++;
        if (line >= L.length) throw YamlError('an unclosed quoted scalar', lineNo);
        buf = buf + (L[line].trim() === '' ? '\n' : ' ') + L[line].trim();
        buf = buf.replace(/ \n /g, '\n');
      }
    }
    if (/^[&*!%@`]/.test(r)) throw YamlError('an anchor, alias, tag or reserved indicator (unsupported)', lineNo);
    let v = plainOf(r);
    i++;
    /* a plain scalar continues onto more-indented lines that are not comments; a
       "key:" there is a mis-indented mapping, which YAML (and GitHub) refuse */
    while (i < L.length && !blank(L[i]) && ind(L[i]) > parentIndent) {
      const more = plainOf(L[i].trim());
      if (/:(\s|$)/.test(more)) throw YamlError('a line indented deeper than its mapping ("mapping values are not allowed here")', i);
      v += ' ' + more; i++;
    }
    return resolve(v);
  }
  function block(kind, chomp, explicit, parentIndent) {
    const lines = [];
    let ci = explicit ? parentIndent + explicit : null;
    while (i < L.length) {
      const s = L[i];
      if (s.trim() === '') { lines.push(''); i++; continue; }
      const n = ind(s);
      if (ci == null) { if (n <= parentIndent) break; ci = n; }
      if (n < ci) break;
      lines.push(s.slice(ci));
      i++;
    }
    let trail = 0;
    while (lines.length && lines[lines.length - 1] === '') { lines.pop(); trail++; }
    let body;
    if (kind === '|') body = lines.join('\n');
    else {
      body = '';
      for (let k = 0; k < lines.length; k++) {
        const cur = lines[k];
        if (k === 0) { body = cur; continue; }
        const prev = lines[k - 1];
        if (cur === '') body += '\n';
        else if (prev === '' || /^\s/.test(cur) || /^\s/.test(prev)) body += (prev === '' ? '' : '\n') + cur;
        else body += ' ' + cur;
      }
    }
    if (!lines.length) return chomp === '+' ? '\n'.repeat(trail) : '';
    if (chomp === '-') return body;
    if (chomp === '+') return body + '\n' + '\n'.repeat(trail);
    return body + '\n';
  }
  function node(minIndent) {
    skip();
    if (i >= L.length) return null;
    const n = ind(L[i]);
    if (n < minIndent) return null;
    const c = L[i].slice(n);
    if (c === '-' || c.startsWith('- ')) return seq(n);
    if (keyOf(c)) return map(n);
    return inline(c, n - 1);
  }
  function map(n) {
    const out = {};
    for (;;) {
      skip();
      if (i >= L.length) break;
      const m = ind(L[i]);
      if (m < n) break;
      if (m > n) throw YamlError('a line indented deeper than its mapping', i);
      const c = L[i].slice(n);
      if (c === '-' || c.startsWith('- ')) break;
      const kv = keyOf(c);
      if (!kv) throw YamlError('a line that is not "key: value"', i);
      if (Object.prototype.hasOwnProperty.call(out, kv.key)) throw YamlError('a duplicate key "' + kv.key + '"', i);
      if (plainOf(kv.rest) === '' && !/^\s*[|>]/.test(kv.rest)) {
        i++; skip();
        if (i < L.length && ind(L[i]) > n) out[kv.key] = node(n + 1);
        else if (i < L.length && ind(L[i]) === n && /^-( |$)/.test(L[i].slice(n))) out[kv.key] = seq(n);
        else out[kv.key] = null;
      } else out[kv.key] = inline(kv.rest, n);
    }
    return out;
  }
  function seq(n) {
    const out = [];
    for (;;) {
      skip();
      if (i >= L.length) break;
      const m = ind(L[i]);
      if (m < n) break;
      if (m > n) throw YamlError('a line indented deeper than its sequence', i);
      const c = L[i].slice(n);
      if (!(c === '-' || c.startsWith('- '))) break;
      const rest = c.slice(1).replace(/^ +/, '');
      if (plainOf(rest) === '' && !/^[|>]/.test(rest)) { i++; out.push(node(n + 1)); continue; }
      const off = n + c.length - rest.length;
      if (keyOf(rest) && !/^["']/.test(rest) || /^["'][^"']*["']\s*:(\s|$)/.test(rest)) {
        L[i] = ' '.repeat(off) + rest;              /* "- key: v" opens a mapping at the key's column */
        out.push(map(off));
      } else out.push(inline(rest, n));
    }
    return out;
  }
  const doc = node(0);
  skip();
  if (i < L.length) throw YamlError('text the parser could not place', i);
  return doc;
}

/* ------------------------------------------------- GitHub filter patterns */
/* docs.github.com "Filter pattern cheat sheet": * any run of characters but /,
   ** any run including /, ? zero or one of the preceding character, + one or
   more of it, [..] one character from a set or range, ! (leading) excludes */
function globToRegExp(pattern) {
  let re = '', p = 0;
  const s = String(pattern);
  while (p < s.length) {
    const ch = s[p];
    if (ch === '*') {
      if (s[p + 1] === '*') {
        if (s[p + 2] === '/') { re += '(?:.*/)?'; p += 3; continue; }
        re += '.*'; p += 2; continue;
      }
      re += '[^/]*'; p++; continue;
    }
    if (ch === '?' || ch === '+') { re += ch; p++; continue; }
    if (ch === '[') { const e = s.indexOf(']', p + 1); if (e > p) { re += s.slice(p, e + 1); p = e + 1; continue; } }
    re += ch.replace(/[\\^$.|(){}\[\]]/g, '\\$&');
    p++;
  }
  return new RegExp('^' + re + '$');
}
/* GitHub's rule: patterns apply in order, a later ! pattern excludes a path an
   earlier one included and a later positive one includes it again */
function pathMatches(patterns, file) {
  let hit = false;
  for (const raw of patterns || []) {
    const neg = String(raw).startsWith('!'), pat = neg ? String(raw).slice(1) : String(raw);
    if (globToRegExp(pat).test(file)) hit = !neg;
  }
  return hit;
}
function pathsMatch(patterns, files) { return (files || []).some((f) => pathMatches(patterns, f)); }

/* ------------------------------------------------------- ${{ }} expressions */
const UNKNOWN = { unknown: true, toString() { return '<unknown>'; } };
const isU = (v) => v === UNKNOWN;
function evalExpr(src, ctx) {
  let s = String(src).trim();
  const wrapped = /^\$\{\{([\s\S]*)\}\}$/.exec(s);
  if (wrapped) s = wrapped[1];
  const toks = [];
  const T = /\s*(?:(\d+(?:\.\d+)?)|'((?:[^']|'')*)'|(==|!=|<=|>=|&&|\|\||[!<>(),.\[\]*])|([A-Za-z_][\w-]*))/y;
  let m;
  T.lastIndex = 0;
  while (T.lastIndex < s.length) {
    if (/^\s*$/.test(s.slice(T.lastIndex))) break;
    m = T.exec(s);
    if (!m) throw new Error('cannot read the expression: ' + src);
    if (m[1] != null) toks.push({ t: 'lit', v: Number(m[1]) });
    else if (m[2] != null) toks.push({ t: 'lit', v: m[2].replace(/''/g, "'") });
    else if (m[3] != null) toks.push({ t: m[3] });
    else toks.push({ t: 'id', v: m[4] });
  }
  let p = 0;
  const peek = () => toks[p] || { t: 'eof' };
  const eat = (t) => { if (peek().t !== t) throw new Error('expected ' + t + ' in: ' + src); return toks[p++]; };
  const truthy = (v) => (isU(v) ? UNKNOWN : !!v && v !== 0 && v !== '');
  function or() { let a = and(); while (peek().t === '||') { p++; const b = and(); a = isU(a) ? (truthy(b) === true ? b : UNKNOWN) : (truthy(a) ? a : b); } return a; }
  function and() { let a = cmp(); while (peek().t === '&&') { p++; const b = cmp(); a = isU(a) ? (truthy(b) === false ? b : UNKNOWN) : (!truthy(a) ? a : b); } return a; }
  function norm(v) { return v == null ? '' : v; }
  function cmp() {
    let a = un();
    while (['==', '!=', '<', '>', '<=', '>='].indexOf(peek().t) >= 0) {
      const op = toks[p++].t, b = un();
      if (isU(a) || isU(b)) { a = UNKNOWN; continue; }
      const x = typeof norm(a) === 'string' ? String(norm(a)).toLowerCase() : norm(a), y = typeof norm(b) === 'string' ? String(norm(b)).toLowerCase() : norm(b);
      a = op === '==' ? x === y : op === '!=' ? x !== y : op === '<' ? x < y : op === '>' ? x > y : op === '<=' ? x <= y : x >= y;
    }
    return a;
  }
  function un() { if (peek().t === '!') { p++; const v = un(); return isU(v) ? UNKNOWN : !truthy(v); } return post(prim()); }
  function prim() {
    const k = peek();
    if (k.t === 'lit') { p++; return k.v; }
    if (k.t === '(') { p++; const v = or(); eat(')'); return v; }
    if (k.t === 'id') {
      p++;
      if (k.v === 'true') return true;
      if (k.v === 'false') return false;
      if (k.v === 'null') return null;
      if (peek().t === '(') {
        p++; const args = [];
        if (peek().t !== ')') { args.push(or()); while (peek().t === ',') { p++; args.push(or()); } }
        eat(')');
        return call(k.v, args);
      }
      return { ref: [k.v] };
    }
    throw new Error('unexpected token in: ' + src);
  }
  function post(v) {
    while (peek().t === '.' || peek().t === '[') {
      if (peek().t === '.') { p++; const id = eat('id'); v = v && v.ref ? { ref: v.ref.concat(id.v) } : UNKNOWN; }
      else { p++; const key = or(); eat(']'); v = v && v.ref && !isU(key) ? { ref: v.ref.concat(String(key)) } : UNKNOWN; }
    }
    return v && v.ref ? lookup(v.ref) : v;
  }
  function lookup(ref) {
    let cur = ctx;
    for (const part of ref) {
      if (cur === UNKNOWN) return UNKNOWN;
      if (cur == null || typeof cur !== 'object') return null;
      cur = Object.prototype.hasOwnProperty.call(cur, part) ? cur[part] : (cur.__unknown ? UNKNOWN : null);
    }
    return cur;
  }
  function call(name, args) {
    const fn = name.toLowerCase();
    if (fn === 'always' || fn === 'success') return true;
    if (fn === 'failure' || fn === 'cancelled') return false;
    if (args.some(isU)) return UNKNOWN;
    if (fn === 'contains') return Array.isArray(args[0]) ? args[0].some((x) => String(x).toLowerCase() === String(args[1]).toLowerCase()) : String(norm(args[0])).toLowerCase().indexOf(String(norm(args[1])).toLowerCase()) >= 0;
    if (fn === 'startswith') return String(norm(args[0])).toLowerCase().startsWith(String(norm(args[1])).toLowerCase());
    if (fn === 'endswith') return String(norm(args[0])).toLowerCase().endsWith(String(norm(args[1])).toLowerCase());
    if (fn === 'format') return String(args[0]).replace(/\{(\d+)\}/g, (_, n) => String(norm(args[1 + Number(n)])));
    if (fn === 'tojson') return JSON.stringify(args[0]);
    return UNKNOWN;
  }
  const v = or();
  if (p < toks.length) throw new Error('trailing tokens in: ' + src);
  return v;
}
/* substitute every ${{ }} in a string; null when one of them cannot be known */
function interpolate(str, ctx) {
  let unknown = null;
  const out = String(str).replace(/\$\{\{([\s\S]*?)\}\}/g, (all, e) => {
    let v;
    try { v = evalExpr(e, ctx); } catch (err) { v = UNKNOWN; }
    if (isU(v)) { unknown = unknown || e.trim(); return all; }
    return v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
  return unknown ? { ok: false, unknown } : { ok: true, value: out };
}

/* the context of a pull_request run against main, as far as it can be known
   here. Secrets, repository variables and step outputs are UNKNOWN. */
function prContext(opts) {
  const o = opts || {};
  const unknown = { __unknown: true };
  return {
    github: { event_name: 'pull_request', base_ref: o.base || 'main', head_ref: o.head || 'local', ref: 'refs/pull/0/merge', ref_name: o.head || 'local',
      workspace: o.root, repository: 'dsrackler17/EdgeDeskSports', event: { pull_request: { head: { repo: { full_name: 'dsrackler17/EdgeDeskSports' } } }, inputs: {} }, run_id: '0', sha: o.sha || '' },
    runner: { temp: o.temp, os: 'Linux' },
    inputs: {}, env: {}, secrets: unknown, vars: unknown, steps: unknown, needs: unknown, matrix: unknown, job: unknown,
  };
}

/* --------------------------------------------------------------- workflows */
function triggers(doc) {
  const on = doc && (doc.on !== undefined ? doc.on : doc.true);
  if (typeof on === 'string') return { [on]: {} };
  if (Array.isArray(on)) return on.reduce((a, k) => (a[k] = {}, a), {});
  return on || {};
}
function loadWorkflows(root) {
  const dir = path.join(root, '.github', 'workflows');
  return fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort().map((f) => {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    const doc = parseYaml(text);
    return { file: '.github/workflows/' + f, base: f, name: doc && doc.name ? String(doc.name) : f, doc, on: triggers(doc) };
  });
}
/* does a pull request into `base` that changes `files` start this workflow? */
function triggeredBy(wf, files, base) {
  if (!Object.prototype.hasOwnProperty.call(wf.on, 'pull_request')) return { run: false, why: 'no pull_request trigger' };
  const pr = wf.on.pull_request || {};
  const br = base || 'main';
  if (pr.branches && !pathMatches([].concat(pr.branches), br)) return { run: false, why: 'its branches filter excludes ' + br };
  if (pr['branches-ignore'] && pathMatches([].concat(pr['branches-ignore']), br)) return { run: false, why: 'its branches-ignore filter names ' + br };
  if (pr.paths) {
    const hit = (files || []).filter((f) => pathMatches([].concat(pr.paths), f));
    return hit.length ? { run: true, why: 'paths: ' + hit.slice(0, 3).join(', ') + (hit.length > 3 ? ' …' : '') } : { run: false, why: 'no changed file is on its paths filter' };
  }
  if (pr['paths-ignore']) {
    const kept = (files || []).filter((f) => !pathMatches([].concat(pr['paths-ignore']), f));
    return kept.length ? { run: true, why: 'paths-ignore leaves ' + kept[0] } : { run: false, why: 'every changed file is on its paths-ignore filter' };
  }
  return { run: true, why: 'runs on every pull request' };
}

const SETUP_LINE = /^\s*(sudo\s+)?(apt-get|apt)\s|^\s*npm\s+(ci|install|i)\b|^\s*npx\s+(--yes\s+)?playwright(@[\w.]+)?\s+install\b|^\s*pip3?\s+install\b|^\s*python3?\s+-m\s+pip\s+install\b|^\s*git\s+(config|fetch)\b/;
/* every step of every job, as a local run would see it */
function plan(wf, ctxOpts) {
  const ctx = prContext(ctxOpts);
  const jobs = [];
  const wfEnv = wf.doc.env || {};
  for (const [jobId, job] of Object.entries(wf.doc.jobs || {})) {
    const J = { id: jobId, name: job.name ? String(job.name) : jobId, steps: [], skipped: null };
    jobs.push(J);
    if (job.if != null) {
      let v; try { v = evalExpr(String(job.if), ctx); } catch (e) { v = UNKNOWN; }
      if (isU(v)) { J.skipped = { kind: 'unknown', why: 'its if: (' + String(job.if) + ') depends on what this machine cannot know' }; continue; }
      if (!v) { J.skipped = { kind: 'condition', why: 'its if: is false on a pull request' }; continue; }
    }
    if (job.strategy && job.strategy.matrix) { J.skipped = { kind: 'unknown', why: 'a matrix job (run it in CI or by hand)' }; continue; }
    const services = job.services ? Object.keys(job.services) : [];
    const jobEnv = Object.assign({}, wfEnv, job.env || {});
    const defaults = (job.defaults && job.defaults.run) || (wf.doc.defaults && wf.doc.defaults.run) || {};
    (job.steps || []).forEach((st, k) => {
      const S = { n: k + 1, name: st.name ? String(st.name) : (st.uses ? 'uses ' + st.uses : String(st.run || '').split('\n')[0].slice(0, 80)), run: null, cwd: null, env: {}, status: null, why: null, shell: st.shell || defaults.shell || null };
      J.steps.push(S);
      if (st.uses) { S.status = 'setup'; S.why = 'uses ' + st.uses; return; }
      if (st.if != null) {
        let v; try { v = evalExpr(String(st.if), ctx); } catch (e) { v = UNKNOWN; }
        if (isU(v)) { S.status = 'unavailable'; S.why = 'its if: (' + String(st.if) + ') depends on a secret, variable or step output'; return; }
        if (!v) { S.status = 'condition'; S.why = 'its if: is false on a pull request'; return; }
      }
      const env = Object.assign({}, jobEnv, st.env || {});
      for (const [k, v] of Object.entries(env)) {
        const r = interpolate(v == null ? '' : v, ctx);
        if (!r.ok) {
          if (/^(secrets|vars)\./.test(r.unknown) || /secrets\.|vars\./.test(r.unknown)) { S.status = 'unavailable'; S.why = 'needs ' + r.unknown.replace(/^.*?((?:secrets|vars)\.\w+).*$/, '$1'); return; }
          S.status = 'unavailable'; S.why = 'its env ' + k + ' depends on ${{ ' + r.unknown + ' }}'; return;
        }
        S.env[k] = r.value;
      }
      const body = interpolate(st.run, ctx);
      if (!body.ok) { S.status = 'unavailable'; S.why = 'its script depends on ${{ ' + body.unknown + ' }}'; return; }
      S.run = body.value;
      S.cwd = st['working-directory'] || defaults['working-directory'] || null;
      const lines = S.run.split('\n').map((x) => x.trim()).filter((x) => x && !x.startsWith('#'));
      if (lines.length && lines.every((x) => SETUP_LINE.test(x))) { S.status = 'setup'; S.why = 'installs or fetches (the machine provides it, or the step after says it is missing)'; return; }
      if (services.length) S.services = services;
      S.status = 'run';
    });
  }
  return jobs;
}

module.exports = { parseYaml, globToRegExp, pathMatches, pathsMatch, evalExpr, interpolate, UNKNOWN, prContext, triggers, loadWorkflows, triggeredBy, plan, SETUP_LINE };
