#!/usr/bin/env python3
"""Describe Parquet files as JSON: rows, columns, field names and types, null
counts, and the min/max of a few span columns.

  python3 -I parquet_meta.py <file.parquet> [<file.parquet> ...]

EdgeDesk's own helper (the data packs ship their own scripts; those are never
run). It reads metadata and only the span columns, never executes anything
from the file, and prints one JSON object per input, keyed by path.

Exit codes: 0 ok · 2 usage · 3 pyarrow missing · 4 unreadable file.
"""
import json
import sys

SPAN = ['season', 'week', 'game_date', 'dt', 'season_type', 'game_type']


def describe(path, pq, pc):
    pf = pq.ParquetFile(path)
    md = pf.metadata
    schema = pf.schema_arrow
    nulls = {}
    for rg in range(md.num_row_groups):
        g = md.row_group(rg)
        for c in range(g.num_columns):
            col = g.column(c)
            name = col.path_in_schema.split('.')[0]
            st = col.statistics
            n = st.null_count if st is not None and st.has_null_count else None
            if name not in nulls:
                nulls[name] = 0
            nulls[name] = None if n is None or nulls[name] is None else nulls[name] + n
    spans = {}
    present = [c for c in SPAN if c in schema.names]
    if present:
        t = pf.read(columns=present)
        for c in present:
            a = t.column(c).drop_null()
            if len(a) == 0:
                continue
            try:
                mm = pc.min_max(a)
                spans[c] = [str(mm['min'].as_py()), str(mm['max'].as_py())]
            except Exception:  # noqa: BLE001 - a column type min_max cannot order
                spans[c] = None
    return {
        'rows': md.num_rows,
        'columns': len(schema.names),
        'fields': [[f.name, str(f.type)] for f in schema],
        'nulls': nulls,
        'spans': spans,
    }


def main():
    if len(sys.argv) < 2:
        print('usage: parquet_meta.py <file.parquet> ...', file=sys.stderr)
        return 2
    try:
        import pyarrow.compute as pc
        import pyarrow.parquet as pq
    except ImportError:
        print('pyarrow is not installed (pip install pyarrow)', file=sys.stderr)
        return 3
    out = {}
    for path in sys.argv[1:]:
        try:
            out[path] = describe(path, pq, pc)
        except Exception as exc:  # noqa: BLE001 - reported to the caller
            print('could not read %s: %s' % (path, exc), file=sys.stderr)
            return 4
    json.dump(out, sys.stdout)
    return 0


if __name__ == '__main__':
    sys.exit(main())
