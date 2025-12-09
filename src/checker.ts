import type { Config, CheckResult } from "./types.ts";
import type { Logger } from "./logger.ts";

export class VideoChecker {
  private socksProxy?: string;
  private nodeLabel?: string;

  constructor(
    private config: Config,
    private logger: Logger,
  ) {}

  setSocksProxy(proxy: string) {
    this.socksProxy = proxy;
    this.logger.info("SOCKS proxy configured", { proxy });
  }

  setNodeLabel(label: string) {
    this.nodeLabel = label;
  }

  async checkAllVideos(): Promise<CheckResult[]> {
    // Проверяем все видео параллельно
    const promises = this.config.videos.map(video => 
      this.checkVideo(video.id)
    );
    
    return await Promise.all(promises);
  }

  async checkVideo(videoId: string): Promise<CheckResult> {
    const startTime = Date.now();
    
    try {
      this.logger.debug(`Checking video: ${videoId}`);
      
      // Формируем команду yt-dlp
      const args = [
        "--simulate",
        "--no-warnings",
        "--print", "title",
      ];

      // Добавляем прокси если настроен
      if (this.socksProxy) {
        args.push("--proxy", this.socksProxy);
      }

      args.push(`https://www.youtube.com/watch?v=${videoId}`);

      const command = new Deno.Command("yt-dlp", {
        args,
        stdout: "piped",
        stderr: "piped",
      });

      // Timeout
      const timeout = setTimeout(() => {
        this.logger.warn(`Check timeout for video: ${videoId}`);
      }, this.config.timeout_seconds * 1000);

      const { code, stdout, stderr } = await command.output();
      clearTimeout(timeout);

      const duration_ms = Date.now() - startTime;

      if (code === 0) {
        const title = new TextDecoder().decode(stdout).trim();
        
        this.logger.debug(`Video check successful: ${videoId}`, {
          title,
          duration_ms,
          proxy: this.socksProxy ? "enabled" : "disabled",
        });

        return {
          node_label: this.nodeLabel,
          video_id: videoId,
          status: "ok",
          success: true,
          duration_ms,
          timestamp: new Date().toISOString(),
        };
      } else {
        const errorOutput = new TextDecoder().decode(stderr);
        const error = this.parseError(errorOutput);
        
        this.logger.warn(`Video check failed: ${videoId}`, {
          error,
          duration_ms,
          proxy: this.socksProxy ? "enabled" : "disabled",
        });

        return {
          node_label: this.nodeLabel,
          video_id: videoId,
          status: "failed",
          success: false,
          duration_ms,
          error,
          timestamp: new Date().toISOString(),
        };
      }
    } catch (error) {
      const duration_ms = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      this.logger.error(`Video check exception: ${videoId}`, {
        error: errorMessage,
        duration_ms,
      });

      return {
        node_label: this.nodeLabel,
        video_id: videoId,
        status: "failed",
        success: false,
        duration_ms,
        error: errorMessage,
        timestamp: new Date().toISOString(),
      };
    }
  }

  private parseError(errorOutput: string): string {
    // Извлекаем понятное сообщение об ошибке из вывода yt-dlp
    
    if (errorOutput.includes("HTTP Error 403")) {
      return "HTTP 403: Video unavailable (access denied)";
    }
    
    if (errorOutput.includes("HTTP Error 404")) {
      return "HTTP 404: Video not found";
    }
    
    if (errorOutput.includes("Private video")) {
      return "Video is private";
    }
    
    if (errorOutput.includes("Video unavailable")) {
      return "Video unavailable";
    }
    
    if (errorOutput.includes("This video has been removed")) {
      return "Video has been removed";
    }
    
    if (errorOutput.includes("timeout")) {
      return "Connection timeout";
    }

    if (errorOutput.includes("Unable to connect")) {
      return "Proxy connection failed";
    }

    if (errorOutput.includes("SOCKS")) {
      return "SOCKS proxy error";
    }
    
    if (errorOutput.includes("Unable to extract")) {
      return "Unable to extract video data";
    }

    if (errorOutput.includes("Sign in to confirm your age")) {
      return "Age-restricted video";
    }
    
    // Если не можем распарсить, возвращаем первую строку ошибки
    const firstLine = errorOutput.split("\n").find(line => 
      line.includes("ERROR") || line.includes("WARNING")
    );
    
    return firstLine?.trim() || "Unknown error";
  }
}
