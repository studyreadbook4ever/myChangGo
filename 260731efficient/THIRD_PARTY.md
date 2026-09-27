# Third-party notices

idlepilot 0.1.0 declares no entries in `[dependencies]` or
`[dev-dependencies]` and does not vendor third-party source code, binary
libraries, fonts, media, or generated assets.

This document only records third-party boundaries and does not grant rights in
idlepilot-authored material. Rust, glibc, libgcc, the ELF loader, `loginctl`,
and other toolchain or operating-system components retain their own copyright
and license terms.

The program links through the Rust standard library and the target Linux C
runtime supplied by the selected Rust toolchain and operating system. Rust's
standard library is normally copied into the release ELF by static linking.
System libraries shown by `readelf -d` are dynamically linked and supplied by
the target operating system rather than copied into this source or release
archive. The exact names vary by build target and host.

Rust's standard library is normally linked into the idlepilot ELF binary. A
binary release therefore must copy the exact build toolchain's library notice
bundle into its documentation, including:

```text
$(rustc --print sysroot)/share/doc/rust/COPYRIGHT-library.html
$(rustc --print sysroot)/share/doc/rust/licenses/
```

`COPYRIGHT-library.html` identifies the Rust library and the third-party
components incorporated into that toolchain; this source-level summary is not
a replacement for it. A distributor must also inspect dynamically linked
system libraries for the target platform, determine the applicable platform
distribution obligations, and regenerate the SBOM from the exact binary.
Compiler-only components that are not present in the shipped artifact should
not be reported as runtime packages merely because they exist in the toolchain.

The bundled release builder records the Rust standard library as a static-link
relationship and every ELF `DT_NEEDED` entry as a dynamic-link relationship in
the SPDX SBOM. A native GNU/Linux archive inherits its build host's glibc ABI
requirements; it is not a promise of compatibility with older distributions.
The aarch64 GNU CI job is a compile-check only, and musl is not currently a
verified release target.

The optional runtime integrations are operating-system interfaces rather than
bundled dependencies:

- Linux `/proc` and `/sys`
- systemd-logind's `loginctl` command
- a systemd user manager when the packaged unit is used

Before every release, verify the resolved graph instead of relying only on
this document:

```sh
cargo metadata --locked --format-version 1
cargo tree --locked --edges all --target all
```

If any dependency or bundled asset is added, update this file, `NOTICE`, and
the SPDX release SBOM before shipping.
