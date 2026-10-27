#!/usr/bin/env python3
"""Read-only host capability report. Never changes kernel settings."""
import json
import os
import platform
import resource
from pathlib import Path


def read(path):
    try:
        return Path(path).read_text().strip()
    except OSError as exc:
        return str(exc)


memory = {}
for line in read('/proc/meminfo').splitlines():
    key, _, value = line.partition(':')
    if key.startswith(('Huge', 'MemAvailable', 'ShmemHuge', 'ShmemPmd', 'AnonHuge')):
        memory[key] = value.strip()
print(json.dumps({
    'kernel': platform.release(),
    'architecture': platform.machine(),
    'uid': os.getuid(),
    'memory': memory,
    'thp_enabled': read('/sys/kernel/mm/transparent_hugepage/enabled'),
    'shmem_thp': read('/sys/kernel/mm/transparent_hugepage/shmem_enabled'),
    'hugetlb_shm_group': read('/proc/sys/vm/hugetlb_shm_group'),
    'memlock_limits_bytes': resource.getrlimit(resource.RLIMIT_MEMLOCK),
    'kvm_access': os.access('/dev/kvm', os.R_OK | os.W_OK),
}, indent=2))
