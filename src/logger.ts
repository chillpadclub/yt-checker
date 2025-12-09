import type { LoggingConfig, LogEntry } from "./types.ts";

export class Logger {
  private logFile?: Deno.FsFile;
  private logFilePath = "./logs/youtube-monitor.log";
  private checksLogPath = "./logs/checks.jsonl";

  constructor(private config: LoggingConfig) {
    this.initLogFiles();
  }

  private async initLogFiles() {
    if (!this.config.file) return;

    try {
      // Создаем директорию для логов
      await Deno.mkdir("./logs", { recursive: true });

      // Ротация старых логов
      await this.rotateOldLogs();
    } catch (error) {
      console.error("Failed to initialize log files:", error.message);
    }
  }

  private async rotateOldLogs() {
    try {
      const stat = await Deno.stat(this.logFilePath);
      const ageHours = (Date.now() - stat.mtime!.getTime()) / (1000 * 60 * 60);

      if (ageHours > this.config.max_age_hours) {
        const timestamp = stat.mtime!.toISOString().split("T")[0];
        await Deno.rename(this.logFilePath, `${this.logFilePath}.${timestamp}`);
      }
    } catch {
      // Файл не существует, ничего не делаем
    }
  }

  private getLevelValue(level: string): number {
    const levels: Record<string, number> = {
      debug: 0,
      info: 1,
      warn: 2,
      error: 3,
    };
    return levels[level] || 0;
  }

  private shouldLog(level: string): boolean {
    return this.getLevelValue(level) >= this.getLevelValue(this.config.level);
  }

  private formatMessage(level: string, message: string, data?: Record<string, any>): string {
    const timestamp = new Date().toISOString();
    const dataStr = data ? ` ${JSON.stringify(data)}` : "";
    return `${timestamp} [${level.toUpperCase()}] ${message}${dataStr}`;
  }

  private async writeToFile(message: string) {
    if (!this.config.file) return;

    try {
      await Deno.writeTextFile(
        this.logFilePath,
        message + "\n",
        { append: true }
      );
    } catch (error) {
      console.error("Failed to write to log file:", error.message);
    }
  }

  private async writeCheckLog(entry: LogEntry) {
    if (!this.config.file) return;

    try {
      await Deno.writeTextFile(
        this.checksLogPath,
        JSON.stringify(entry) + "\n",
        { append: true }
      );
    } catch (error) {
      console.error("Failed to write check log:", error.message);
    }
  }

  debug(message: string, data?: Record<string, any>) {
    if (!this.shouldLog("debug")) return;

    const formatted = this.formatMessage("debug", message, data);
    
    if (this.config.console) {
      console.log(formatted);
    }
    
    this.writeToFile(formatted);
  }

  info(message: string, data?: Record<string, any>) {
    if (!this.shouldLog("info")) return;

    const formatted = this.formatMessage("info", message, data);
    
    if (this.config.console) {
      console.log(formatted);
    }
    
    this.writeToFile(formatted);

    // Если это лог проверки, пишем в checks.jsonl
    if (message === "Check completed" && data) {
      this.writeCheckLog({
        timestamp: new Date().toISOString(),
        level: "info",
        message,
        data,
      });
    }
  }

  warn(message: string, data?: Record<string, any>) {
    if (!this.shouldLog("warn")) return;

    const formatted = this.formatMessage("warn", message, data);
    
    if (this.config.console) {
      console.warn(formatted);
    }
    
    this.writeToFile(formatted);
  }

  error(message: string, data?: Record<string, any>) {
    if (!this.shouldLog("error")) return;

    const formatted = this.formatMessage("error", message, data);
    
    if (this.config.console) {
      console.error(formatted);
    }
    
    this.writeToFile(formatted);
  }
}