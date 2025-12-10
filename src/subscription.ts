import type { Logger } from "./logger.ts";

export interface NodeInfo {
  label: string;     // "Moscow" (без эмодзи)
  vlessUrl: string;  // полный vless:// URL
}

export class SubscriptionManager {
  private refreshInterval?: number;

  constructor(
    private subscriptionUrl: string,
    private refreshIntervalHours: number,
    private logger: Logger,
  ) {}

  async fetchAndParse(): Promise<NodeInfo[]> {
    try {
      this.logger.info("Fetching subscription", { url: this.subscriptionUrl });

      // Get HWID from env or generate default
      const hwid = Deno.env.get("HWID") || "youtube-monitor-default-hwid";
      const version = "2.0.0";

      // Fetch subscription URL with custom headers
      const response = await fetch(this.subscriptionUrl, {
        signal: AbortSignal.timeout(30000),
        headers: {
          "User-Agent": "YouTube-Checker",
          "X-Device-OS": "CheckerOS",
          "X-Ver-OS": version,
          "X-Device-Model": "YouTube-Checker",
          "X-Hwid": hwid,
          "Accept": "*/*",
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const base64Text = await response.text();
      this.logger.info("Subscription fetched", {
        length: base64Text.length,
        preview: base64Text.substring(0, 100),
      });

      // Decode base64
      const decoded = atob(base64Text.trim());
      this.logger.info("Subscription decoded", {
        length: decoded.length,
        linesCount: decoded.split("\n").length,
      });

      // Split по \n и фильтровать пустые строки
      const lines = decoded.split("\n").filter((line) => line.trim().length > 0);

      const nodes: NodeInfo[] = [];

      for (const line of lines) {
        const trimmed = line.trim();

        // Проверяем что это vless:// URL
        if (trimmed.startsWith("vless://") ||
            trimmed.startsWith("vmess://") ||
            trimmed.startsWith("trojan://") ||
            trimmed.startsWith("ss://") ||
            trimmed.startsWith("shadowsocks://")) {

          const label = this.extractLabel(trimmed);

          if (label) {
            nodes.push({
              label,
              vlessUrl: trimmed,
            });

            this.logger.info("Node parsed", {
              label,
              protocol: trimmed.split("://")[0],
              urlPreview: trimmed.substring(0, 50) + "...",
            });
          } else {
            this.logger.warn("Failed to extract label from URL", {
              urlPreview: trimmed.substring(0, 100),
            });
          }
        }
      }

      this.logger.info("Subscription parsed", {
        totalLines: lines.length,
        nodesFound: nodes.length,
        labels: nodes.map(n => n.label),
      });

      if (nodes.length === 0) {
        this.logger.error("No nodes found in subscription!", {
          totalLines: lines.length,
          sampleLines: lines.slice(0, 3).map(l => l.substring(0, 100)),
        });
      }

      return nodes;
    } catch (error) {
      this.logger.error("Failed to fetch subscription", {
        url: this.subscriptionUrl,
        error: error.message,
      });
      throw error;
    }
  }

  private extractLabel(url: string): string {
    try {
      // Найти фрагмент (часть после #)
      const hashIndex = url.indexOf("#");
      if (hashIndex === -1) {
        // Нет лейбла, используем хост из URL
        const urlObj = new URL(url);
        return urlObj.hostname;
      }

      const fragment = url.substring(hashIndex + 1);

      // Декодировать URI component
      const decoded = decodeURIComponent(fragment);

      // Убрать эмодзи - взять текст после последнего пробела
      // Например: "🇷🇺 Moscow" → "Moscow"
      const parts = decoded.trim().split(/\s+/);
      const label = parts[parts.length - 1];

      return label || "unknown";
    } catch (error) {
      this.logger.warn("Failed to extract label from URL", {
        url,
        error: error.message,
      });
      return "unknown";
    }
  }

  startPeriodicRefresh(callback: (nodes: NodeInfo[]) => Promise<void>): void {
    const intervalMs = this.refreshIntervalHours * 60 * 60 * 1000;

    this.logger.info("Starting periodic subscription refresh", {
      intervalHours: this.refreshIntervalHours,
    });

    this.refreshInterval = setInterval(async () => {
      try {
        this.logger.info("Refreshing subscription");
        const nodes = await this.fetchAndParse();
        await callback(nodes);
      } catch (error) {
        this.logger.error("Periodic refresh failed", {
          error: error.message,
        });
      }
    }, intervalMs);
  }

  stop(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.logger.info("Subscription refresh stopped");
    }
  }
}
