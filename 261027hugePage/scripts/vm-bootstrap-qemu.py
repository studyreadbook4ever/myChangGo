#!/usr/bin/env python3
"""Extract signature-verified Arch QEMU packages locally; never install on host.

Optional helper for the Arch x86_64 development machine used for this project.
Other distributions should supply their own qemu-system-x86_64 to vm-test.sh.
Requires a recent Arch base system, curl, bsdtar, gpg, gpgv, and the installed
Arch public keyring. Downloads are pinned to the versions tested here.
"""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import os
import subprocess
import sys


PACKAGES = [
    "qemu-system-x86-11.1.1-2-x86_64.pkg.tar.zst",
    "qemu-common-11.1.1-2-x86_64.pkg.tar.zst",
    "qemu-system-x86-firmware-11.1.1-2-x86_64.pkg.tar.zst",
    "seabios-1.17.0-2-any.pkg.tar.zst",
    "capstone-5.0.9-1-x86_64.pkg.tar.zst",
    "numactl-2.0.19-1-x86_64.pkg.tar.zst",
    "rdma-core-65.0-1-x86_64.pkg.tar.zst",
    "libslirp-4.9.4-1-x86_64.pkg.tar.zst",
    "wolfssl-5.9.2-1-x86_64.pkg.tar.zst",
    "vde2-2.3.3-9-x86_64.pkg.tar.zst",
    "libxdp-1.6.3-2-x86_64.pkg.tar.zst",
    "libcbor-0.14.0-1-x86_64.pkg.tar.zst",
    "iniparser-4.2.6-2-x86_64.pkg.tar.zst",
    "libtraceevent-1:1.9.0-1-x86_64.pkg.tar.zst",
    "libtracefs-1.8.3-1-x86_64.pkg.tar.zst",
    "ndctl-85-1-x86_64.pkg.tar.zst",
    "dtc-1:1.8.1-1-x86_64.pkg.tar.zst",
    "libaio-0.3.113-5-x86_64.pkg.tar.zst",
    "liburing-2.15-1-x86_64.pkg.tar.zst",
]


def main():
    project = Path(__file__).resolve().parent.parent
    work = project / "build/vm-local"
    packages = work / "packages"
    local_root = work / "root"
    keyring_source = Path(os.environ.get("HUGEKEEPER_VM_KEYRING", "/usr/share/pacman/keyrings/archlinux.gpg"))
    if not keyring_source.is_file():
        raise SystemExit("Arch keyring is missing; use an installed QEMU or set HUGEKEEPER_VM_KEYRING.")
    packages.mkdir(parents=True, exist_ok=True)
    local_root.mkdir(parents=True, exist_ok=True)
    keyring = work / "archlinux-keyring.gpg"
    # Arch ships concatenated ASCII armored keys; gpgv needs a binary keyring.
    if keyring_source.read_bytes().startswith(b"-----BEGIN"):
        subprocess.run(["gpg", "--batch", "--yes", "--dearmor", "--output", str(keyring), str(keyring_source)], check=True)
    else:
        keyring.write_bytes(keyring_source.read_bytes())

    def download_and_verify(filename):
        name = filename.rsplit("-", 3)[0]
        base_url = f"https://archive.archlinux.org/packages/{name[0]}/{name}/{filename}"
        path = packages / filename
        signature = packages / (filename + ".sig")
        for destination, url in [(path, base_url), (signature, base_url + ".sig")]:
            if not destination.exists():
                partial = destination.with_name(destination.name + ".partial")
                subprocess.run(["curl", "-fsSL", "--retry", "2", "--max-time", "120",
                                "-o", str(partial), url], check=True)
                partial.replace(destination)
        verified = subprocess.run(["gpgv", "--keyring", str(keyring), str(signature), str(path)],
                                  text=True, capture_output=True)
        if verified.returncode:
            raise RuntimeError(f"Signature verification failed for {filename}:\n{verified.stderr}")
        print(f"VERIFIED {filename}", flush=True)
        return path

    with ThreadPoolExecutor(max_workers=6) as workers:
        verified_paths = list(workers.map(download_and_verify, PACKAGES))
    # Extract only after every package has passed signature verification.
    for package in verified_paths:
        subprocess.run(["bsdtar", "-xf", str(package), "-C", str(local_root),
                        "--exclude=.PKGINFO", "--exclude=.BUILDINFO", "--exclude=.MTREE"], check=True)
    environment = os.environ.copy()
    environment["LD_LIBRARY_PATH"] = str(local_root / "usr/lib")
    subprocess.run([str(local_root / "usr/bin/qemu-system-x86_64"), "--version"],
                   env=environment, check=True)
    print(f"Local QEMU ready in {local_root}; run scripts/vm-test.sh.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, subprocess.CalledProcessError) as error:
        print(error, file=sys.stderr)
        sys.exit(1)
