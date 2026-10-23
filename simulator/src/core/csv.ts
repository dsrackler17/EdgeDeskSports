/* A small RFC 4180 CSV reader: quoted fields, doubled quotes, CRLF. Empty
   fields and 'NA' become null; nothing is guessed. */
export function parseCsv(text: string): Array<Record<string, string | null>> {
  const rows = parseCsvRows(text);
  if (!rows.length) return [];
  const head = rows[0];
  return rows.slice(1).map((r) => {
    const o: Record<string, string | null> = {};
    head.forEach((h, j) => { const v = r[j]; o[h] = v === undefined || v === '' || v === 'NA' ? null : v; });
    return o;
  });
}

/** the same reader without a header row (Retrosheet game logs): raw string fields per line */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let field = '', row: string[] = [], q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export function num(v: string | null | undefined): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
