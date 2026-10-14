#!/usr/bin/env python3
"""Write selected columns of one Parquet file as CSV, one physical line per row.

The NBA engine's copy of hockey/tools/parquet_select.py, with one difference:
some hoopR columns are strings that contain newlines (the schedule's
linescores are stored as the text of a numpy array, one struct per line).
Every string column has CR/LF replaced by a space so that a line reader on the
Node side sees exactly one row per line. A requested column the file does not
have is written empty and reported on stderr ("missing columns: ...") so the
caller records it as missing, never as observed.

  python3 parquet_select.py <file.parquet> <out.csv|-> col1,col2,...
  python3 parquet_select.py --meta <file.parquet>     JSON: rows and each column's name and type

Exit codes: 0 ok · 2 usage · 3 pyarrow missing · 4 unreadable file.
"""
import sys, signal

try:
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)
except (AttributeError, ValueError):
    pass


def meta(src):
    import json
    import pyarrow.parquet as pq
    pf = pq.ParquetFile(src)
    print(json.dumps({'rows': pf.metadata.num_rows, 'columns': [{'name': f.name, 'type': str(f.type)} for f in pf.schema_arrow]}))
    return 0


def main():
    if len(sys.argv) == 3 and sys.argv[1] == '--meta':
        try:
            return meta(sys.argv[2])
        except ImportError:
            print('pyarrow is not installed (pip install pyarrow)', file=sys.stderr)
            return 3
        except Exception as exc:  # noqa: BLE001
            print('could not read %s: %s' % (sys.argv[2], exc), file=sys.stderr)
            return 4
    if len(sys.argv) < 4:
        print('usage: parquet_select.py <file.parquet> <out.csv|-> col1,col2,...', file=sys.stderr)
        return 2
    src, dst, cols = sys.argv[1], sys.argv[2], [c for c in sys.argv[3].split(',') if c]
    try:
        import pyarrow as pa
        import pyarrow.parquet as pq
        import pyarrow.csv as pcsv
        import pyarrow.compute as pc
    except ImportError:
        print('pyarrow is not installed (pip install pyarrow)', file=sys.stderr)
        return 3
    try:
        pf = pq.ParquetFile(src)
    except Exception as exc:  # noqa: BLE001
        print('could not read %s: %s' % (src, exc), file=sys.stderr)
        return 4
    have = set(pf.schema_arrow.names)
    present = [c for c in cols if c in have]
    missing = [c for c in cols if c not in have]
    if missing:
        print('missing columns: ' + ','.join(missing), file=sys.stderr)
    table = pf.read(columns=present)
    for c in missing:
        table = table.append_column(c, pa.nulls(table.num_rows, type=pa.string()))
    table = table.select(cols)
    arrays, fields = [], []
    for f, col in zip(table.schema, table.columns):
        t = f.type
        if pa.types.is_dictionary(t) or pa.types.is_list(t) or pa.types.is_large_list(t) or pa.types.is_struct(t):
            col = pa.chunked_array([pa.array([None if v is None else str(v) for v in ch.to_pylist()], type=pa.string()) for ch in col.chunks], type=pa.string())
            t = pa.string()
        if pa.types.is_large_string(t):
            col = col.cast(pa.string()); t = pa.string()
        if pa.types.is_string(t):
            col = pc.replace_substring_regex(col, pattern='[\\r\\n]+', replacement=' ')
        if pa.types.is_timestamp(t) or pa.types.is_date(t):
            col = col.cast(pa.string()); t = pa.string()
        arrays.append(col); fields.append(pa.field(f.name, t))
    table = pa.Table.from_arrays(arrays, schema=pa.schema(fields))
    out = sys.stdout.buffer if dst == '-' else dst
    pcsv.write_csv(table, out, write_options=pcsv.WriteOptions(include_header=True))
    return 0


if __name__ == '__main__':
    sys.exit(main())
