import type { Config, CheckResult } from "./types.ts";
import type { Logger } from "./logger.ts";

export class VideoChecker {
  constructor(
    private config: Config,
    private logger: Logger,
  ) {}

  async checkAllVideos(): Promise<CheckResult[]> {
    const promises = this.config.videos.map(video => 
      this.checkVideo(video.id)
    );
    
    return await Promise.all(promises);
  }

  async checkVideo(videoId: string): Promise<CheckResult> {
    const startTime = Date.now();
    
    try {
      this.logger.debug(`Checking video: ${videoId}`);
      
      const command = new Deno.Command("yt-dlp", {
        args: [
          "--simulate",
          "--no-warnings",
          "--print", "title",
          `https://www.youtube.com/watch?v=${videoId}`,
        ],
        stdout: "piped",
        stderr: "piped",
      });

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
        });

        return {
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
        });

        return {
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
      
      this.logger.error(`Video check exception: ${videoId}`, {
        error: error.message,
        duration_ms,
      });

      return {
        video_id: videoId,
        status: "failed",
        success: false,
        duration_ms,
        error: error.message,
        timestamp: new Date().toISOString(),
      };
    }
  }

  private parseError(errorOutput: string): string {
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
    
    if (errorOutput.includes("Unable to extract")) {
      return "Unable to extract video data";
    }

    if (errorOutput.includes("Sign in to confirm your age")) {
      return "Age-restricted video";
    }
    
    const firstLine = errorOutput.split("\n").find(line => 
      line.includes("ERROR") || line.includes("WARNING")
    );
    
    return firstLine?.trim() || "Unknown error";
  }
}