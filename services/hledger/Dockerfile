FROM debian:bookworm-slim AS download
ARG HLEDGER_VERSION=1.52.4
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
 && curl -fsSL "https://github.com/simonmichael/hledger/releases/download/${HLEDGER_VERSION}/hledger-linux-x64.tar.gz" | tar -xz -C /usr/local/bin \
 && /usr/local/bin/hledger --version

FROM debian:bookworm-slim
COPY --from=download /usr/local/bin/hledger /usr/local/bin/hledger
ENV LANG=C.UTF-8
WORKDIR /hledger
CMD ["sleep", "infinity"]
