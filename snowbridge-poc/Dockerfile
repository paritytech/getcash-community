# Runs the whole POC e2e suite in one container; see the Docker section of README.md.
# Build: docker build -t getcash-sb-e2e snowbridge-poc      Run: docker run --rm --memory 12g -v "$PWD/out:/out" getcash-sb-e2e

ARG GETH_VERSION=v1.17.1
ARG SOLC_VERSION=0.8.30

# The polkadot-sdk pins are cut out of stack/pins.sh so that a change to another pin does not rebuild the two-hour sdk stage.
FROM debian:trixie-slim AS pins
COPY stack/pins.sh /pins.sh
RUN grep -E '^(POLKADOT_SDK_|FULU_PATCHED_SOURCE=)' /pins.sh > /sdk.pins

# ---- polkadot-sdk binaries: fast-runtime relay chain and parachain collator, throttled for a laptop's Docker VM

FROM rust:1.93.0-trixie AS sdk-bin
ARG CARGO_JOBS=2
ENV CARGO_BUILD_JOBS=${CARGO_JOBS}
RUN apt-get update \
 && apt-get install -y --no-install-recommends clang libclang-dev cmake protobuf-compiler libssl-dev pkg-config \
 && rm -rf /var/lib/apt/lists/*
RUN rustup target add wasm32v1-none && rustup component add rust-src
COPY --from=pins /sdk.pins /pins/sdk.pins
COPY stack/patches/polkadot-sdk-fulu.patch /pins/
RUN . /pins/sdk.pins \
 && git clone -q --depth 1 --branch "$POLKADOT_SDK_TAG" "$POLKADOT_SDK_URL" /sdk \
 && git -C /sdk apply /pins/polkadot-sdk-fulu.patch
WORKDIR /sdk
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,target=/sdk/target,sharing=locked \
    cargo build --release -j "$CARGO_JOBS" --bin polkadot --bin polkadot-execute-worker --bin polkadot-prepare-worker --features fast-runtime \
 && mkdir -p /out \
 && cp target/release/polkadot target/release/polkadot-execute-worker target/release/polkadot-prepare-worker /out/
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,target=/sdk/target,sharing=locked \
    cargo build --release -j "$CARGO_JOBS" -p polkadot-parachain-bin --bin polkadot-parachain --features fast-runtime \
 && cp target/release/polkadot-parachain /out/

# ---- polkadot-sdk checkout stub: the tag with only the patched file materialised, so setup.sh finds a patched checkout
# next to binaries without the image carrying the sources

FROM debian:trixie-slim AS sdk-stub
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=pins /sdk.pins /pins/sdk.pins
COPY stack/patches/polkadot-sdk-fulu.patch /pins/
RUN . /pins/sdk.pins \
 && git clone -q --depth 1 --filter=blob:none --no-checkout --branch "$POLKADOT_SDK_TAG" "$POLKADOT_SDK_URL" /stub/polkadot-sdk \
 && git -C /stub/polkadot-sdk sparse-checkout set --no-cone "/$FULU_PATCHED_SOURCE" \
 && git -C /stub/polkadot-sdk reset -q --hard HEAD \
 && git -C /stub/polkadot-sdk apply /pins/polkadot-sdk-fulu.patch \
 && touch -d @1 "/stub/polkadot-sdk/$FULU_PATCHED_SOURCE" \
 && mkdir /stub/polkadot-sdk/polkadot /stub/polkadot-sdk/substrate

# ---- solc: the official releases have no linux-arm64 binary before 0.8.31, so 0.8.30 is built from the release tarball

FROM debian:trixie-slim AS solc-bin
ARG SOLC_VERSION
ARG SOLC_SHA256=5e8d58dff551a18205e325c22f1a3b194058efbdc128853afd75d31b0568216d
ARG SOLC_JOBS=2
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential cmake curl ca-certificates \
    libboost-filesystem-dev libboost-program-options-dev libboost-system-dev libboost-test-dev \
 && rm -rf /var/lib/apt/lists/*
RUN curl -fsSLo /solidity.tar.gz "https://github.com/ethereum/solidity/releases/download/v${SOLC_VERSION}/solidity_${SOLC_VERSION}.tar.gz" \
 && echo "${SOLC_SHA256}  /solidity.tar.gz" | sha256sum -c - \
 && tar -xzf /solidity.tar.gz -C /
RUN cmake -S "/solidity_${SOLC_VERSION}" -B /build -DCMAKE_BUILD_TYPE=Release -DSOLC_LINK_STATIC=ON -DONLY_BUILD_SOLIDITY_EXECUTABLE=ON -DUSE_Z3=OFF -DUSE_CVC5=OFF \
 && cmake --build /build --target solc -j "$SOLC_JOBS" \
 && strip /build/solc/solc \
 && cp /build/solc/solc /solc \
 && /solc --version

# ---- tools the stack and the POC use, installed the way the macOS host has them (apart from the Snowbridge Nix shell)

FROM ethereum/client-go:${GETH_VERSION} AS geth

FROM debian:trixie-slim AS tools
ARG TARGETARCH
ARG SOLC_VERSION
ARG NODE_VERSION=24.22.3
ARG GO_VERSION=1.26.8
ARG FOUNDRY_VERSION=v1.2.3
ARG FOUNDRY_SNOWBRIDGE_VERSION=v1.7.0
ARG PNPM_VERSION=12.3.4
ARG MAGE_VERSION=v1.15.0
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
    ca-certificates curl git jq moreutils direnv procps tini xz-utils build-essential pkg-config protobuf-compiler python3 \
 && rm -rf /var/lib/apt/lists/*
RUN case "$TARGETARCH" in amd64) arch=x64 ;; *) arch=$TARGETARCH ;; esac \
 && file="node-v${NODE_VERSION}-linux-${arch}.tar.xz" \
 && curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/${file}" \
 && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" | grep " ${file}\$" | sha256sum -c - \
 && tar -xJf "$file" -C /usr/local --strip-components=1 --no-same-owner --exclude='*.md' --exclude=LICENSE \
 && rm "$file" \
 && npm install -g "pnpm@${PNPM_VERSION}"
# old node-gyp-build finds no arm64 prebuild on Node 24 (arm_version is unset), so pnpm falls back to a source build
RUN ln -s /usr/local/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js /usr/local/bin/node-gyp
RUN file="go${GO_VERSION}.linux-${TARGETARCH}.tar.gz" \
 && curl -fsSLO "https://dl.google.com/go/${file}" \
 && echo "$(curl -fsSL "https://dl.google.com/go/${file}.sha256")  ${file}" | sha256sum -c - \
 && tar -xzf "$file" -C /usr/local \
 && rm "$file"
ENV PATH=/usr/local/go/bin:$PATH
RUN GOBIN=/usr/local/bin GOPATH=/tmp/gopath go install "github.com/magefile/mage@${MAGE_VERSION}" \
 && GOPATH=/tmp/gopath go clean -modcache \
 && rm -r /tmp/gopath /root/.cache/go-build
RUN curl -fsSL "https://github.com/foundry-rs/foundry/releases/download/${FOUNDRY_VERSION}/foundry_${FOUNDRY_VERSION}_linux_${TARGETARCH}.tar.gz" \
    | tar -xz -C /usr/local/bin forge cast anvil
# Snowbridge's contracts need solc 0.8.34, which forge 1.2.3 (the POC's) does not know; its scripts get a newer forge first on PATH
RUN mkdir -p /opt/foundry-snowbridge/bin \
 && curl -fsSL "https://github.com/foundry-rs/foundry/releases/download/${FOUNDRY_SNOWBRIDGE_VERSION}/foundry_${FOUNDRY_SNOWBRIDGE_VERSION}_linux_${TARGETARCH}.tar.gz" \
    | tar -xz -C /opt/foundry-snowbridge/bin forge cast anvil
ENV GC_TOOLCHAIN_PATH=/opt/foundry-snowbridge/bin
COPY --from=geth /usr/local/bin/geth /usr/local/bin/geth
COPY --from=solc-bin /solc /usr/local/bin/solc
# forge reads ~/.svm, and svm has no 0.8.30 for linux-arm64
RUN mkdir -p "/root/.svm/${SOLC_VERSION}" && ln -s /usr/local/bin/solc "/root/.svm/${SOLC_VERSION}/solc-${SOLC_VERSION}"

# ---- the patched Snowbridge, lodestar (1 s slots) and geth layout from setup.sh, plus what the stack would build at every start

FROM tools AS sources
ENV GC_E2E_WORK=/work GC_NO_NIX=1
COPY --from=sdk-stub /stub/polkadot-sdk /work/polkadot-sdk
COPY setup.sh /poc/setup.sh
COPY stack /poc/stack
RUN /poc/setup.sh --sources-only
COPY docker/prebuild.sh /poc/docker/prebuild.sh
RUN SNOWBRIDGE_DIR=/work/snowbridge /poc/docker/prebuild.sh

# ---- the POC itself on top, so that its changes rebuild only this part

FROM sources AS final
COPY --from=sdk-bin /out/ /work/polkadot-sdk/target/release/
COPY assethub/package.json assethub/pnpm-lock.yaml assethub/pnpm-workspace.yaml /poc/assethub/
COPY e2e/package.json e2e/pnpm-lock.yaml e2e/pnpm-workspace.yaml /poc/e2e/
COPY services/package.json services/pnpm-lock.yaml services/pnpm-workspace.yaml /poc/services/
RUN for package in assethub e2e services; do CI=true pnpm --dir "/poc/$package" install --frozen-lockfile; done
COPY . /poc
RUN forge build --root /poc/eth -q && pnpm --dir /poc/assethub run build:contracts
# the stack's web packages are built into the image; the memory cap stays under the container's 12 GB
ENV REBUILD_WEB_API=false GC_MEMCAP_GB=11
WORKDIR /poc
ENTRYPOINT ["/usr/bin/tini", "--", "/poc/docker/entrypoint.sh"]
