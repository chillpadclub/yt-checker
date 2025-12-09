#!/usr/bin/env -S deno run --allow-net --allow-read --allow-write=./logs --allow-env --allow-run=yt-dlp

import { parse } from "https://deno.land/std@0.208.0/flags/mod.ts";
import { VideoChecker } from "./src/checker.ts";
import { AlertManager } from "./src/alerting.ts";
import { MetricsServer } from "./src/metrics.ts";
import { Logger } from "./src/logger.ts";
import type { Config, CheckResult } from "./src/types.ts";

const VERSION = "1.0.0";

// Загрузка конфига
async function loadConfig(): Promise<Config> {
  try {
    const configText = await Deno.readTextFile("./config.json");
    const config = JSON.parse(configText);
    
    // Подстановка env переменных
    if (config.webhooks?.endpoints) {
      config.webhooks.endpoints = config.webhooks.endpoints.map((endpoint: any) => ({
        ...endpoint,
        url: endpoint.url.replace(/\$\{(\w+)\}/g, (_: string, key: string) => 
          Deno.env.get(key) || endpoint.url
        )
      }));
    }
    
    return config;
  } catch (error) {
    console.error("Failed to load config.json:", error.message);
    Deno.exit(1);
  }
}

// Состояние мониторинга
class MonitorState {
  consecutiveFailures = 0;
  lastAlertSent: number | null = null;
  currentState: "healthy" | "degraded" | "failed" = "healthy";
  totalChecks = 0;
  totalFailures = 0;
  startTime = Date.now();
  lastCheckResults: CheckResult[] = [];
}

class YouTubeMonitor {
  private config: Config;
  private logger: Logger;
  private checker: VideoChecker;
  private alertManager: AlertManager;
  private metricsServer?: MetricsServer;
  private state: MonitorState;
  private checkInterval?: number;

  constructor(config: Config) {
    this.config = config;
    this.logger = new Logger(config.logging);
    this.checker = new VideoChecker(config, this.logger);
    this.alertManager = new AlertManager(config, this.logger);
    this.state = new MonitorState();
    
    if (config.metrics?.enabled) {
      this.metricsServer = new MetricsServer(
        config.metrics.port,
        config.metrics.path,
        this.state,
        this.logger
      );
    }
  }

  async start() {
    this.logger.info("YouTube Monitor started", {
      version: VERSION,
      checkInterval: this.config.check_interval_seconds,
      videos: this.config.videos.length,
      webhooksEnabled: this.config.webhooks?.enabled,
      metricsEnabled: this.config.metrics?.enabled,
    });

    // Стартуем metrics сервер
    if (this.metricsServer) {
      await this.metricsServer.start();
    }

    // Первая проверка сразу
    await this.runCheck();

    // Запускаем периодические проверки
    this.checkInterval = setInterval(
      () => this.runCheck(),
      this.config.check_interval_seconds * 1000
    );

    // Graceful shutdown
    const shutdown = async () => {
      this.logger.info("Shutting down...");
      if (this.checkInterval) {
        clearInterval(this.checkInterval);
      }
      if (this.metricsServer) {
        await this.metricsServer.stop();
      }
      Deno.exit(0);
    };

    Deno.addSignalListener("SIGINT", shutdown);
    Deno.addSignalListener("SIGTERM", shutdown);
  }

  async runCheck() {
    this.logger.debug("Running check cycle");
    this.state.totalChecks++;

    try {
      // Проверяем все видео параллельно
      const results = await this.checker.checkAllVideos();
      this.state.lastCheckResults = results;

      // Анализируем результаты
      const failedCount = results.filter(r => !r.success).length;
      const totalCount = results.length;

      this.logger.info("Check completed", {
        total: totalCount,
        failed: failedCount,
        success: totalCount - failedCount,
        duration_ms: Math.max(...results.map(r => r.duration_ms)),
      });

      // Обновляем состояние
      if (failedCount >= this.config.alert_threshold) {
        await this.handleFailure(results, failedCount, totalCount);
      } else if (failedCount > 0) {
        await this.handleDegradation(results, failedCount, totalCount);
      } else {
        await this.handleSuccess(results);
      }

    } catch (error) {
      this.logger.error("Check cycle failed", { error: error.message });
      this.state.totalFailures++;
    }
  }

