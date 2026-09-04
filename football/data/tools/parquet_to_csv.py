#!/usr/bin/env python3
"""Convert one Parquet file to CSV on stdout.

WHY THIS EXISTS AT ALL. The ESPN player box is published as `.csv.gz` for
completed seasons and as `.parquet` for the season in progress. The current
season is the one the ratings most need, so the ingest has to be able to read
parquet — and a correct Parquet reader is thrift metadata, several encodings
and two compression codecs, which is not something to hand-roll into a weekly
build. pyarrow is one `pip install` and is already the format's reference
implementation.

The Node ingest calls this ONLY when a season's CSV is unavailable, and treats
a failure here as "that season is absent" rather than as a broken build.

  python3 parquet_to_csv.py <file.parquet>   > out.csv
"""
import sys, csv, signal

# a consumer that stops reading early (head, a Node stream that closed) is not
# an error worth a stack trace
try:
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)
except (AttributeError, ValueError):
    pass


def main():
    if len(sys.argv) < 2:
        print('usage: parquet_to_csv.py <file.parquet>', file=sys.stderr)
        return 2
    try:
        import pyarrow.parquet as pq
    except ImportError:
        print('pyarrow is not installed; install it or supply the CSV form of this season', file=sys.stderr)
        return 3
    try:
        table = pq.read_table(sys.argv[1])
    except Exception as exc:                       # noqa: BLE001 - the caller decides what a failure means
        print('could not read %s: %s' % (sys.argv[1], exc), file=sys.stderr)
        return 4
    cols = table.column_names
    out = csv.writer(sys.stdout, lineterminator='\n')
    out.writerow(cols)
    data = table.to_pydict()
    n = table.num_rows
    series = [data[c] for c in cols]
    for i in range(n):
        row = []
        for s in series:
            v = s[i]
            row.append('' if v is None else v)
        out.writerow(row)
    return 0


if __name__ == '__main__':
    sys.exit(main())
