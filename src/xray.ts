import type { Logger } from "./logger.ts";

interface XrayConfig {
  log: {
    loglevel: string;
  };
  inbounds: Array<{
    port: number;
    listen: string;
    protocol: string;
    settings: {
      auth: string;
      udp: boolean;
    };
  }>;
  outbounds: Array<{
    protocol: string;
    settings?: any;
    streamSettings?: any;
  }>;
}

export class XrayManager {
  private process?: Deno.ChildProcess;
  private socksPort: number;
  private configPath = "/etc/xray/config.json";

  constructor(
    private proxyLink: string,
    private logger: Logger,
  ) {
    this.socksPort = parseInt(Deno.env.get("XRAY_SOCKS_PORT") || "10808");
  }

  async start(): Promise<void> {
    this.logger.info("Starting Xray proxy", {
      socksPort: this.socksPort,
    });

    try {
      // Генерируем конфиг из proxy link
      const config = await this.generateConfig();
      
      // Сохраняем конфиг
      await Deno.writeTextFile(this.configPath, JSON.stringify(config, null, 2));
      
      this.logger.debug("Xray config written", { path: this.configPath });

      // Запускаем Xray
      const command = new Deno.Command("xray", {
        args: ["run", "-c", this.configPath],
        stdout: "piped",
        stderr: "piped",
      });

      this.process = command.spawn();

      // Читаем вывод Xray в фоне
      this.readOutput();

      // Ждем пока Xray запустится
      await this.waitForReady();

      this.logger.info("Xray proxy started successfully");
    } catch (error) {
      this.logger.error("Failed to start Xray", { error: error.message });
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.process) {
      this.logger.info("Stopping Xray proxy");
      this.process.kill("SIGTERM");
      await this.process.status;
      this.logger.info("Xray proxy stopped");
    }
  }

  getSocksProxy(): string {
    return `socks5://127.0.0.1:${this.socksPort}`;
  }

  private async generateConfig(): Promise<XrayConfig> {
    // Парсим proxy link
    const outbound = await this.parseProxyLink(this.proxyLink);

    return {
      log: {
        loglevel: "warning",
      },
      inbounds: [
        {
          port: this.socksPort,
          listen: "127.0.0.1",
          protocol: "socks",
          settings: {
            auth: "noauth",
            udp: true,
          },
        },
      ],
      outbounds: [outbound],
    };
  }

  private async parseProxyLink(link: string): Promise<any> {
    const url = new URL(link);
    const protocol = url.protocol.replace(":", "");

    this.logger.debug("Parsing proxy link", { protocol });

    switch (protocol) {
      case "vless":
        return this.parseVless(url);
      case "vmess":
        return this.parseVmess(link);
      case "trojan":
        return this.parseTrojan(url);
      case "shadowsocks":
      case "ss":
        return this.parseShadowsocks(url);
      default:
        throw new Error(`Unsupported protocol: ${protocol}`);
    }
  }

  private parseVless(url: URL): any {
    const uuid = url.username;
    const address = url.hostname;
    const port = parseInt(url.port);
    const params = new URLSearchParams(url.search);

    const outbound: any = {
      protocol: "vless",
      settings: {
        vnext: [
          {
            address,
            port,
            users: [
              {
                id: uuid,
                encryption: params.get("encryption") || "none",
                flow: params.get("flow") || "",
              },
            ],
          },
        ],
      },
    };

    // Stream settings
    const type = params.get("type") || "tcp";
    const security = params.get("security") || "none";

    outbound.streamSettings = {
      network: type,
      security,
    };

    // TLS/Reality settings
    if (security === "tls") {
      outbound.streamSettings.tlsSettings = {
        serverName: params.get("sni") || address,
        fingerprint: params.get("fp") || "chrome",
        allowInsecure: params.get("allowInsecure") === "1",
      };
    } else if (security === "reality") {
      outbound.streamSettings.realitySettings = {
        serverName: params.get("sni") || address,
        fingerprint: params.get("fp") || "chrome",
        publicKey: params.get("pbk") || "",
        shortId: params.get("sid") || "",
        spiderX: params.get("spx") || "",
      };
    }

    // Transport settings
    if (type === "ws") {
      outbound.streamSettings.wsSettings = {
        path: params.get("path") || "/",
        headers: params.get("host") ? { Host: params.get("host") } : {},
      };
    } else if (type === "grpc") {
      outbound.streamSettings.grpcSettings = {
        serviceName: params.get("serviceName") || "",
      };
    } else if (type === "http" || type === "h2") {
      outbound.streamSettings.httpSettings = {
        host: params.get("host")?.split(",") || [],
        path: params.get("path") || "/",
      };
    }

    return outbound;
  }