  private async handleFailure(results: CheckResult[], failedCount: number, totalCount: number) {
    this.state.consecutiveFailures++;
    this.state.totalFailures++;

    const previousState = this.state.currentState;
    this.state.currentState = "failed";

    // Алертим только при смене состояния или если debounce прошел
    const shouldAlert = previousState !== "failed" || this.shouldSendAlert();

    if (shouldAlert) {
      this.logger.error("YouTube proxy FAILED", {
        failed: failedCount,
        total: totalCount,
        consecutiveFailures: this.state.consecutiveFailures,
      });

      await this.alertManager.sendAlert({
        event: "error",
        severity: "critical",
        timestamp: new Date().toISOString(),
        node: {
          hostname: Deno.hostname(),
          ip: await this.getLocalIP(),
        },
        status: {
          available: false,
          failed_videos: failedCount,
          total_videos: totalCount,
          details: results,
        },
        message: `YouTube proxy check FAILED: ${failedCount}/${totalCount} videos unavailable`,
        metadata: {
          consecutive_failures: this.state.consecutiveFailures,
          last_success: this.getLastSuccessTime(),
        },
      });

      this.state.lastAlertSent = Date.now();
    }
  }

  private async handleDegradation(results: CheckResult[], failedCount: number, totalCount: number) {
    const previousState = this.state.currentState;
    this.state.currentState = "degraded";

    if (previousState === "healthy") {
      this.logger.warn("YouTube proxy DEGRADED", {
        failed: failedCount,
        total: totalCount,
      });

      if (this.config.webhooks?.endpoints?.some(e => e.events.includes("warning"))) {
        await this.alertManager.sendAlert({
          event: "warning",
          severity: "warning",
          timestamp: new Date().toISOString(),
          node: {
            hostname: Deno.hostname(),
            ip: await this.getLocalIP(),
          },
          status: {
            available: true,
            failed_videos: failedCount,
            total_videos: totalCount,
            details: results,
          },
          message: `YouTube proxy DEGRADED: ${failedCount}/${totalCount} videos failing`,
          metadata: {
            consecutive_failures: this.state.consecutiveFailures,
            last_success: this.getLastSuccessTime(),
          },
        });
      }
    }
  }

  private async handleSuccess(results: CheckResult[]) {
    const previousState = this.state.currentState;
    this.state.currentState = "healthy";
    this.state.consecutiveFailures = 0;

    // Recovery alert
    if (previousState === "failed") {
      this.logger.info("YouTube proxy RECOVERED");

      await this.alertManager.sendAlert({
        event: "recovery",
        severity: "info",
        timestamp: new Date().toISOString(),
        node: {
          hostname: Deno.hostname(),
          ip: await this.getLocalIP(),
        },
        status: {
          available: true,
          failed_videos: 0,
          total_videos: results.length,
          details: results,
        },
        message: "YouTube proxy RECOVERED - all checks passing",
        metadata: {
          consecutive_failures: 0,
          last_success: new Date().toISOString(),
        },
      });
    }
  }

  private shouldSendAlert(): boolean {
    if (!this.state.lastAlertSent) return true;
    
    const debounceMs = this.config.debounce_minutes * 60 * 1000;
    return (Date.now() - this.state.lastAlertSent) > debounceMs;
  }

  private getLastSuccessTime(): string | null {
    const successResults = this.state.lastCheckResults.filter(r => r.success);
    if (successResults.length === 0) return null;
    return new Date().toISOString();
  }

