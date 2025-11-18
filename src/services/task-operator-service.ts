import { logger } from '../logger.js';
import { DatabaseService } from './database-service.js';

interface ProcessNextTaskResult {
  processed: boolean;
  taskId?: number;
  error?: string;
}

/**
 * Service for processing tasks from the database
 * Sends tasks to cursor-runner for execution
 */
export class TaskOperatorService {
  private databaseService: DatabaseService;
  private consecutiveResourceExhaustedErrors = 0;

  constructor() {
    this.databaseService = new DatabaseService();
  }

  /**
   * Check if task operator is enabled
   */
  isTaskOperatorEnabled(): boolean {
    return this.databaseService.isSystemSettingEnabled('task_operator');
  }

  /**
   * Helper function for exponential backoff delay
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Helper function to check for resource_exhausted errors
   */
  private isResourceExhausted(output: string): boolean {
    return (
      output.includes('resource_exhausted') || output.includes('ConnectError: [resource_exhausted]')
    );
  }

  /**
   * Helper function to calculate exponential backoff delay
   */
  private getBackoffDelay(attempt: number): number {
    // Exponential backoff: 2^attempt seconds, capped at 60 seconds
    const baseDelay = 1000; // 1 second in milliseconds
    const maxDelay = 60000; // 60 seconds max
    const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
    // Add jitter: random 0-25% of delay to prevent thundering herd
    const jitter = Math.random() * 0.25 * delay;
    return Math.floor(delay + jitter);
  }

  /**
   * Process the next ready task from the database
   * Sends it to cursor-runner for execution
   */
  async processNextTask(): Promise<ProcessNextTaskResult> {
    try {
      // Get the next ready task
      const task = this.databaseService.getNextReadyTask();

      if (!task) {
        return { processed: false };
      }

      logger.info('Processing task', {
        taskId: task.id,
        uuid: task.uuid,
        order: task.order,
      });

      // Send task to cursor-runner
      const cursorRunnerUrl = process.env.CURSOR_RUNNER_URL || 'http://cursor-runner:3001';
      const targetUrl = `${cursorRunnerUrl}/cursor/iterate/async`;

      let retryAttempt = 0;
      const maxRetries = 5;

      while (retryAttempt <= maxRetries) {
        try {
          const response = await fetch(targetUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              prompt: task.prompt,
              repository: null, // Use default repositories directory
              maxIterations: 25,
            }),
          });

          const responseText = await response.text();
          let responseData: any;

          try {
            responseData = JSON.parse(responseText);
          } catch {
            // If response is not JSON, treat as error
            responseData = { error: responseText };
          }

          // Check for resource_exhausted errors
          const hasResourceExhausted =
            !response.ok &&
            (this.isResourceExhausted(responseText) ||
              this.isResourceExhausted(JSON.stringify(responseData)));

          if (hasResourceExhausted) {
            this.consecutiveResourceExhaustedErrors++;
            const backoffDelay = this.getBackoffDelay(this.consecutiveResourceExhaustedErrors - 1);

            logger.warn(
              'Resource exhausted error from cursor-runner, applying exponential backoff',
              {
                taskId: task.id,
                retryAttempt,
                consecutiveErrors: this.consecutiveResourceExhaustedErrors,
                backoffDelayMs: backoffDelay,
              }
            );

            // If we've exceeded max retries, return error
            if (retryAttempt >= maxRetries) {
              logger.error('Max retries exceeded for resource_exhausted error', {
                taskId: task.id,
                retryAttempt,
              });
              return {
                processed: false,
                taskId: task.id,
                error: 'Resource exhausted: max retries exceeded',
              };
            }

            // Apply exponential backoff before retrying
            await this.sleep(backoffDelay);
            retryAttempt++;
            continue;
          }

          // Reset consecutive errors on success
          if (response.ok) {
            this.consecutiveResourceExhaustedErrors = 0;
          }

          if (!response.ok) {
            logger.error('Failed to send task to cursor-runner', {
              taskId: task.id,
              status: response.status,
              statusText: response.statusText,
              response: responseText.substring(0, 500),
            });
            return {
              processed: false,
              taskId: task.id,
              error: `Cursor runner returned ${response.status}: ${responseText.substring(0, 200)}`,
            };
          }

          // Task sent successfully
          logger.info('Task sent to cursor-runner successfully', {
            taskId: task.id,
            uuid: task.uuid,
            response: responseData,
          });

          return {
            processed: true,
            taskId: task.id,
          };
        } catch (fetchError) {
          const errorMessage =
            fetchError instanceof Error ? fetchError.message : String(fetchError);

          // Check if this is a connection error that might indicate resource exhaustion
          const isConnectionError =
            errorMessage.includes('ECONNREFUSED') ||
            errorMessage.includes('ETIMEDOUT') ||
            errorMessage.includes('ENOTFOUND') ||
            errorMessage.includes('fetch failed');

          if (isConnectionError && retryAttempt < maxRetries) {
            this.consecutiveResourceExhaustedErrors++;
            const backoffDelay = this.getBackoffDelay(this.consecutiveResourceExhaustedErrors - 1);

            logger.warn('Connection error from cursor-runner, applying exponential backoff', {
              taskId: task.id,
              retryAttempt,
              error: errorMessage,
              consecutiveErrors: this.consecutiveResourceExhaustedErrors,
              backoffDelayMs: backoffDelay,
            });

            await this.sleep(backoffDelay);
            retryAttempt++;
            continue;
          }

          logger.error('Failed to send task to cursor-runner', {
            taskId: task.id,
            error: errorMessage,
            retryAttempt,
          });

          return {
            processed: false,
            taskId: task.id,
            error: errorMessage,
          };
        }
      }

      // If we get here, we've exhausted retries
      return {
        processed: false,
        taskId: task.id,
        error: 'Max retries exceeded',
      };
    } catch (error) {
      logger.error('Failed to process next task', {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        processed: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
