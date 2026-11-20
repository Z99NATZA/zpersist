FROM node:22-bookworm-slim AS web
WORKDIR /build
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM rust:1.95-bookworm AS server
WORKDIR /build
COPY backend/Cargo.toml backend/Cargo.lock ./
COPY backend/src ./src
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/build/target \
    cargo build --release --locked && cp target/release/zpersist /build/zpersist

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --no-create-home zpersist
COPY --from=server /build/zpersist /usr/local/bin/zpersist
COPY --from=web /build/dist /app/web
ENV STATIC_DIR=/app/web
EXPOSE 8003
USER zpersist
ENTRYPOINT ["zpersist"]
