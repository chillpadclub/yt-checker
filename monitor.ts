#!/usr/bin/env -S deno run --allow-net --allow-read --allow-write=./logs,/etc/xray --allow-env --allow-run=yt-dlp,xray --allow-sys

import { parse } from "https://deno.land/std@0.208.0/flags/mod.ts";
import { VideoChecker } from "./src/checker.ts";
import { AlertManager } from "./src/alerting.ts";
import { MetricsServer } from "./src/metrics.ts";
import { Logger } from "./src/logger.ts";
import { XrayManager } from "./src/xray.ts";
import { SubscriptionManager, type NodeInfo } from "./src/subscription.ts";
import type { Config, CheckResult } from "./src/types.ts";

const VERSION = "2.0.0";

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
  proxyEnabled = false;
  proxyStatus = "unknown";
}

class YouTubeMonitor {
  private config: Config;
  private logger: Logger;
  private checker: VideoChecker;
  private alertManager: AlertManager;
  private metricsServer?: MetricsServer;
  private xrayManager?: XrayManager;
  private subscriptionManager?: SubscriptionManager;
  private currentNodes: NodeInfo[] = [];
  private state: MonitorState;
  private checkInterval?: number;
  private isCheckInProgress = false;

  // Runtime parameters from env
  private checkIntervalSeconds: number;
  private timeoutSeconds: number;
  private alertThreshold: number;
  private debounceMinutes: number;
  private subscriptionRefreshHours: number;