  private parseVmess(link: string): any {
    // VMess обычно в base64
    const base64Config = link.replace("vmess://", "");
    const configStr = atob(base64Config);
    const config = JSON.parse(configStr);

    return {
      protocol: "vmess",
      settings: {
        vnext: [
          {
            address: config.add,
            port: parseInt(config.port),
            users: [
              {
                id: config.id,
                alterId: parseInt(config.aid || "0"),
                security: config.scy || "auto",
              },
            ],
          },
        ],
      },
      streamSettings: {
        network: config.net || "tcp",
        security: config.tls === "tls" ? "tls" : "none",
        wsSettings: config.net === "ws" ? {
          path: config.path || "/",
          headers: config.host ? { Host: config.host } : {},
        } : undefined,
        tlsSettings: config.tls === "tls" ? {
          serverName: config.sni || config.add,
          allowInsecure: config.skip_cert_verify || false,
        } : undefined,
      },
    };
  }

  private parseTrojan(url: URL): any {
    const password = url.username;
    const address = url.hostname;
    const port = parseInt(url.port);
    const params = new URLSearchParams(url.search);

    return {
      protocol: "trojan",
      settings: {
        servers: [
          {
            address,
            port,
            password,
          },
        ],
      },
      streamSettings: {
        network: params.get("type") || "tcp",
        security: params.get("security") || "tls",
        tlsSettings: {
          serverName: params.get("sni") || address,
          fingerprint: params.get("fp") || "chrome",
          allowInsecure: params.get("allowInsecure") === "1",
        },
      },
    };
  }

  private parseShadowsocks(url: URL): any {
    // ss://method:password@server:port
    const userInfo = atob(url.username);
    const [method, password] = userInfo.split(":");
    const address = url.hostname;
    const port = parseInt(url.port);

    return {
      protocol: "shadowsocks",
      settings: {
        servers: [
          {
            address,
            port,
            method,
            password,
          },
        ],
      },
    };
  }

  private async readOutput() {
    if (!this.process?.stdout || !this.process?.stderr) return;

    // Читаем stdout
    (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of this.process!.stdout!) {
        const text = decoder.decode(chunk);
        if (text.trim()) {
          this.logger.debug("Xray stdout", { output: text.trim() });
        }
      }
    })();

    // Читаем stderr
    (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of this.process!.stderr!) {
        const text = decoder.decode(chunk);
        if (text.trim()) {
          this.logger.debug("Xray stderr", { output: text.trim() });
        }
      }
    })();
  }

  private async waitForReady(): Promise<void> {
    // Ждем пока SOCKS порт станет доступен
    const maxAttempts = 30;
    let attempts = 0;

    while (attempts < maxAttempts) {
      try {
        const conn = await Deno.connect({
          hostname: "127.0.0.1",
          port: this.socksPort,
        });
        conn.close();
        return;
      } catch {
        await new Promise(resolve => setTimeout(resolve, 100));
        attempts++;
      }
    }

    throw new Error("Xray failed to start - SOCKS port not available");
  }

  async testConnection(): Promise<boolean> {
    this.logger.debug("Testing Xray connection");

    try {
      // Пытаемся подключиться к SOCKS порту
      const conn = await Deno.connect({
        hostname: "127.0.0.1",
        port: this.socksPort,
      });
      conn.close();

      this.logger.debug("Xray connection test passed");
      return true;
    } catch (error) {
      this.logger.error("Xray connection test failed", { error: error.message });
      return false;
    }
  }
}
