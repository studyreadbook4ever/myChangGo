#!/usr/bin/env python3
"""Build and query a sorted fixed-width table directly in a leased mapping.

PYTHONPATH=python python3 examples/static_table.py --socket /path/to/broker.sock

Each row is two unsigned 64-bit little-endian integers: key and value. This
example creates no per-row Python objects that survive loading. Binary lookup
reads the mapping directly and never involves the broker. Rows are ephemeral;
release destroys the contents, and a new lease starts zeroed.
"""

import argparse
import json
import struct
import time

from hugekeeper import Lease

ROW = struct.Struct("<QQ")


def lookup(mapping, rows: int, wanted: int) -> int | None:
    left, right = 0, rows
    while left < right:
        middle = (left + right) // 2
        key, value = ROW.unpack_from(mapping, middle * ROW.size)
        if key == wanted:
            return value
        if key < wanted:
            left = middle + 1
        else:
            right = middle
    return None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--socket", required=True)
    parser.add_argument("--rows", type=int, default=100_000)
    args = parser.parse_args()
    if args.rows <= 0:
        parser.error("--rows must be positive")
    with Lease(args.socket) as lease:
        if args.rows > lease.size // ROW.size:
            parser.error(f"{args.rows} rows need {args.rows * ROW.size} bytes; slot has {lease.size}")
        start = time.perf_counter()
        for row in range(args.rows):
            ROW.pack_into(lease.mapping, row * ROW.size, row * 2, row * 10)
        loaded = time.perf_counter()
        wanted = (args.rows // 2) * 2
        result = lookup(lease.mapping, args.rows, wanted)
        finished = time.perf_counter()
        assert result == (args.rows // 2) * 10
        assert lookup(lease.mapping, args.rows, 1) is None
        print(json.dumps({
            "backend": lease.backend,
            "rows": args.rows,
            "table_bytes": args.rows * ROW.size,
            "slot_bytes": lease.size,
            "load_seconds": loaded - start,
            "lookup_seconds": finished - loaded,
            "key": wanted,
            "value": result,
        }, indent=2))


if __name__ == "__main__":
    main()
