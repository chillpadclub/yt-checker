# YouTube Proxy Monitor

Мониторинг доступности YouTube через прокси-ноду. Проверяет доступность видео и отправляет алерты при сбоях.

## Возможности

- ✅ Быстрая проверка доступности YouTube (1-2 сек на проверку)
- 🔔 Алерты через webhook (n8n, Telegram, Discord и др.)
- 📊 Метрики для Prometheus (готово к подключению)
- 📝 Структурированное логирование (JSON Lines)
- 🐳 Готовый Docker контейнер
- 🔄 Автоматическая ротация логов
- 💪 Debounce алертов (не спамит)
- 🎯 Умное определение состояния (healthy/degraded/failed)

## Быстрый старт

### 1. Создайте структуру проекта

```bash
mkdir youtube-monitor && cd youtube-monitor
mkdir src logs

# Скопируйте все файлы из артефактов:
# - monitor.ts
# - config.json
# - Dockerfile
# - docker-compose.yml
# - .env.example
# - src/checker.ts
# - src/alerting.ts
# - src/metrics.ts
# - src/logger.ts
# - src/types.ts
```

### 2. Настройте конфигурацию

```bash
# Скопируйте пример .env
cp .env.example .env

# Отредактируйте .env
nano .env
```

Укажите ваш `WEBHOOK_URL` для получения алертов.

### 3. Настройте config.json (опционально)

По умолчанию используются 3 стабильных видео. Можете заменить их на свои:

```json
{
  "videos": [
    {
      "id": "dQw4w9WgXcQ",
      "title": "Test Video 1",
      "weight": 1
    }
  ],
  "check_interval_seconds": 300,
  "alert_threshold": 2
}
```

### 4. Запуск

#### Docker Compose (рекомендуется)

```bash
# Сборка и запуск
docker-compose up -d

# Проверка логов
docker-compose logs -f

# Остановка
docker-compose down
```

#### Docker напрямую

```bash
# Сборка
docker build -t youtube-monitor .

# Запуск в daemon режиме
docker run -d \
  --name youtube-monitor \
  -p 9090:9090 \
  -v $(pwd)/logs:/app/logs \
  -v $(pwd)/config.json:/app/config.json:ro \
  -e WEBHOOK_URL="https://your-webhook.com" \
  youtube-monitor

# Одноразовая проверка
docker run --rm \
  -v $(pwd)/config.json:/app/config.json:ro \
  -e WEBHOOK_URL="https://your-webhook.com" \
  youtube-monitor \
  sh -c "deno run --allow-all monitor.ts --mode=once"
```

#### Без Docker (локально)

```bash
# Установите зависимости
# - Deno: curl -fsSL https://deno.land/install.sh | sh
# - yt-dlp: pip install yt-dlp
# - ffmpeg: apt install ffmpeg

# Запуск
deno run --allow-all monitor.ts --mode=daemon
```

## Режимы работы

### Daemon (основной режим)

Постоянная работа с периодическими проверками:

```bash
docker run youtube-monitor --mode=daemon
# или через env
docker run -e MODE=daemon youtube-monitor
```

### Once (одноразовая проверка)

Для быстрой проверки или тестирования:

```bash
docker run --rm youtube-monitor --mode=once
```

Вывод:
```
Running single check...

Results:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ OK | dQw4w9WgXcQ | 1234ms
✅ OK | jNQXAC9IVRw | 1456ms
✅ OK | 9bZkp7q19f0 | 1678ms
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Total: 3 | Failed: 0 | Success: 3

Overall Status: OK
```

### Validate (проверка конфигурации)

```bash
docker run --rm youtube-monitor --mode=validate
```

Вывод:
```
Validating configuration...

✅ Videos: 3 configured
✅ Webhooks: 1 endpoint(s) configured
   - n8n: https://n8n.example.com/webhook/youtube-monitor
✅ Metrics: enabled on port 9090
✅ yt-dlp: 2024.12.06

✅ Configuration is valid
```

## Endpoints

### Health Check

```bash
curl http://localhost:9090/health
```

Ответ:
```json
{
  "status": "healthy",
  "timestamp": "2024-12-09T10:30:00Z"
}
```

### Metrics (JSON)

```bash
curl http://localhost:9090/metrics
```

Ответ:
```json
{
  "status": "healthy",
  "last_check": "2024-12-09T10:30:00Z",
  "uptime_seconds": 3600,
  "checks": {
    "total": 12,
    "successful": 12,
    "failed": 0,
    "success_rate": 1.0
  },
  "videos": [
    {
      "id": "dQw4w9WgXcQ",
      "status": "ok",
      "last_check_duration_ms": 1234,
      "consecutive_failures": 0
    }
  ],
  "performance": {
    "avg_response_time_ms": 1450
  }
}
```

### Metrics (Prometheus format)

```bash
curl http://localhost:9090/metrics?format=prometheus
```

Ответ:
```
# HELP youtube_monitor_up Whether the monitor is running
# TYPE youtube_monitor_up gauge
youtube_monitor_up 1

# HELP youtube_check_success Whether the video check succeeded
# TYPE youtube_check_success gauge
youtube_check_success{video_id="dQw4w9WgXcQ"} 1

# HELP youtube_check_duration_seconds Duration of video check
# TYPE youtube_check_duration_seconds gauge
youtube_check_duration_seconds{video_id="dQw4w9WgXcQ"} 1.234
```

