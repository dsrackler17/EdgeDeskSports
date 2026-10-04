#!/usr/bin/env node
// Split a .sql file into parts at TOP-LEVEL statement boundaries only.
// Understands: -- line comments, /* */ block comments (Postgres nests them),
// 'single quotes' with '' escape, "quoted identifiers", and $tag$ dollar quotes.
// A function body is never cut, because its semicolons live inside a dollar quote.
const fs = require('fs');

function statements(src) {
  const out = [];
  let i = 0, start = 0, depth = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '-' && src[i + 1] === '-') {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? src.length : nl + 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      depth = 1; i += 2;
      while (i < src.length && depth > 0) {
        if (src[i] === '/' && src[i + 1] === '*') { depth++; i += 2; }
        else if (src[i] === '*' && src[i + 1] === '/') { depth--; i += 2; }
        else i++;
      }
      continue;
    }
    if (c === "'") {
      i++;
      while (i < src.length) {
        if (src[i] === "'" && src[i + 1] === "'") { i += 2; continue; }
        if (src[i] === "'") { i++; break; }
        i++;
      }
      continue;
    }
    if (c === '"') {
      i++;
      while (i < src.length) {
        if (src[i] === '"' && src[i + 1] === '"') { i += 2; continue; }
        if (src[i] === '"') { i++; break; }
        i++;
      }
      continue;
    }
    if (c === '$') {
      const m = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(src.slice(i, i + 80));
      if (m) {
        const tag = m[0];
        const end = src.indexOf(tag, i + tag.length);
        if (end === -1) throw new Error('unterminated dollar quote ' + tag + ' at offset ' + i);
        i = end + tag.length;
        continue;
      }
    }
    if (c === ';') {
      out.push(src.slice(start, i + 1));
      start = i + 1;
      i++;
      continue;
    }
    i++;
  }
  const tail = src.slice(start);
  if (tail.trim()) out.push(tail);
  else if (tail) out[out.length - 1] += tail;
  return out;
}

module.exports = { statements };

if (require.main === module) {
  const [, , file, outDir, limitArg] = process.argv;
  const LIMIT = Number(limitArg || 20000);
  const src = fs.readFileSync(file, 'utf8');
  const stmts = statements(src);

  if (stmts.join('') !== src) {
    console.error('ROUND-TRIP MISMATCH - refusing to split');
    process.exit(1);
  }

  const base = file.replace(/^.*\//, '').replace(/\.sql$/, '');
  const parts = [];
  let cur = '';
  for (const s of stmts) {
    if (cur && Buffer.byteLength(cur + s) > LIMIT) { parts.push(cur); cur = ''; }
    cur += s;
  }
  if (cur.trim()) parts.push(cur);

  fs.mkdirSync(outDir, { recursive: true });
  const pad = String(parts.length).length;
  parts.forEach((p, n) => {
    const idx = String(n + 1).padStart(pad, '0');
    const name = base + '.part' + idx + '-of-' + parts.length + '.sql';
    const header = '-- ' + base + ' -- part ' + (n + 1) + ' of ' + parts.length + '.\n'
      + '-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole\n'
      + '-- number of statements; nothing is cut in the middle. Re-running a part is safe.\n'
      + (n + 1 === parts.length ? '-- This last part prints the report: every row should read ok.\n' : '')
      + '\n';
    fs.writeFileSync(outDir + '/' + name, header + p.replace(/^\n+/, '') + '\n');
    console.log(name + '  ' + Buffer.byteLength(header + p) + ' bytes');
  });
  console.log('  (' + stmts.length + ' statements, round-trip identical to source)');

}
