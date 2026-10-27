#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
make
run_dir=$(mktemp -d)
broker_pid=
cleanup() {
    if [ -n "$broker_pid" ]; then
        kill "$broker_pid" 2>/dev/null || true
        wait "$broker_pid" 2>/dev/null || true
    fi
    rm -rf "$run_dir"
}
trap cleanup EXIT HUP INT TERM
export PYTHONPATH="$PWD/python${PYTHONPATH:+:$PYTHONPATH}"
./build/hugekeeperd --socket "$run_dir/pool.sock" --backend thp \
    --pages 8 --slots 2 --allow-uid "$(id -u)" >"$run_dir/daemon.log" 2>&1 &
broker_pid=$!
python3 - "$run_dir/pool.sock" <<'PY'
import sys, time
from hugekeeper import admin_request
for attempt in range(100):
    try:
        admin_request(sys.argv[1], "STATUS")
        break
    except OSError:
        time.sleep(.05)
else:
    raise SystemExit("daemon did not become ready")
PY
cat "$run_dir/daemon.log"
python3 -m hugekeeper --socket "$run_dir/pool.sock" status
python3 examples/static_table.py --socket "$run_dir/pool.sock" --rows 100000
python3 -m hugekeeper --socket "$run_dir/pool.sock" free
python3 -m hugekeeper --socket "$run_dir/pool.sock" status
