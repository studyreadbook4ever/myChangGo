CC ?= cc
AR ?= ar
CFLAGS ?= -O2 -g
CFLAGS += -std=c11 -Wall -Wextra -Wpedantic -Werror -D_FORTIFY_SOURCE=3 -fstack-protector-strong
LDFLAGS ?=
PREFIX ?= /usr/local

.PHONY: all clean test sanitize install
all: build/hugekeeperd build/libhugekeeper.a build/table-demo

build/hugekeeperd: src/daemon.c src/capacity.c src/capacity.h
	mkdir -p build
	$(CC) $(CFLAGS) src/daemon.c src/capacity.c -o $@ $(LDFLAGS)

build/client.o: src/client.c include/hugekeeper.h
	mkdir -p build
	$(CC) $(CFLAGS) -Iinclude -c $< -o $@

build/libhugekeeper.a: build/client.o
	$(AR) rcs $@ $<

build/table-demo: examples/table.c build/libhugekeeper.a
	$(CC) $(CFLAGS) -Iinclude $< build/libhugekeeper.a -o $@ $(LDFLAGS)

test: all
	PYTHONPATH=python python3 -m unittest discover -s tests -v

sanitize:
	$(MAKE) clean
	$(MAKE) CFLAGS='-O1 -g -std=c11 -Wall -Wextra -Wpedantic -Werror -fsanitize=address,undefined -fno-omit-frame-pointer' LDFLAGS='-fsanitize=address,undefined' test

install: all
	install -Dm755 build/hugekeeperd $(DESTDIR)$(PREFIX)/bin/hugekeeperd
	install -Dm644 build/libhugekeeper.a $(DESTDIR)$(PREFIX)/lib/libhugekeeper.a
	install -Dm644 include/hugekeeper.h $(DESTDIR)$(PREFIX)/include/hugekeeper.h
	install -Dm644 README.md $(DESTDIR)$(PREFIX)/share/doc/hugekeeper/README.md

clean:
	rm -f build/hugekeeperd build/client.o build/libhugekeeper.a build/table-demo
