import type { Config, AlertPayload } from "./types.ts";
import type { Logger } from "./logger.ts";

export class AlertManager {
  constructor(
    private config: Config,
    private logger: Logger,
  ) {}

  async sendAlert(payload: AlertPayload): Promise<void> {
    if (!this.config.webhooks?.enabled) {
      this.logger.debug("Webhooks disabled, skipping alert");
      return;
    }

    const endpoints = this.config.webhooks.endpoints?.filter(
      e => e.enabled && e.events.includes(payload.event)
    ) || [];

    if (endpoints.length === 0) {
      this.logger.debug("No webhook endpoints configured for event", {
        event: payload.event,
      });
      return;
    }

    this.logger.info("Sending alerts", {
      event: payload.event,
      endpoints: endpoints.length,
    });

    const promises = endpoints.map(endpoint =>
      this.sendToEndpoint(endpoint.url, endpoint.headers || {}, payload)
    );

    const results = await Promise.allSettled(promises);

    let successCount = 0;
    let failCount = 0;

    results.forEach((result, index) => {
      const endpoint = endpoints[index];
      
      if (result.status === "fulfilled") {
        successCount++;
        this.logger.debug(`Alert sent successfully to ${endpoint.name}`);
      } else {
        failCount++;
        this.logger.error(`Failed to send alert to ${endpoint.name}`, {
          error: result.reason?.message,
        });
      }
    });

    this.logger.info("Alert sending completed", {
      success: successCount,
      failed: failCount,
    });
  }

  private async sendToEndpoint(
    url: string,
    headers: Record<string, string>,
    payload: AlertPayload,
  ): Promise<void> {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      this.logger.debug("Webhook response received", {
        status: response.status,
        url,
      });
    } catch (error) {
      this.logger.error("Webhook request failed", {
        url,
        error: error.message,
      });
      throw error;
    }
  }
}