  private async getLocalIP(): Promise<string> {
    try {
      // Простой способ получить IP
      const response = await fetch("https://api.ipify.org?format=json", {
        signal: AbortSignal.timeout(5000),
      });
      const data = await response.json();
      return data.ip;
    } catch {
      return "unknown";
    }
  }

  async runOnce(): Promise<boolean> {
    console.log("Running single check...\n");
    
    const results = await this.checker.checkAllVideos();
    const failedCount = results.filter(r => !r.success).length;
    const totalCount = results.length;

    // Выводим результаты
    console.log("Results:");
    console.log("━".repeat(60));
    
    for (const result of results) {
      const status = result.success ? "✅ OK" : "❌ FAILED";
      const duration = result.duration_ms.toFixed(0);
      
      console.log(`${status} | ${result.video_id} | ${duration}ms`);
      
      if (!result.success && result.error) {
        console.log(`    Error: ${result.error}`);
      }
    }
    
    console.log("━".repeat(60));
    console.log(`Total: ${totalCount} | Failed: ${failedCount} | Success: ${totalCount - failedCount}`);
    
    const overallStatus = failedCount >= this.config.alert_threshold ? "FAILED" : "OK";
    console.log(`\nOverall Status: ${overallStatus}`);
    
    return failedCount < this.config.alert_threshold;
  }

  async validate(): Promise<boolean> {
    console.log("Validating configuration...\n");
    
    let valid = true;

    // Проверяем videos
    if (!this.config.videos || this.config.videos.length === 0) {
      console.error("❌ No videos configured");
      valid = false;
    } else {
      console.log(`✅ Videos: ${this.config.videos.length} configured`);
    }

    // Проверяем webhooks
    if (this.config.webhooks?.enabled) {
      const endpoints = this.config.webhooks.endpoints?.filter(e => e.enabled) || [];
      if (endpoints.length === 0) {
        console.warn("⚠️  Webhooks enabled but no endpoints configured");
      } else {
        console.log(`✅ Webhooks: ${endpoints.length} endpoint(s) configured`);
        for (const endpoint of endpoints) {
          console.log(`   - ${endpoint.name}: ${endpoint.url}`);
        }
      }
    }

    // Проверяем metrics
    if (this.config.metrics?.enabled) {
      console.log(`✅ Metrics: enabled on port ${this.config.metrics.port}`);
    }

    // Проверяем yt-dlp
    try {
      const ytDlpCheck = new Deno.Command("yt-dlp", {
        args: ["--version"],
        stdout: "piped",
        stderr: "piped",
      });
      
      const { code, stdout } = await ytDlpCheck.output();
      
      if (code === 0) {
        const version = new TextDecoder().decode(stdout).trim();
        console.log(`✅ yt-dlp: ${version}`);
      } else {
        console.error("❌ yt-dlp not found or not working");
        valid = false;
      }
    } catch {
      console.error("❌ yt-dlp not found");
      valid = false;
    }

    console.log(valid ? "\n✅ Configuration is valid" : "\n❌ Configuration has errors");
    return valid;
  }
}

// Main
async function main() {
  const args = parse(Deno.args, {
    string: ["mode"],
    default: {
      mode: Deno.env.get("MODE") || "daemon",
    },
  });

  const mode = args.mode;

  if (mode === "version") {
    console.log(`YouTube Monitor v${VERSION}`);
    Deno.exit(0);
  }

  const config = await loadConfig();
  const monitor = new YouTubeMonitor(config);

  switch (mode) {
    case "once": {
      const success = await monitor.runOnce();
      Deno.exit(success ? 0 : 1);
      break;
    }

    case "validate": {
      const valid = await monitor.validate();
      Deno.exit(valid ? 0 : 1);
      break;
    }

    case "daemon":
      await monitor.start();
      // Keep running
      await new Promise(() => {});
      break;

    default:
      console.error(`Unknown mode: ${mode}`);
      console.error("Available modes: once, daemon, validate, version");
      Deno.exit(1);
  }
}

if (import.meta.main) {
  main();
}