## Webhook Payload

Формат данных, отправляемых на webhook:

```json
{
  "event": "error",
  "severity": "critical",
  "timestamp": "2024-12-09T10:30:00Z",
  "node": {
    "hostname": "proxy-node-1",
    "ip": "1.2.3.4"
  },
  "status": {
    "available": false,
    "failed_videos": 2,
    "total_videos": 3,
    "details": [
      {
        "video_id": "dQw4w9WgXcQ",
        "status": "failed",
        "success": false,
        "duration_ms": 1523,
        "error": "HTTP 403: Video unavailable",
        "timestamp": "2024-12-09T10:30:00Z"
      }
    ]
  },
  "message": "YouTube proxy check FAILED: 2/3 videos unavailable",
  "metadata": {
    "consecutive_failures": 3,
    "last_success": "2024-12-09T10:15:00Z"
  }
}
```

### События (events)

- `error` - критическая ошибка (≥2 видео недоступны)
- `recovery` - восстановление после ошибки
- `warning` - частичная недоступность (1 видео недоступно)

## Интеграции

### n8n

В n8n создайте Webhook trigger и используйте его URL:

```bash
WEBHOOK_URL=https://your-n8n.com/webhook/youtube-monitor
```

### Telegram Bot

Добавьте в `config.json`:

```json
{
  "webhooks": {
    "endpoints": [
      {
        "name": "telegram",
        "url": "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/sendMessage",
        "enabled": true,
        "events": ["error", "recovery"],
        "headers": {
          "Content-Type": "application/json"
        }
      }
    ]
  }
}
```

И модифицируйте payload в `src/alerting.ts` для Telegram формата.

### Prometheus + Grafana

1. Добавьте job в `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: 'youtube-monitor'
    static_configs:
      - targets: ['youtube-monitor:9090']
```

2. Импортируйте dashboard в Grafana

3. Создайте алерты на основе метрик:
   - `youtube_check_success == 0`
   - `youtube_check_success_rate < 0.8`

## Логи

### Основной лог

```bash
tail -f logs/youtube-monitor.log
```

Формат:
```
2024-12-09T10:30:00Z [INFO] Check completed {"total":3,"failed":0,"success":3,"duration_ms":1234}
2024-12-09T10:30:05Z [ERROR] YouTube proxy FAILED {"failed":2,"total":3}
```

### Структурированные логи проверок

```bash
tail -f logs/checks.jsonl
```

Формат (JSON Lines):
```json
{"timestamp":"2024-12-09T10:00:00Z","level":"info","message":"Check completed","data":{"total":3,"failed":0}}
{"timestamp":"2024-12-09T10:05:00Z","level":"info","message":"Check completed","data":{"total":3,"failed":1}}
```

Парсинг с `jq`:
```bash
# Последние 10 проверок
cat logs/checks.jsonl | tail -10 | jq .

# Только неудачные проверки
cat logs/checks.jsonl | jq 'select(.data.failed > 0)'

# Статистика за сегодня
cat logs/checks.jsonl | jq -s 'map(.data.failed) | add'
```

## Настройка

### Основные параметры

| Параметр | Описание | По умолчанию |
|----------|----------|--------------|
| `check_interval_seconds` | Интервал проверок | 300 (5 минут) |
| `timeout_seconds` | Таймаут на проверку | 30 |
| `alert_threshold` | Сколько видео должно упасть для алерта | 2 |
| `debounce_minutes` | Минимальный интервал между алертами | 15 |

### Выбор видео

Рекомендуется использовать:
- Популярные, старые видео (не удалят)
- Официальные каналы (YouTube, Vevo)
- Разные типы контента

Примеры стабильных видео:
- `dQw4w9WgXcQ` - Rick Astley (310M+ views)
- `jNQXAC9IVRw` - First YouTube video (280M+ views)
- `9bZkp7q19f0` - PSY Gangnam Style (5B+ views)

## Устранение неполадок

### yt-dlp не найден

```bash
docker exec youtube-monitor yt-dlp --version
```

Если не работает - пересоберите контейнер:
```bash
docker-compose down
docker-compose build --no-cache
docker-compose up -d
```

### Webhook не отправляется

Проверьте логи:
```bash
docker-compose logs | grep "webhook"
```

Проверьте URL:
```bash
docker exec youtube-monitor env | grep WEBHOOK_URL
```

### Метрики недоступны

Проверьте что порт открыт:
```bash
curl http://localhost:9090/health
```

Проверьте конфиг:
```bash
docker exec youtube-monitor cat config.json | jq .metrics
```

### Видео недоступно

Проверьте вручную:
```bash
docker exec youtube-monitor yt-dlp --simulate https://www.youtube.com/watch?v=dQw4w9WgXcQ
```

## Production рекомендации

1. **Используйте docker-compose** с restart policy
2. **Настройте ротацию логов** через logrotate или Docker logging driver
3. **Мониторьте сам монитор** через healthcheck
4. **Используйте несколько endpoint'ов** для алертов (дублирование)
5. **Настройте debounce** чтобы не спамить алертами
6. **Запускайте на каждой прокси-ноде** отдельный инстанс

## Лицензия

MIT

## Поддержка

Если возникли вопросы или проблемы - создайте Issue.