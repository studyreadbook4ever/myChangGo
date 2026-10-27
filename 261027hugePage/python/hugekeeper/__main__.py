"""Command-line control and a tiny shared-memory demonstration."""

import argparse
import json
import math
import sys
import time

from . import BrokerError, Lease, admin_request


def nonnegative_int(value: str) -> int:
    number = int(value)
    if number < 0:
        raise argparse.ArgumentTypeError("must be nonnegative")
    return number


def nonnegative_seconds(value: str) -> float:
    number = float(value)
    if not math.isfinite(number) or number < 0:
        raise argparse.ArgumentTypeError("must be finite and nonnegative")
    return number


def main() -> int:
    parser = argparse.ArgumentParser(description="Control the Hugekeeper memory broker")
    parser.add_argument("--socket", required=True, help="data socket path; admin uses PATH.admin")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("status", help="show pool and authorization status as JSON")
    for name in ("allow", "deny"):
        subparser = commands.add_parser(name)
        subparser.add_argument("uid", type=nonnegative_int)
    revoke = commands.add_parser("revoke")
    revoke.add_argument("lease", type=nonnegative_int)
    resize = commands.add_parser("resize")
    resize.add_argument("slots", type=nonnegative_int)
    commands.add_parser("refill", help="retry allocation of degraded slots")
    commands.add_parser("free", help="return entire pool; immediately invalidates ALL active mappings (SIGBUS)")
    demo = commands.add_parser("demo", help="acquire, write/read a message, then release")
    demo.add_argument("--hold", type=nonnegative_seconds, default=0.0, metavar="SECONDS")
    args = parser.parse_args()
    try:
        if args.command == "demo":
            with Lease(args.socket) as lease:
                message = b"hello from hugekeeper"
                lease.mapping[: len(message)] = message
                print(json.dumps({
                    "lease": lease.lease_id,
                    "size": lease.size,
                    "backend": lease.backend,
                    "read_back": lease.mapping[: len(message)].decode("ascii"),
                    "hold_seconds": args.hold,
                }, indent=2), flush=True)
                if args.hold:
                    time.sleep(args.hold)
            return 0
        command = args.command.upper()
        if args.command in ("allow", "deny"):
            command += f" {args.uid}"
        elif args.command == "revoke":
            command += f" {args.lease}"
        elif args.command == "resize":
            command += f" {args.slots}"
        print(json.dumps(admin_request(args.socket, command), indent=2))
        return 0
    except (BrokerError, OSError, ValueError) as exc:
        print(f"hugekeeper: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
