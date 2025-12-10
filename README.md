# YouTube Multi-Node Monitor

Мониторинг доступности YouTube через множественные прокси-ноды с Prometheus метриками. Проверяет доступность видео через subscription link (несколько vless нод) и отправляет алерты при сбоях.

## Возможности

- ✅ **Multi-node мониторинг** - проверка через несколько прокси-нод из subscription
- 🌐 **Xray proxy** - встроенная поддержка vless/vmess/trojan/shadowsocks
- 📊 **Prometheus метрики** - готовый формат с лейблами нод
- 🔔 **Умные алерты** - webhook уведомления с группировкой по нодам
- 🔐 **Basic Auth** - защита /metrics endpoint
- 🐳 **Оптимизированный Docker** - 350 MB образ, сборка за 70 секунд
- 💪 **Debounce алертов** - не спамит повторными уведомлениями
- 📝 **Структурированное логирование** - JSON Lines формат

## Быстрый старт

### 1. Клонируйте репозиторий

```bash
git clone <your-repo-url>
cd youtube-monitor
```

### 2. Настройте переменные окружения

```bash
cp .env.example .env
nano .env
```

Минимальная конфигурация:

```env
MODE=daemon
SUBSCRIPTION_URL=https://your-subscription-url.com/path
WEBHOOK_URL=https://n8n.example.com/webhook/youtube-monitor
METRICS_USERNAME=admin
METRICS_PASSWORD=secure_password_here
```

### 3. Запустите через Docker Compose

```bash
docker compose up -d
docker compose logs -f
```

Готово! Монитор запущен и проверяет доступность через все ноды из subscription.

## Конфигурация (.env)

Все runtime параметры настраиваются через переменные окружения в `.env` файле:

| Переменная | Описание | По умолчанию | Обязательна |
|------------|----------|--------------|-------------|
| **Основные параметры** |
| `MODE` | Режим работы: `daemon`, `once`, `validate`, `test-webhook` | `daemon` | ✅ |
| `LOG_LEVEL` | Уровень логирования: `debug`, `info`, `warn`, `error` | `info` | ❌ |
| **Интервалы и таймауты** |
| `CHECK_INTERVAL_SECONDS` | Интервал между проверками (секунды) | `300` | ❌ |
| `TIMEOUT_SECONDS` | Таймаут на одну проверку видео (секунды) | `30` | ❌ |
| `ALERT_THRESHOLD` | Сколько видео должно упасть для критического алерта | `2` | ❌ |
| `DEBOUNCE_MINUTES` | Минимальный интервал между повторными алертами (минуты) | `15` | ❌ |
| `SUBSCRIPTION_REFRESH_HOURS` | Как часто обновлять список нод из subscription (часы) | `24` | ❌ |
| **Webhook и алерты** |
| `WEBHOOK_URL` | URL для отправки алертов | - | ✅ |
| **Метрики** |
| `METRICS_PORT` | Порт для метрик | `9090` | ❌ |
| `METRICS_USERNAME` | Basic Auth логин для /metrics | - | ⚠️ |
| `METRICS_PASSWORD` | Basic Auth пароль для /metrics | - | ⚠️ |
| **Proxy конфигурация** |
| `SUBSCRIPTION_URL` | URL с base64 списком vless:// нод | - | ✅ |
| `PROXY_LINK` | Одиночный vless:// URL (альтернатива subscription) | - | ❌ |
| `XRAY_SOCKS_PORT` | Порт SOCKS5 прокси | `10808` | ❌ |

⚠️ **Рекомендуется** настроить Basic Auth для защиты метрик

## Режимы работы

### daemon - Постоянный мониторинг

```bash
docker compose up -d
```

Периодически проверяет все ноды согласно `CHECK_INTERVAL_SECONDS` из `.env` (по умолчанию 300 секунд = 5 минут).

### once - Одноразовая проверка

```bash
docker run --rm -v ./config.json:/app/config.json:ro \
  -e SUBSCRIPTION_URL="..." \
  yt-checker-youtube-monitor \
  sh -c "deno run --allow-all monitor.ts --mode=once"
```

