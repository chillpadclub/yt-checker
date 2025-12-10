import type {
  Config,
  AlertPayload,
  SimplifiedWebhookPayload,
  NodeSummary,
  CheckResult,
} from "./types.ts";
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

    // Create simplified payload
    const simplifiedPayload = this.createSimplifiedPayload(payload);

    const promises = endpoints.map(endpoint =>
      this.sendToEndpoint(endpoint.url, endpoint.headers || {}, simplifiedPayload)
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

  private createSimplifiedPayload(payload: AlertPayload): SimplifiedWebhookPayload {
    // Group results by node
    const nodeGroups = new Map<string, CheckResult[]>();

    for (const result of payload.status.details) {
      const nodeLabel = result.node_label || "direct";
      if (!nodeGroups.has(nodeLabel)) {
        nodeGroups.set(nodeLabel, []);
      }
      nodeGroups.get(nodeLabel)!.push(result);
    }

    // Create node summaries (only for failing nodes)
    const failingNodes: NodeSummary[] = [];

    for (const [nodeLabel, results] of nodeGroups.entries()) {
      const failedCount = results.filter(r => !r.success).length;
      const totalCount = results.length;

      // Only include nodes with failures
      if (failedCount > 0) {
        // Get unique error messages
        const errorSet = new Set<string>();
        for (const result of results) {
          if (result.error) {
            errorSet.add(result.error);
          }
        }

        failingNodes.push({
          node: nodeLabel,
          failed: failedCount,
          total: totalCount,
          status: "failed",
          errors: Array.from(errorSet),
        });
      }
    }

    // Calculate totals
    const totalNodesChecked = nodeGroups.size;
    const totalNodesFailed = failingNodes.length;
    const totalVideosChecked = payload.status.details.length;
    const totalVideosFailed = payload.status.failed_videos;

    const simplified: SimplifiedWebhookPayload = {
      event: payload.event,
      severity: payload.severity,
      timestamp: payload.timestamp,
      message: payload.message,
      failing_nodes: failingNodes,
      summary: {
        total_nodes_checked: totalNodesChecked,
        total_nodes_failed: totalNodesFailed,
        total_videos_failed: totalVideosFailed,
        total_videos_checked: totalVideosChecked,
      },
    };

    // Add recovered_nodes if present (for recovery events)
    if (payload.recovered_nodes) {
      simplified.recovered_nodes = payload.recovered_nodes;
    }

    return simplified;
  }

  private async sendToEndpoint(
    url: string,
    headers: Record<string, string>,
    payload: SimplifiedWebhookPayload,
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
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error("Webhook request failed", {
        url,
        error: errorMessage,
      });
      throw error;
    }
  }
}