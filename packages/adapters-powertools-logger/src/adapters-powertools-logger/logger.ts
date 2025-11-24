import { Logger as PowertoolsLogger } from "@aws-lambda-powertools/logger";
import type { Logger } from "@swng/application";

export class PowertoolsLoggerAdapter implements Logger {
  constructor(
    private readonly logger: PowertoolsLogger,
    private readonly baseContext: Record<string, unknown> = {}
  ) {}

  with(context: Record<string, unknown>): Logger {
    return new PowertoolsLoggerAdapter(this.logger, {
      ...this.baseContext,
      ...context,
    });
  }

  private merge(
    context?: Record<string, unknown>
  ): Record<string, unknown> | undefined {
    if (!this.baseContext || Object.keys(this.baseContext).length === 0) {
      return context;
    }
    return context ? { ...this.baseContext, ...context } : this.baseContext;
  }

  info(message: string, context?: Record<string, unknown>): void {
    const merged = this.merge(context);
    if (merged) {
      this.logger.info(message, merged);
    } else {
      this.logger.info(message);
    }
  }

  error(message: string, context?: Record<string, unknown>): void {
    const merged = this.merge(context);
    if (merged) {
      this.logger.error(message, merged);
    } else {
      this.logger.error(message);
    }
  }

  warn(message: string, context?: Record<string, unknown>): void {
    const merged = this.merge(context);
    if (merged) {
      this.logger.warn(message, merged);
    } else {
      this.logger.warn(message);
    }
  }

  debug(message: string, context?: Record<string, unknown>): void {
    const merged = this.merge(context);
    if (merged) {
      this.logger.debug(message, merged);
    } else {
      this.logger.debug(message);
    }
  }
}

export interface LoggerConfig {
  serviceName: string;
  logLevel?: "DEBUG" | "INFO" | "WARN" | "ERROR";
}

export function createPowertoolsLogger(config: LoggerConfig): Logger {
  const powertoolsLogger = new PowertoolsLogger({
    serviceName: config.serviceName,
    logLevel: config.logLevel || "INFO",
  });

  return new PowertoolsLoggerAdapter(powertoolsLogger);
}
