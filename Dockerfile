FROM python:3.11-slim

LABEL maintainer="youtube-monitor"
LABEL description="YouTube availability monitor for proxy nodes"
LABEL version="1.0.0"

RUN apt-get update && apt-get install -y \
    ffmpeg \
    unzip \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir yt-dlp

RUN curl -fsSL https://deno.land/install.sh | sh
ENV DENO_INSTALL="/root/.deno"
ENV PATH="${DENO_INSTALL}/bin:${PATH}"

WORKDIR /app

COPY config.json .
COPY monitor.ts .
COPY src/ ./src/

RUN mkdir -p logs

ENV MODE="daemon"
ENV LOG_LEVEL="info"

EXPOSE 9090

HEALTHCHECK --interval=5m --timeout=30s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:9090/health || exit 1

CMD ["sh", "-c", "deno run --allow-net --allow-read --allow-write=./logs --allow-env --allow-run=yt-dlp monitor.ts --mode=${MODE}"]