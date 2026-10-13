#!/usr/bin/env python3
"""Write selected columns of one Parquet file as CSV.

Why a second helper beside football/data/tools/parquet_to_csv.py: the NHL
play-by-play season files are ~450k rows x 100+ columns, and their column set
changes across seasons (2009-10 has no strength_state; only recent seasons
carry situationCode). This helper reads ONLY the requested columns, writes an
empty value for a requested column the file does not have (the Node side then
records it as missing, never as observed), and streams through pyarrow's C++
CSV writer instead of a Python row loop.

  python3 parquet_select.py <file.parquet> <out.csv|-> col1,col2,...

Exit codes: 0 ok · 2 usage · 3 pyarrow missing · 4 unreadable file.
"""
import sys, signal

# a consumer that stops reading early (head, a closed Node stream) is not an error
try:
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)
except (AttributeError, ValueError):
    pass


def main():
    if len(sys.argv) < 4:
        print('usage: parquet_select.py <file.parquet> <out.csv|-> col1,col2,...', file=sys.stderr)
        return 2
    src, dst, cols = sys.argv[1], sys.argv[2], [c for c in sys.argv[3].split(',') if c]
    try:
        import pyarrow as pa
        import pyarrow.parquet as pq
        import pyarrow.csv as pcsv
    except ImportError:
        print('pyarrow is not installed (pip install pyarrow)', file=sys.stderr)
        return 3
    try:
        pf = pq.ParquetFile(src)
    except Exception as exc:  # noqa: BLE001 - the caller decides what a failure means
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
    # strings, ints and floats only: cast anything exotic to string so the CSV is plain
    fields = []
    for f in table.schema:
        if pa.types.is_dictionary(f.type) or pa.types.is_list(f.type) or pa.types.is_struct(f.type):
            fields.append(pa.field(f.name, pa.string()))
        else:
            fields.append(f)
    try:
        table = table.cast(pa.schema(fields))
    except Exception:  # noqa: BLE001
        pass
    out = sys.stdout.buffer if dst == '-' else dst
    pcsv.write_csv(table, out, write_options=pcsv.WriteOptions(include_header=True))
    return 0


if __name__ == '__main__':
    sys.exit(main())
