#ifndef HUGEKEEPER_CAPACITY_H
#define HUGEKEEPER_CAPACITY_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* Read-only estimate of currently allocatable 2 MiB pages. For ordinary/THP
 * memory, retain max(128 MiB, 10%) of the tighter host/cgroup headroom.
 * HugeTLB uses already reserved 2 MiB pages; it never changes the kernel pool.
 * explicit_max_pages == 0 means no additional caller-supplied cap.
 * A zero result can mean exhausted resources or unreadable required limits;
 * reason, when provided, distinguishes them. The estimate is a snapshot,
 * not an allocation guarantee: races, permissions and hidden ancestor limits
 * may still make a subsequent allocation fail. */
uint64_t hk_available_pages(bool hugetlb, bool lock_pages,
                            uint64_t explicit_max_pages, char *reason, size_t reason_size);

#endif