  constructor(config: Config) {
    this.config = config;
    this.logger = new Logger(config.logging);

    // Read runtime parameters from env with defaults
    this.checkIntervalSeconds = parseInt(Deno.env.get("CHECK_INTERVAL_SECONDS") || "300");
    this.timeoutSeconds = parseInt(Deno.env.get("TIMEOUT_SECONDS") || "30");
    this.alertThreshold = parseInt(Deno.env.get("ALERT_THRESHOLD") || "2");
    this.debounceMinutes = parseInt(Deno.env.get("DEBOUNCE_MINUTES") || "15");
    this.subscriptionRefreshHours = parseInt(Deno.env.get("SUBSCRIPTION_REFRESH_HOURS") || "24");

    this.checker = new VideoChecker(config, this.logger, this.timeoutSeconds);
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
      checkInterval: this.checkIntervalSeconds,
      videos: this.config.videos.length,
      webhooksEnabled: this.config.webhooks?.enabled,
      metricsEnabled: this.config.metrics?.enabled,
    });

    // Инициализируем Subscription если указан SUBSCRIPTION_URL
    const subscriptionUrl = Deno.env.get("SUBSCRIPTION_URL");
    if (subscriptionUrl) {
      try {
        this.logger.info("Initializing subscription manager");
        this.subscriptionManager = new SubscriptionManager(
          subscriptionUrl,
          this.subscriptionRefreshHours,
          this.logger
        );

        // Загрузить ноды
        this.currentNodes = await this.subscriptionManager.fetchAndParse();
        this.logger.info("Nodes loaded from subscription", {
          count: this.currentNodes.length,
          nodes: this.currentNodes.map(n => n.label),
        });

        // Периодическое обновление
        this.subscriptionManager.startPeriodicRefresh(async (nodes) => {
          this.currentNodes = nodes;
          this.logger.info("Nodes refreshed", { count: nodes.length });
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.error("Failed to initialize subscription", {
          error: errorMessage,
        });
        this.logger.warn("Continuing without subscription...");
      }
    } else {
      // Если нет subscription, используем один PROXY_LINK (старый режим)
      const proxyLink = Deno.env.get("PROXY_LINK");
      if (proxyLink) {
        try {
          this.logger.info("Initializing Xray proxy");
          this.xrayManager = new XrayManager(proxyLink, this.logger);
          await this.xrayManager.start();

          // Настраиваем checker для использования прокси
          const socksProxy = this.xrayManager.getSocksProxy();
          this.checker.setSocksProxy(socksProxy);

          // Тестируем подключение
          const connected = await this.xrayManager.testConnection();
          this.state.proxyEnabled = true;
          this.state.proxyStatus = connected ? "connected" : "disconnected";

          this.logger.info("Xray proxy initialized", {
            proxy: socksProxy,
            status: this.state.proxyStatus,
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          this.logger.error("Failed to initialize Xray proxy", {
            error: errorMessage,
          });
          this.logger.warn("Continuing without proxy...");
        }
      } else {
        this.logger.info("No PROXY_LINK or SUBSCRIPTION_URL specified, running without proxy");
      }
    }

    // Стартуем metrics сервер
    if (this.metricsServer) {
      await this.metricsServer.start();
    }

    // Первая проверка сразу
    await this.runCheck();

    // Запускаем периодические проверки
    this.checkInterval = setInterval(
      () => this.runCheck(),
      this.checkIntervalSeconds * 1000
    );

    // Graceful shutdown
    const shutdown = async () => {
      this.logger.info("Shutting down...");
      if (this.checkInterval) {
        clearInterval(this.checkInterval);
      }
      if (this.subscriptionManager) {
        this.subscriptionManager.stop();
      }
      if (this.xrayManager) {
        await this.xrayManager.stop();
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
    // Предотвращаем параллельные проверки
    if (this.isCheckInProgress) {
      this.logger.warn("Check already in progress, skipping this cycle");
      return;
    }

    this.isCheckInProgress = true;
    this.logger.debug("Running check cycle");
    this.state.totalChecks++;

    try {
      const allResults: CheckResult[] = [];

      // Если есть subscription - проверяем каждую ноду ПОСЛЕДОВАТЕЛЬНО
      if (this.currentNodes.length > 0) {
        for (const node of this.currentNodes) {
          this.logger.info(`Checking node: ${node.label}`);

          let xrayManager: XrayManager | undefined;

          try {
            // [1] Запустить Xray для этой ноды
            xrayManager = new XrayManager(node.vlessUrl, this.logger);
            await xrayManager.start();

            // [2] Настроить checker
            const socksProxy = xrayManager.getSocksProxy();
            this.checker.setSocksProxy(socksProxy);
            this.checker.setNodeLabel(node.label);

            // [3] Проверить видео
            const results = await this.checker.checkAllVideos();
            allResults.push(...results);

            this.logger.info(`Node ${node.label} checked`, {
              total: results.length,
              failed: results.filter(r => !r.success).length,
            });

          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.logger.error(`Failed to check node ${node.label}`, {
              error: errorMessage,
            });

            // Добавить failed results для всех видео
            for (const video of this.config.videos) {
              allResults.push({
                node_label: node.label,
                video_id: video.id,
                status: "failed",
                success: false,
                duration_ms: 0,
                error: `Node check failed: ${errorMessage}`,
                timestamp: new Date().toISOString(),
              });
            }
          } finally {
            // [4] Остановить Xray
            if (xrayManager) {
              await xrayManager.stop();
            }
          }
        }
      } else {
        // Старый режим: один PROXY_LINK или без прокси
        // Обновляем proxyEnabled из состояния xrayManager
        if (this.xrayManager) {
          this.state.proxyEnabled = true;
          this.state.proxyStatus = "connected";
        }

        const results = await this.checker.checkAllVideos();
        allResults.push(...results);
      }

      this.state.lastCheckResults = allResults;

      // Анализируем результаты
      const failedCount = allResults.filter(r => !r.success).length;
      const totalCount = allResults.length;

      this.logger.info("Check completed", {
        total: totalCount,
        failed: failedCount,
        success: totalCount - failedCount,
        nodes: this.currentNodes.length > 0 ? this.currentNodes.length : (this.state.proxyEnabled ? 1 : 0),
        proxy: this.state.proxyEnabled ? "enabled" : "disabled",
      });

      // Обновляем состояние
      if (failedCount >= this.alertThreshold) {
        await this.handleFailure(allResults, failedCount, totalCount);
      } else if (failedCount > 0) {
        await this.handleDegradation(allResults, failedCount, totalCount);
      } else {
        await this.handleSuccess(allResults);
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error("Check cycle failed", { error: errorMessage });
      this.state.totalFailures++;
    } finally {
      this.isCheckInProgress = false;
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
        proxyEnabled: this.state.proxyEnabled,
      });

      // Проверяем есть ли error в events
      const hasErrorEvent = this.config.webhooks?.endpoints?.some(e => e.events.includes("error"));

      if (hasErrorEvent) {
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
          message: `YouTube ${this.state.proxyEnabled ? 'proxy' : 'direct'} check FAILED: ${failedCount}/${totalCount} videos unavailable`,
          metadata: {
            consecutive_failures: this.state.consecutiveFailures,
            last_success: this.getLastSuccessTime(),
            proxy_enabled: this.state.proxyEnabled,
            proxy_status: this.state.proxyStatus,
          },
        });
      }

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
        proxyEnabled: this.state.proxyEnabled,
      });

      // Проверяем есть ли degradation в events (если нет - используем warning как fallback)
      const hasDegradationEvent = this.config.webhooks?.endpoints?.some(e => e.events.includes("degradation"));
      const hasWarningEvent = this.config.webhooks?.endpoints?.some(e => e.events.includes("warning"));

      if (hasDegradationEvent || hasWarningEvent) {
        await this.alertManager.sendAlert({
          event: hasDegradationEvent ? "degradation" : "warning",
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
          message: `YouTube ${this.state.proxyEnabled ? 'proxy' : 'direct'} DEGRADED: ${failedCount}/${totalCount} videos failing`,
          metadata: {
            consecutive_failures: this.state.consecutiveFailures,
            last_success: this.getLastSuccessTime(),
            proxy_enabled: this.state.proxyEnabled,
            proxy_status: this.state.proxyStatus,
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

      // Проверяем есть ли recovery в events
      const hasRecoveryEvent = this.config.webhooks?.endpoints?.some(e => e.events.includes("recovery"));

      if (hasRecoveryEvent) {
        // Группируем результаты по нодам для отображения в алерте
        const nodesInfo = new Map<string, { total: number; success: number }>();
        for (const result of results) {
          const nodeLabel = result.node_label || "direct";
          if (!nodesInfo.has(nodeLabel)) {
            nodesInfo.set(nodeLabel, { total: 0, success: 0 });
          }
          const info = nodesInfo.get(nodeLabel)!;
          info.total++;
          if (result.success) info.success++;
        }

        const recoveredNodes = Array.from(nodesInfo.entries()).map(([label, info]) => ({
          node: label,
          total_videos: info.total,
          successful_videos: info.success,
          status: "recovered"
        }));

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
          message: `YouTube ${this.state.proxyEnabled ? 'proxy' : 'direct'} RECOVERED - all ${recoveredNodes.length} node(s) passing`,
          recovered_nodes: recoveredNodes,
          metadata: {
            consecutive_failures: 0,
            last_success: new Date().toISOString(),
            proxy_enabled: this.state.proxyEnabled,
            proxy_status: this.state.proxyStatus,
          },
        });
      }
    }
  }

  private shouldSendAlert(): boolean {
    if (!this.state.lastAlertSent) return true;

    const debounceMs = this.debounceMinutes * 60 * 1000;
    return (Date.now() - this.state.lastAlertSent) > debounceMs;
  }

  private getLastSuccessTime(): string | null {
    const successResults = this.state.lastCheckResults.filter(r => r.success);
    if (successResults.length === 0) return null;
    return new Date().toISOString();
  }

  private async getLocalIP(): Promise<string> {
    try {
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

    // Инициализируем Xray если указан PROXY_LINK
    const proxyLink = Deno.env.get("PROXY_LINK");
    if (proxyLink) {
      try {
        console.log("🔄 Initializing Xray proxy...");
        this.xrayManager = new XrayManager(proxyLink, this.logger);
        await this.xrayManager.start();
        
        const socksProxy = this.xrayManager.getSocksProxy();
        this.checker.setSocksProxy(socksProxy);
        
        console.log(`✅ Xray proxy started: ${socksProxy}\n`);
      } catch (error) {
        console.error(`❌ Failed to start Xray: ${error.message}`);
        console.log("Continuing without proxy...\n");
      }
    }
    
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

    const overallStatus = failedCount >= this.alertThreshold ? "FAILED" : "OK";
    console.log(`\nOverall Status: ${overallStatus}`);
    
    if (proxyLink) {
      console.log(`Proxy: ${this.xrayManager ? "enabled" : "failed to start"}`);
    }

    // Cleanup
    if (this.xrayManager) {
      await this.xrayManager.stop();
    }

    return failedCount < this.alertThreshold;
  }

  async testWebhook(): Promise<boolean> {
    console.log("Testing webhook configuration...\n");
    
    if (!this.config.webhooks?.enabled) {
      console.error("❌ Webhooks are disabled in config");
      return false;
    }

    const endpoints = this.config.webhooks.endpoints?.filter(e => e.enabled) || [];
    
    if (endpoints.length === 0) {
      console.error("❌ No webhook endpoints configured");
      return false;
    }

    console.log(`Found ${endpoints.length} endpoint(s), sending test alerts...\n`);

    // Создаем тестовый payload
    const testPayload: any = {
      event: "warning",
      severity: "info",
      timestamp: new Date().toISOString(),
      node: {
        hostname: Deno.hostname(),
        ip: await this.getLocalIP(),
      },
      status: {
        available: true,
        failed_videos: 0,
        total_videos: 3,
        details: [
          {
            video_id: "TEST123",
            status: "ok",
            success: true,
            duration_ms: 1234,
            timestamp: new Date().toISOString(),
          }
        ],
      },
      message: "🧪 TEST ALERT - YouTube Monitor webhook test",
      metadata: {
        consecutive_failures: 0,
        last_success: new Date().toISOString(),
        proxy_enabled: false,
        proxy_status: "n/a",
      },
    };

    let allSuccess = true;

    for (const endpoint of endpoints) {
      console.log(`Sending test alert to: ${endpoint.name}`);
      console.log(`URL: ${endpoint.url}`);
      
      try {
        const response = await fetch(endpoint.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(endpoint.headers || {}),
          },
          body: JSON.stringify(testPayload),
          signal: AbortSignal.timeout(10000),
        });

        if (response.ok) {
          console.log(`✅ Success! Status: ${response.status}`);
          const responseText = await response.text();
          if (responseText) {
            console.log(`   Response: ${responseText}\n`);
          } else {
            console.log(`   Response: (empty)\n`);
          }
        } else {
          console.error(`❌ Failed! Status: ${response.status}`);
          console.error(`   Response: ${await response.text()}\n`);
          allSuccess = false;
        }
      } catch (error) {
        console.error(`❌ Error: ${error.message}\n`);
        allSuccess = false;
      }
    }

    console.log(allSuccess ? "✅ All webhooks working!" : "❌ Some webhooks failed");
    return allSuccess;
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

    // Проверяем xray
    try {
      const xrayCheck = new Deno.Command("xray", {
        args: ["version"],
        stdout: "piped",
        stderr: "piped",
      });
      
      const { code, stdout } = await xrayCheck.output();
      
      if (code === 0) {
        const output = new TextDecoder().decode(stdout);
        const version = output.split("\n")[0];
        console.log(`✅ Xray: ${version}`);
      } else {
        console.error("❌ Xray not found or not working");
        valid = false;
      }
    } catch {
      console.error("❌ Xray not found");
      valid = false;
    }

    // Проверяем PROXY_LINK
    const proxyLink = Deno.env.get("PROXY_LINK");
    if (proxyLink) {
      console.log(`✅ PROXY_LINK: configured`);
      try {
        const url = new URL(proxyLink);
        console.log(`   Protocol: ${url.protocol.replace(":", "")}`);
      } catch {
        console.warn("⚠️  PROXY_LINK format may be invalid");
      }
    } else {
      console.log(`ℹ️  PROXY_LINK: not set (will run without proxy)`);
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
    console.log(`YouTube Monitor v${VERSION} (with Xray proxy support)`);
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

    case "test-webhook": {
      const success = await monitor.testWebhook();
      Deno.exit(success ? 0 : 1);
      break;
    }

    case "daemon":
      await monitor.start();
      // Keep running
      await new Promise(() => {});
      break;

    default:
      console.error(`Unknown mode: ${mode}`);
      console.error("Available modes: once, daemon, validate, test-webhook, version");
      Deno.exit(1);
  }
}

if (import.meta.main) {
  main();
}
