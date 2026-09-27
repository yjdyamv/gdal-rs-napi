# The musl build environment, used by the two musl CI legs.
#
# Alpine is musl-native, and that is the whole point: on a runner of the matching
# architecture, the container's own C/C++ toolchain already targets
# <arch>-unknown-linux-musl, so `cargo build --target …-linux-musl` inside it is an
# ordinary native build. No cross toolchain, no sysroot, no `--use-cross`, no
# `--cross-compile`, and nothing for rustup to resolve against a host it is not
# running on.
#
# `node:24-alpine` is the base so that one image can both build and run the suite.
FROM node:24-alpine

# build-base    gcc/g++/make/musl-dev/binutils — the C and C++ toolchain that GDAL,
#               PROJ, HDF5, netCDF, libcurl and libpq all need
# cmake ninja   the build systems those libraries use; `.cargo/config.toml` pins
#               Ninja for MSVC, so ninja has to exist here as well
# perl          OpenSSL's Configure is a Perl script, and the musl build compiles
#               OpenSSL from source (curl-sys's `static-ssl`, see Cargo.toml)
# linux-headers headers for the many configure probes
# pkgconf       what those probes use to look for libraries
# sqlite        PROJ shells out to the `sqlite3` CLI to generate proj.db
# git curl ca-certificates
#               crates that fetch sources, and the rustup installer itself
RUN apk add --no-cache \
        build-base \
        cmake \
        ninja \
        perl \
        linux-headers \
        pkgconf \
        sqlite \
        git \
        curl \
        ca-certificates

# rustup rather than Alpine's `rust` package, which lags the MSRV in Cargo.toml.
# The toolchain it installs has this container's own triple as its host, so the
# musl target napi is asked for is the native one — nothing has to be added.
#
# A fixed CARGO_HOME matters for the mounted `target/`: it is only reusable from
# one run to the next while the paths cargo recorded inside it stay the same.
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --profile minimal --default-toolchain stable --no-modify-path

# napi pins a linker name for one target in its own table —
# `aarch64-unknown-linux-musl` gets `aarch64-linux-musl-gcc`, which is the name a
# *cross* gcc would have. Nothing here is cross, so hand that name to the
# container's own compiler rather than making the CI pass a variable to undo it.
# `apk --print-arch` gives the same prefix napi's table uses (`x86_64`,
# `aarch64`), so this stays honest whichever musl leg is being built.
RUN set -eux; \
    arch="$(apk --print-arch)"; \
    ln -sf "$(command -v gcc)" "/usr/local/bin/${arch}-linux-musl-gcc"; \
    ln -sf "$(command -v g++)" "/usr/local/bin/${arch}-linux-musl-g++"
