#!/usr/bin/env bash
# Run real HugeTLB tests in an isolated 384 MiB guest; never tune the host.
set -euo pipefail
project_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$project_dir"
vm_dir="$project_dir/build/vm-local"
kernel_path=${HUGEKEEPER_VM_KERNEL:-/boot/vmlinuz-linux}
qemu_path=${HUGEKEEPER_VM_QEMU:-}
if [[ -z "$qemu_path" ]]; then
    if command -v qemu-system-x86_64 >/dev/null 2>&1; then
        qemu_path=$(command -v qemu-system-x86_64)
    else
        qemu_path="$vm_dir/root/usr/bin/qemu-system-x86_64"
    fi
fi
if [[ ! -x "$qemu_path" ]]; then
    echo 'QEMU is missing. Install qemu-system-x86_64, or run scripts/vm-bootstrap-qemu.py on Arch Linux.' >&2
    exit 2
fi
[[ -r "$kernel_path" ]] || { echo "Kernel is unreadable: $kernel_path" >&2; exit 2; }
[[ -r /dev/kvm && -w /dev/kvm ]] || { echo 'This test requires access to /dev/kvm.' >&2; exit 2; }
[[ -x build/hugekeeperd ]] || { echo 'Build build/hugekeeperd first with make.' >&2; exit 2; }
mkdir -p "$vm_dir" results
"${CC:-cc}" -std=c11 -O2 -Wall -Wextra -Werror -static tests/vm_init.c -o "$vm_dir/vm-init"

# Construct root-owned newc directly; no mknod, mount, sudo, or host package install.
python3 - "$vm_dir" "$project_dir/build/hugekeeperd" <<'PY'
import gzip, hashlib, pathlib, re, stat, subprocess, sys
out = pathlib.Path(sys.argv[1]); daemon = pathlib.Path(sys.argv[2])
entries = {'init': (stat.S_IFREG | 0o755, (out / 'vm-init').read_bytes()),
           'hugekeeperd': (stat.S_IFREG | 0o755, daemon.read_bytes())}
(out / 'daemon.sha256').write_text(hashlib.sha256(entries['hugekeeperd'][1]).hexdigest() + '  guest:/hugekeeperd\n')
for directory in ['dev', 'proc', 'sys', 'run', 'run/hugekeeper', 'lib', 'lib64', 'usr', 'usr/lib']:
    entries[directory] = (stat.S_IFDIR | 0o755, b'')
linked = subprocess.run(['ldd', str(daemon)], text=True, capture_output=True)
if linked.returncode and 'not a dynamic executable' not in linked.stdout + linked.stderr:
    raise SystemExit(linked.stdout + linked.stderr)
if 'not found' in linked.stdout:
    raise SystemExit('Daemon has unresolved shared libraries:\n' + linked.stdout)
for source in set(re.findall(r'(/[^\s()]+)', linked.stdout)):
    path = pathlib.Path(source)
    if not path.is_file(): continue
    relative = source.lstrip('/')
    for directory in path.parents:
        if str(directory) != '/': entries[str(directory).lstrip('/')] = (stat.S_IFDIR | 0o755, b'')
    entries[relative] = (stat.S_IFREG | 0o755, path.read_bytes())
with gzip.open(out / 'initramfs.cpio.gz', 'wb', compresslevel=1) as archive:
    def write_entry(ino, name, mode, data):
        name_bytes = name.encode() + b'\0'
        fields = [ino, mode, 0, 0, 2 if stat.S_ISDIR(mode) else 1, 0, len(data), 0, 0, 0, 0, len(name_bytes), 0]
        header = b'070701' + ''.join(f'{value:08x}' for value in fields).encode()
        archive.write(header + name_bytes)
        archive.write(b'\0' * (-(len(header) + len(name_bytes)) % 4))
        archive.write(data); archive.write(b'\0' * (-len(data) % 4))
    for ino, (name, (mode, data)) in enumerate(sorted(entries.items()), 1):
        write_entry(ino, name, mode, data)
    write_entry(len(entries) + 1, 'TRAILER!!!', 0, b'')
PY

qemu_extra=()
if [[ "$qemu_path" == "$vm_dir/root/"* ]]; then
    export LD_LIBRARY_PATH="$vm_dir/root/usr/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
    export QEMU_MODULE_DIR="$vm_dir/root/usr/lib/qemu"
    qemu_extra=(-L "$vm_dir/root/usr/share/qemu" -bios "$vm_dir/root/usr/share/qemu/bios-256k.bin")
fi
log_path=${HUGEKEEPER_VM_LOG:-results/hugetlb-vm-latest.txt}
{
    date --iso-8601=seconds
    "$qemu_path" --version
    printf 'Host kernel: '; uname -r
    printf 'Guest kernel: %s\n' "$kernel_path"
    printf 'Daemon SHA256: '; cat "$vm_dir/daemon.sha256"
    printf 'Host HugeTLB before: '; awk '/^HugePages_Total:/ {print $2}' /proc/meminfo
    printf 'VM: KVM, 384 MiB, 2 vCPU, no disks, no network, no shared directories\n'
    timeout --signal=TERM --kill-after=5s 90s "$qemu_path" \
        -machine q35,accel=kvm -cpu host -smp 2 -m 384 \
        -nodefaults -display none -serial stdio -monitor none -no-reboot \
        -nic none "${qemu_extra[@]}" \
        -kernel "$kernel_path" -initrd "$vm_dir/initramfs.cpio.gz" \
        -append 'console=ttyS0 rdinit=/init loglevel=4 panic=-1'
    printf 'Host HugeTLB after: '; awk '/^HugePages_Total:/ {print $2}' /proc/meminfo
} 2>&1 | tee "$log_path"
if ! grep -Eq '^HUGETLB_VM_RESULT PASS checks=[1-9][0-9]* failures=0' "$log_path"; then
    echo "HugeTLB guest tests failed; see $log_path" >&2
    exit 1
fi
printf 'Real HugeTLB guest checks passed. Log: %s\n' "$log_path"
