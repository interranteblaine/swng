import { Logger as PowertoolsLogger } from "@aws-lambda-powertools/logger";
import type { Logger } from "@swng/application";

export class PowertoolsLoggerAdapter implements Logger {
  constructor(private readonly logger: PowertoolsLogger) {}

  info(message: string, context?: Record<string, unknown>): void {
    if (context) {
      this.logger.info(message, context);
    } else {
      this.logger.info(message);
    }
  }

  error(message: string, context?: Record<string, unknown>): void {
    if (context) {
      this.logger.error(message, context);
    } else {
      this.logger.error(message);
    }
  }

  warn(message: string, context?: Record<string, unknown>): void {
    if (context) {
      this.logger.warn(message, context);
    } else {
      this.logger.warn(message);
    }
  }

  debug(message: string, context?: Record<string, unknown>): void {
    if (context) {
      this.logger.debug(message, context);
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