Выполняет одну проверку всех нод и завершается.

### validate - Проверка конфигурации

```bash
docker compose run --rm youtube-monitor \
  sh -c "deno run --allow-all monitor.ts --mode=validate"
```

Валидирует `config.json`, проверяет доступность yt-dlp и Xray.

### test-webhook - Тест вебхуков

```bash
docker compose run --rm -e MODE=test-webhook youtube-monitor
```

Отправляет тестовое уведомление на все настроенные webhook endpoints.

## Prometheus метрики

### Формат по умолчанию

```bash
curl http://localhost:9090/metrics
# С Basic Auth:
curl -u admin:password http://localhost:9090/metrics
```

Пример ответа:

```prometheus
# HELP youtube_monitor_up Whether the monitor is running
# TYPE youtube_monitor_up gauge
youtube_monitor_up 1

# HELP youtube_check_success Whether the video check succeeded
# TYPE youtube_check_success gauge
youtube_check_success{node="Amsterdam",video_id="dQw4w9WgXcQ"} 1
youtube_check_success{node="Moscow",video_id="dQw4w9WgXcQ"} 0
youtube_check_success{node="Frankfurt",video_id="dQw4w9WgXcQ"} 1

# HELP youtube_check_duration_seconds Duration of video check
# TYPE youtube_check_duration_seconds gauge
youtube_check_duration_seconds{node="Amsterdam",video_id="dQw4w9WgXcQ"} 1.234
youtube_check_duration_seconds{node="Moscow",video_id="dQw4w9WgXcQ"} 5.678
youtube_check_duration_seconds{node="Frankfurt",video_id="dQw4w9WgXcQ"} 1.456

# HELP youtube_checks_total Total number of checks performed
# TYPE youtube_checks_total counter
youtube_checks_total 42

# HELP youtube_check_success_rate Success rate of checks
# TYPE youtube_check_success_rate gauge
youtube_check_success_rate 0.8571
```

### JSON формат (опционально)

```bash
curl http://localhost:9090/metrics/json
```

### Healthcheck endpoint

```bash
curl http://localhost:9090/health
```

Ответ (без авторизации):

```json
{
  "status": "healthy",
  "timestamp": "2025-12-10T12:00:00Z"
}
```

## Webhook алерты

### Типы событий

Монитор отправляет 4 типа webhook событий:

| Событие | Severity | Когда отправляется | Условие |
|---------|----------|-------------------|---------|
| `error` | `critical` | Критический сбой | ≥ `ALERT_THRESHOLD` видео недоступны |
| `degradation` | `warning` | Частичная деградация | 1+ видео недоступны, но < `ALERT_THRESHOLD` |
| `recovery` | `info` | Восстановление | Переход из состояния `failed` в `healthy` |
| `warning` | `warning` | Некритичные проблемы | Fallback для degradation (если degradation не в events) |

**Важно:** В `config.json` можно настроить какие события отправлять:

```json
{
  "webhooks": {
    "enabled": true,
    "endpoints": [
      {
        "name": "n8n",
        "url": "${WEBHOOK_URL}",
        "enabled": true,
        "events": ["error", "recovery", "warning", "degradation"]
      }
    ]
  }
}
```

Если какого-то event нет в массиве `events` - он **не будет отправлен**.

### Debounce и Alert Threshold

- **ALERT_THRESHOLD** (default: 2) - сколько видео должно упасть для критического алерта `error`
- **DEBOUNCE_MINUTES** (default: 15) - минимальный интервал между повторными алертами одного типа

**Пример:**
- Упало 1 видео → отправится `degradation` (если в events)
- Упало 2+ видео → отправится `error` (если в events)
- Следующий `error` алерт не раньше чем через 15 минут

### Формат payload

#### Event: error

