# PostgreSQL 16 (alpine) + pgvector, for the RAG layer.
#
# Why a custom image instead of pgvector/pgvector:pg16: that image is Debian/glibc. The existing data
# volume was created by postgres:16-alpine (musl); switching the C library changes text collation and
# would silently corrupt every btree index on text columns until reindexed. Staying on the same base
# image keeps the volume byte-compatible, so the upgrade is "stop, start with the new image".
#
# pgvector is pinned to a release tag; `with_llvm=no` skips LLVM bitcode (the alpine image is built
# with --with-llvm but ships no clang), which only disables JIT for the extension's own functions.
ARG PG_IMAGE=postgres:16-alpine
FROM ${PG_IMAGE}

ARG PGVECTOR_VERSION=v0.8.0

RUN set -eux; \
    apk add --no-cache --virtual .build-deps git build-base; \
    git clone --depth 1 --branch "${PGVECTOR_VERSION}" https://github.com/pgvector/pgvector.git /tmp/pgvector; \
    cd /tmp/pgvector; \
    make OPTFLAGS="" with_llvm=no; \
    make install with_llvm=no; \
    cd /; \
    rm -rf /tmp/pgvector; \
    apk del .build-deps
