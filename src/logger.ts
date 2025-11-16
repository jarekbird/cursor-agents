import winston from 'winston';

// Create a logger that writes ALL output to stderr
// This is critical for MCP servers: stdout is reserved for JSON-RPC protocol messages
// All logs must go to stderr to avoid corrupting the MCP protocol stream
export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'cursor-agents' },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(winston.format.colorize(), winston.format.simple()),
      // Force all log levels to stderr to avoid interfering with MCP JSON-RPC on stdout
      stderrLevels: ['error', 'warn', 'info', 'verbose', 'debug', 'silly'],
    }),
  ],
  exceptionHandlers: [
    new winston.transports.Console({
      stderrLevels: ['error', 'warn', 'info', 'verbose', 'debug', 'silly'],
    }),
  ],
  rejectionHandlers: [
    new winston.transports.Console({
      stderrLevels: ['error', 'warn', 'info', 'verbose', 'debug', 'silly'],
    }),
  ],
});