```json
{
  "event": "error",
  "severity": "critical",
  "timestamp": "2025-12-10T12:00:00.000Z",
  "message": "YouTube proxy check FAILED: 2/3 videos unavailable",
  "node": {
    "label": "Moscow",
    "hostname": "youtube-monitor",
    "ip": "10.0.0.1"
  },
  "status": {
    "available": false,
    "failed_videos": 2,
    "total_videos": 3,
    "details": [
      {
        "node_label": "Moscow",
        "video_id": "dQw4w9WgXcQ",
        "status": "failed",
        "success": false,
        "duration_ms": 5234,
        "error": "HTTP 403: Video unavailable (access denied)",
        "timestamp": "2025-12-10T12:00:00.000Z"
      }
    ]
  },
  "metadata": {
    "consecutive_failures": 3,
    "last_success": "2025-12-10T11:45:00.000Z",
    "proxy_enabled": true,
    "proxy_status": "connected"
  }
}
```

#### Event: degradation

```json
{
  "event": "degradation",
  "severity": "warning",
  "timestamp": "2025-12-10T12:00:00.000Z",
  "message": "YouTube proxy DEGRADED: 1/3 videos unavailable",
  "node": {
    "label": "Frankfurt",
    "hostname": "youtube-monitor",
    "ip": "10.0.0.1"
  },
  "status": {
    "available": true,
    "failed_videos": 1,
    "total_videos": 3,
    "details": [...]
  }
}
```

#### Event: recovery

```json
{
  "event": "recovery",
  "severity": "info",
  "timestamp": "2025-12-10T12:05:00.000Z",
  "message": "YouTube proxy RECOVERED: all videos accessible",
  "node": {
    "hostname": "youtube-monitor",
    "ip": "10.0.0.1"
  },
  "status": {
    "available": true,
    "failed_videos": 0,
    "total_videos": 3,
    "details": [...]
  },
  "metadata": {
    "downtime_duration_ms": 300000,
    "consecutive_failures": 0
  }
}
```

### Тестирование вебхуков

```bash
# Отправить тестовый warning webhook
docker compose run --rm youtube-monitor \
  sh -c "deno run --allow-all monitor.ts --mode=test-webhook"
```

Проверьте что webhook пришел в ваш n8n/webhook endpoint.

## Subscription Link

Формат subscription URL: base64-encoded список vless:// URL разделенных `\n`.

**Пример декодированного содержимого:**

```
vless://uuid@de.server.com:443?type=tcp&security=reality#🇩🇪 Frankfurt
vless://uuid@nl.server.com:443?type=tcp&security=reality#🇳🇱 Amsterdam
vless://uuid@ru.server.com:443?type=tcp&security=reality#🇷🇺 Moscow
```

Лейблы нод извлекаются из фрагмента URL (часть после `#`). Эмодзи автоматически удаляются, остается только текст.

## Интеграция с Prometheus

Добавьте в `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: 'youtube-monitor'
    scrape_interval: 30s
    static_configs:
      - targets: ['youtube-monitor:9090']
    basic_auth:
      username: admin
      password: secure_password_here
```

### Пример PromQL запросов

```promql
# Количество упавших нод
count(youtube_check_success{video_id="dQw4w9WgXcQ"} == 0)

# Success rate по нодам
avg by (node) (youtube_check_success)

# Средняя задержка проверки
avg(youtube_check_duration_seconds)

# Топ самых медленных нод
topk(3, avg by (node) (youtube_check_duration_seconds))
```

### Grafana Dashboard

Рекомендуемые панели:

1. **Overall Status** - gauge с `youtube_monitor_status`
2. **Success Rate** - graph с `youtube_check_success_rate`
3. **Node Health** - table с `youtube_check_success` по нодам
4. **Response Time** - graph с `youtube_check_duration_seconds`
5. **Total Checks** - counter с `youtube_checks_total`

## config.json

Конфигурационный файл содержит только **статические параметры** (список видео, webhook endpoints):

