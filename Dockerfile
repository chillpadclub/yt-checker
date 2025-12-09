FROM python:3.11-slim

# Метаданные
LABEL maintainer="youtube-monitor"
LABEL description="YouTube availability monitor with Xray proxy support"
LABEL version="2.0.0"

# Установка системных зависимостей
RUN apt-get update && apt-get install -y \
    ffmpeg \
    curl \
    ca-certificates \
    wget \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Установка yt-dlp
RUN pip install --no-cache-dir yt-dlp

# Установка Deno
RUN curl -fsSL https://deno.land/install.sh | sh
ENV DENO_INSTALL="/root/.deno"
ENV PATH="${DENO_INSTALL}/bin:${PATH}"

# Установка Xray-core
RUN XRAY_VERSION=$(curl -s https://api.github.com/repos/XTLS/Xray-core/releases/latest | grep tag_name | cut -d '"' -f 4) && \
    wget -O /tmp/xray.zip "https://github.com/XTLS/Xray-core/releases/download/${XRAY_VERSION}/Xray-linux-64.zip" && \
    unzip /tmp/xray.zip -d /usr/local/bin/ && \
    chmod +x /usr/local/bin/xray && \
    rm /tmp/xray.zip

# Рабочая директория
WORKDIR /app

# Копируем файлы
COPY config.json .
COPY monitor.ts .
COPY src/ ./src/

# Создаем директории
RUN mkdir -p logs /etc/xray

# Переменные окружения по умолчанию
ENV MODE="daemon"
ENV LOG_LEVEL="info"
ENV XRAY_SOCKS_PORT="10808"

# Expose metrics port
EXPOSE 9090

# Healthcheck
HEALTHCHECK --interval=5m --timeout=30s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:9090/health || exit 1

# Запуск
CMD ["sh", "-c", "deno run --allow-net --allow-read --allow-write=./logs,/etc/xray --allow-env --allow-run=yt-dlp,xray --allow-sys monitor.ts --mode=${MODE}"]
