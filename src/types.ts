// Configuration types
export interface VideoConfig {
  id: string;
  title: string;
  weight: number;
}

export interface WebhookEndpoint {
  name: string;
  url: string;
  enabled: boolean;
  events: Array<"error" | "recovery" | "warning">;
  headers?: Record<string, string>;
}

export interface WebhooksConfig {
  enabled: boolean;
  endpoints?: WebhookEndpoint[];
}

export interface MetricsConfig {
  enabled: boolean;
  port: number;
  path: string;
}

export interface LoggingConfig {
  level: "debug" | "info" | "warn" | "error";
  max_age_hours: number;
  console: boolean;
  file: boolean;
}

export interface ProxyConfig {
  type: "system" | "http" | "socks5";
  url?: string;
}

export interface Config {
  videos: VideoConfig[];
  check_interval_seconds: number;
  full_check_interval_seconds?: number;
  timeout_seconds: number;
  alert_threshold: number;
  speed_threshold_kbps?: number;
  debounce_minutes: number;
  webhooks?: WebhooksConfig;
  metrics?: MetricsConfig;
  logging: LoggingConfig;
  proxy?: ProxyConfig;
}

// Check result types
export interface CheckResult {
  video_id: string;
  status: "ok" | "failed";
  success: boolean;
  duration_ms: number;
  error?: string;
  timestamp: string;
}

// Alert types
export interface AlertPayload {
  event: "error" | "recovery" | "warning" | "degradation";
  severity: "critical" | "warning" | "info";
  timestamp: string;
  node: {
    hostname: string;
    ip: string;
  };
  status: {
    available: boolean;
    failed_videos: number;
    total_videos: number;
    details: CheckResult[];
  };
  message: string;
  metadata: {
    consecutive_failures: number;
    last_success: string | null;
  };
}

// Metrics types
export interface MetricsData {
  status: "healthy" | "degraded" | "failed";
  last_check: string;
  uptime_seconds: number;
  checks: {
    total: number;
    successful: number;
    failed: number;
    success_rate: number;
  };
  videos: Array<{
    id: string;
    status: "ok" | "failed";
    last_check_duration_ms: number;
    consecutive_failures: number;
  }>;
  performance: {
    avg_response_time_ms: number;
  };
}

// Log entry types
export interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  data?: Record<string, any>;
}