```json
{
  "videos": [
    {
      "id": "dQw4w9WgXcQ",
      "title": "Rick Astley - Never Gonna Give You Up",
      "weight": 1
    },
    {
      "id": "jNQXAC9IVRw",
      "title": "Me at the zoo",
      "weight": 1
    },
    {
      "id": "9bZkp7q19f0",
      "title": "PSY - GANGNAM STYLE",
      "weight": 1
    }
  ],

  "webhooks": {
    "enabled": true,
    "endpoints": [
      {
        "name": "n8n",
        "url": "${WEBHOOK_URL}",
        "enabled": true,
        "events": ["error", "recovery", "warning", "degradation"]
      }
    ]
  },

  "metrics": {
    "enabled": true,
    "port": 9090,
    "path": "/metrics"
  },

  "logging": {
    "level": "info",
    "max_age_hours": 24,
    "console": true,
    "file": true
  }
}
```

**Все runtime параметры** (интервалы, таймауты, thresholds) вынесены в `.env` файл для удобной настройки без редактирования JSON.

## Архитектура multi-node проверки

```
YouTubeMonitor
├── SubscriptionManager - загружает и парсит base64 список нод
│   └── Периодическое обновление (раз в SUBSCRIPTION_REFRESH_HOURS часов)
│
├── Для каждой ноды ПОСЛЕДОВАТЕЛЬНО:
│   ├── [1] XrayManager.start(vless_url) → SOCKS5 на :XRAY_SOCKS_PORT
│   ├── [2] VideoChecker.setSocksProxy("socks5://127.0.0.1:XRAY_SOCKS_PORT")
│   ├── [3] VideoChecker.setNodeLabel("Moscow")
│   ├── [4] Проверка всех видео через yt-dlp (timeout: TIMEOUT_SECONDS)
│   ├── [5] XrayManager.stop()
│   └── Повторить для следующей ноды
│
├── MetricsServer - отдает Prometheus метрики с лейблом node=
└── AlertManager - группирует ошибки по нодам (threshold: ALERT_THRESHOLD)
    └── Debounce повторных алертов (DEBOUNCE_MINUTES минут)
```

## Логи

### Основной лог

```bash
docker compose logs -f
```

### Структурированные логи проверок

```bash
tail -f logs/checks.jsonl | jq .
```

Формат (JSON Lines):

```json
{"timestamp":"2025-12-10T12:00:00Z","level":"info","message":"Check completed","data":{"total":15,"failed":2,"nodes":5}}
```

Парсинг:

```bash
# Только ошибки
cat logs/checks.jsonl | jq 'select(.data.failed > 0)'

# Статистика за сегодня
cat logs/checks.jsonl | jq -s '[.[] | .data.failed] | add'
```

## Устранение неполадок

### Проверка нод из subscription

```bash
docker compose exec youtube-monitor sh -c \
  "curl -s '$SUBSCRIPTION_URL' | base64 -d"
```

### Проверка Xray

```bash
docker compose exec youtube-monitor xray version
```

### Проверка yt-dlp через прокси

```bash
docker compose exec youtube-monitor sh -c \
  "yt-dlp --proxy socks5://127.0.0.1:10808 --simulate 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'"
```

### Webhook не работает

Проверьте тестовым режимом:

```bash
docker compose run --rm -e MODE=test-webhook youtube-monitor
```

### Метрики требуют авторизацию

Если Basic Auth не настроен, метрики доступны без пароля. Для безопасности установите:

```env
METRICS_USERNAME=admin
METRICS_PASSWORD=strong_password_here
```

## Production рекомендации

1. ✅ **Используйте `restart: unless-stopped`** в docker-compose.yml
2. ✅ **Настройте Basic Auth** для /metrics endpoint
3. ✅ **Мониторьте healthcheck** через `/health` endpoint
4. ✅ **Используйте несколько webhook endpoints** для дублирования
5. ✅ **Настройте `DEBOUNCE_MINUTES`** в .env чтобы не спамить
6. ✅ **Ротация логов** через Docker logging driver:

```yaml
services:
  youtube-monitor:
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
```

## Лицензия

MIT
