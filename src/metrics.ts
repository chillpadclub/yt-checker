import type { MetricsData } from "./types.ts";
import type { Logger } from "./logger.ts";

export class MetricsServer {
  private server?: Deno.HttpServer;
  private abortController?: AbortController;
  private authEnabled: boolean;
  private authUsername?: string;
  private authPassword?: string;

  constructor(
    private port: number,
    private path: string,
    private state: any,
    private logger: Logger,
  ) {
    // Читаем Basic Auth credentials из env
    this.authUsername = Deno.env.get("METRICS_USERNAME");
    this.authPassword = Deno.env.get("METRICS_PASSWORD");
    this.authEnabled = !!(this.authUsername && this.authPassword);

    if (this.authEnabled) {
      this.logger.info("Metrics Basic Auth enabled", {
        username: this.authUsername,
      });
    }
  }

  async start(): Promise<void> {
    this.abortController = new AbortController();

    const handler = (req: Request): Response => {
      const url = new URL(req.url);

      // Health endpoint - без авторизации
      if (url.pathname === "/health") {
        return new Response(
          JSON.stringify({ status: "healthy", timestamp: new Date().toISOString() }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      // Проверяем Basic Auth для /metrics
      if (this.authEnabled && (url.pathname === this.path || url.pathname === this.path + "/json")) {
        const authHeader = req.headers.get("Authorization");

        if (!authHeader || !authHeader.startsWith("Basic ")) {
          return new Response("Unauthorized", {
            status: 401,
            headers: {
              "WWW-Authenticate": 'Basic realm="Metrics"',
            },
          });
        }

        // Декодируем Basic Auth
        const base64Credentials = authHeader.substring(6);
        const credentials = atob(base64Credentials);
        const [username, password] = credentials.split(":");

        if (username !== this.authUsername || password !== this.authPassword) {
          return new Response("Unauthorized", {
            status: 401,
            headers: {
              "WWW-Authenticate": 'Basic realm="Metrics"',
            },
          });
        }
      }

      if (url.pathname === this.path) {
        // Prometheus format by default
        return new Response(this.getPrometheusMetrics(), {
          status: 200,
          headers: { "Content-Type": "text/plain; version=0.0.4" },
        });
      }

      // Optional JSON endpoint
      if (url.pathname === this.path + "/json") {
        return new Response(JSON.stringify(this.getMetrics(), null, 2), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response("Not Found", { status: 404 });
    };

    try {
      this.server = Deno.serve(
        {
          port: this.port,
          signal: this.abortController.signal,
          onListen: () => {
            this.logger.info(`Metrics server started`, {
              port: this.port,
              path: this.path,
            });
          },
        },
        handler
      );
    } catch (error) {
      this.logger.error("Failed to start metrics server", {
        error: error.message,
      });
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.abortController) {
      this.abortController.abort();
    }
    this.logger.info("Metrics server stopped");
  }

  private getMetrics(): MetricsData {
    const uptime = Math.floor((Date.now() - this.state.startTime) / 1000);
    const successfulChecks = this.state.totalChecks - this.state.totalFailures;
    const successRate = this.state.totalChecks > 0
      ? successfulChecks / this.state.totalChecks
      : 0;

    const videoStats = new Map<string, {
      status: "ok" | "failed";
      duration_ms: number;
      failures: number;
    }>();

    for (const result of this.state.lastCheckResults) {
      videoStats.set(result.video_id, {
        status: result.status,
        duration_ms: result.duration_ms,
        failures: result.success ? 0 : (videoStats.get(result.video_id)?.failures || 0) + 1,
      });
    }

    const videos = Array.from(videoStats.entries()).map(([id, stats]) => ({
      id,
      status: stats.status,
      last_check_duration_ms: stats.duration_ms,
      consecutive_failures: stats.failures,
    }));

    const avgResponseTime = this.state.lastCheckResults.length > 0
      ? this.state.lastCheckResults.reduce((sum, r) => sum + r.duration_ms, 0) / 
        this.state.lastCheckResults.length
      : 0;

    return {
      status: this.state.currentState,
      last_check: this.state.lastCheckResults[0]?.timestamp || new Date().toISOString(),
      uptime_seconds: uptime,
      checks: {
        total: this.state.totalChecks,
        successful: successfulChecks,
        failed: this.state.totalFailures,
        success_rate: successRate,
      },
      videos,
      performance: {
        avg_response_time_ms: avgResponseTime,
      },
    };
  }

  private getPrometheusMetrics(): string {
    const metrics = this.getMetrics();
    const lines: string[] = [];

    lines.push("# HELP youtube_monitor_up Whether the monitor is running (1 = yes, 0 = no)");
    lines.push("# TYPE youtube_monitor_up gauge");
    lines.push(`youtube_monitor_up 1`);
    lines.push("");

    lines.push("# HELP youtube_monitor_uptime_seconds Time since monitor started");
    lines.push("# TYPE youtube_monitor_uptime_seconds gauge");
    lines.push(`youtube_monitor_uptime_seconds ${metrics.uptime_seconds}`);
    lines.push("");

    lines.push("# HELP youtube_check_success Whether the video check succeeded (1 = yes, 0 = no)");
    lines.push("# TYPE youtube_check_success gauge");
    for (const result of this.state.lastCheckResults) {
      const node = result.node_label || "direct";
      const value = result.success ? 1 : 0;
      lines.push(`youtube_check_success{node="${node}",video_id="${result.video_id}"} ${value}`);
    }
    lines.push("");

    lines.push("# HELP youtube_check_duration_seconds Duration of video check");
    lines.push("# TYPE youtube_check_duration_seconds gauge");
    for (const result of this.state.lastCheckResults) {
      const node = result.node_label || "direct";
      const seconds = (result.duration_ms / 1000).toFixed(3);
      lines.push(`youtube_check_duration_seconds{node="${node}",video_id="${result.video_id}"} ${seconds}`);
    }
    lines.push("");

    lines.push("# HELP youtube_checks_total Total number of checks performed");
    lines.push("# TYPE youtube_checks_total counter");
    lines.push(`youtube_checks_total ${metrics.checks.total}`);
    lines.push("");

    lines.push("# HELP youtube_check_failures_total Total number of failed checks");
    lines.push("# TYPE youtube_check_failures_total counter");
    lines.push(`youtube_check_failures_total ${metrics.checks.failed}`);
    lines.push("");

    lines.push("# HELP youtube_check_success_rate Success rate of checks (0.0 to 1.0)");
    lines.push("# TYPE youtube_check_success_rate gauge");
    lines.push(`youtube_check_success_rate ${metrics.checks.success_rate.toFixed(4)}`);
    lines.push("");

    lines.push("# HELP youtube_avg_response_time_seconds Average response time in seconds");
    lines.push("# TYPE youtube_avg_response_time_seconds gauge");
    const avgSeconds = (metrics.performance.avg_response_time_ms / 1000).toFixed(3);
    lines.push(`youtube_avg_response_time_seconds ${avgSeconds}`);
    lines.push("");

    lines.push("# HELP youtube_monitor_status Current monitor status (0=healthy, 1=degraded, 2=failed)");
    lines.push("# TYPE youtube_monitor_status gauge");
    const statusValue = metrics.status === "healthy" ? 0 : 
                       metrics.status === "degraded" ? 1 : 2;
    lines.push(`youtube_monitor_status ${statusValue}`);

    return lines.join("\n");
  }
}