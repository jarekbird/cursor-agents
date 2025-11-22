import { logger } from '../logger.js';
import type { QueueManager } from './queue-manager.js';
import { TaskOperatorService } from '../services/task-operator-service.js';

export interface PromptJobData {
  prompt: string;
  options?: {
    repository?: string;
    branch?: string;
    maxIterations?: number;
    [key: string]: unknown;
  };
}

export interface AgentJobData {
  agentName: string; // Track which agent this job belongs to
  targetUrl: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  headers?: Record<string, string>;
  body?: unknown;
  timeout?: number;
  queue?: string; // Queue name for re-enqueueing
}

// Response format for conditional re-enqueueing
export interface RequeueResponse {
  requeue?: boolean; // If true, re-enqueue the agent
  delay?: number; // Delay in milliseconds before re-enqueueing (default: 0)
  condition?: string; // Optional description of why it's being re-enqueued
  [key: string]: unknown; // Allow other response fields
}

export class PromptProcessor {
  private queueManager?: QueueManager;
  private taskOperatorService: TaskOperatorService;

  constructor(queueManager?: QueueManager) {
    this.queueManager = queueManager;
    this.taskOperatorService = new TaskOperatorService();
  }

  async process(data: PromptJobData | AgentJobData): Promise<void> {
    // Check if this is an agent job (HTTP request) or a prompt job
    if ('targetUrl' in data) {
      await this.processAgentJob(data as AgentJobData);
    } else {
      await this.processPromptJob(data as PromptJobData);
    }
  }

  private async processAgentJob(data: AgentJobData): Promise<void> {
    const { agentName, targetUrl, method, headers = {}, body, timeout = 30000 } = data;
    const startTime = Date.now();

    // Log incoming request with full details
    logger.info('Agent job request received', {
      agentName,
      targetUrl,
      method,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      body: body ? (typeof body === 'string' ? body.substring(0, 500) : body) : undefined,
      timeout,
    });

    // Handle special internal task operator protocol
    if (targetUrl === 'task-operator://internal') {
      await this.processTaskOperatorJob(data);
      return;
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      const fetchOptions: RequestInit = {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
        signal: controller.signal,
      };

      if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
        fetchOptions.body = JSON.stringify(body);
      }

      logger.info('Sending HTTP request', {
        targetUrl,
        method,
        hasBody: !!fetchOptions.body,
        bodyLength:
          fetchOptions.body && typeof fetchOptions.body === 'string' ? fetchOptions.body.length : 0,
      });

      const response = await fetch(targetUrl, fetchOptions);
      clearTimeout(timeoutId);

      const duration = Date.now() - startTime;
      const responseText = await response.text();
      let responseBody: unknown;
      try {
        responseBody = JSON.parse(responseText);
      } catch {
        responseBody = responseText;
      }

      if (!response.ok) {
        logger.warn('Agent job request failed', {
          targetUrl,
          method,
          status: response.status,
          statusText: response.statusText,
          duration: `${duration}ms`,
          response: responseBody,
        });
        throw new Error(
          `HTTP ${response.status} ${response.statusText}: ${JSON.stringify(responseBody)}`
        );
      }

      logger.info('Agent job completed successfully', {
        targetUrl,
        method,
        status: response.status,
        duration: `${duration}ms`,
        response: responseBody,
      });

      // Check if response indicates we should re-enqueue
      if (this.queueManager && typeof responseBody === 'object' && responseBody !== null) {
        const requeueResponse = responseBody as RequeueResponse;
        if (requeueResponse.requeue === true) {
          const delay = requeueResponse.delay || 0;
          logger.info('Agent requested re-enqueue', {
            agentName,
            delay,
            condition: requeueResponse.condition,
          });

          // Re-enqueue the agent with optional delay
          await this.queueManager.addDelayedAgent({
            name: agentName,
            targetUrl,
            method,
            headers,
            body,
            timeout,
            queue: data.queue,
            delay,
          });
        }
      }
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Agent job failed', {
        targetUrl,
        method,
        duration: `${duration}ms`,
        error: errorMessage,
      });
      throw error;
    }
  }

  private async processPromptJob(data: PromptJobData): Promise<void> {
    const { prompt, options } = data;

    logger.info('Processing prompt', {
      prompt: prompt.substring(0, 100) + '...',
      options,
    });

    // For prompt jobs, we can optionally call cursor-runner API
    const cursorRunnerUrl = process.env.CURSOR_RUNNER_URL || 'http://cursor-runner:3001';

    try {
      // Use synchronous endpoint since we're already in an async worker context
      const response = await fetch(`${cursorRunnerUrl}/cursor/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          repository: options?.repository,
          branchName: options?.branch || 'main',
        }),
      });

      if (!response.ok) {
        throw new Error(`Cursor runner returned ${response.status}`);
      }

      logger.info('Prompt processed successfully via cursor-runner', {
        prompt: prompt.substring(0, 100) + '...',
      });
    } catch (error) {
      logger.warn('Failed to process prompt via cursor-runner, logging only', {
        error: error instanceof Error ? error.message : String(error),
      });
      // Fallback: just log the processing
      logger.info('Prompt processed (logged only)', {
        prompt: prompt.substring(0, 100) + '...',
      });
    }
  }

  /**
   * Process task operator internal job
   * This handles the special task-operator://internal protocol
   */
  private async processTaskOperatorJob(data: AgentJobData): Promise<void> {
    const { agentName, queue } = data;
    const startTime = Date.now();

    logger.info('Processing task operator job', { agentName, queue });

    try {
      // Check if task operator is enabled
      if (!this.taskOperatorService.isTaskOperatorEnabled()) {
        logger.info('Task operator is disabled, not processing tasks', { agentName });
        return;
      }

      // Process the next task
      const result = await this.taskOperatorService.processNextTask();

      const duration = Date.now() - startTime;

      if (result.processed) {
        logger.info('Task operator processed task successfully', {
          taskId: result.taskId,
          duration: `${duration}ms`,
        });

        // Re-enqueue task operator if it's still enabled (to process next task)
        // Use a small delay (5 seconds) to avoid tight loops
        if (this.queueManager && this.taskOperatorService.isTaskOperatorEnabled()) {
          const delay = 5000; // 5 seconds delay between task processing
          logger.info('Re-enqueueing task operator to process next task', {
            agentName,
            delay,
          });

          const result = await this.queueManager.addDelayedAgent({
            name: agentName,
            targetUrl: 'task-operator://internal',
            method: 'POST',
            body: data.body,
            queue: queue || 'task-operator',
            timeout: 30000,
            delay,
          });

          if (!result) {
            logger.warn('Task operator re-enqueue skipped: job already exists (waiting/delayed)', {
              agentName,
              queue: queue || 'task-operator',
            });
          } else {
            logger.info('Task operator re-enqueued successfully', {
              agentName,
              jobId: result.id,
              delay,
            });
          }
        }
      } else {
        // No task was processed - check the reason
        if (result.reason === 'lock_held') {
          logger.info('Task operator skipped: lock held by another instance', {
            duration: `${duration}ms`,
          });
        } else {
          logger.info('No ready tasks to process', {
            duration: `${duration}ms`,
            reason: result.reason || 'unknown',
          });
        }

        // Re-enqueue with a longer delay if task operator is still enabled
        // This allows time for new tasks to be added
        if (this.queueManager && this.taskOperatorService.isTaskOperatorEnabled()) {
          const delay = 5000; // 5 seconds delay before checking again
          logger.info('Re-enqueueing task operator to check for new tasks', {
            agentName,
            delay,
          });

          const result = await this.queueManager.addDelayedAgent({
            name: agentName,
            targetUrl: 'task-operator://internal',
            method: 'POST',
            body: data.body,
            queue: queue || 'task-operator',
            timeout: 30000,
            delay,
          });

          if (!result) {
            logger.warn('Task operator re-enqueue skipped: job already exists (waiting/delayed)', {
              agentName,
              queue: queue || 'task-operator',
            });
          } else {
            logger.info('Task operator re-enqueued successfully', {
              agentName,
              jobId: result.id,
              delay,
            });
          }
        }
      }
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Task operator job failed', {
        agentName,
        duration: `${duration}ms`,
        error: errorMessage,
      });

      // Re-enqueue with delay even on error if task operator is still enabled
      if (this.queueManager && this.taskOperatorService.isTaskOperatorEnabled()) {
        const delay = 10000; // 10 seconds delay on error
        logger.info('Re-enqueueing task operator after error', {
          agentName,
          delay,
          error: errorMessage,
        });

        const result = await this.queueManager.addDelayedAgent({
          name: agentName,
          targetUrl: 'task-operator://internal',
          method: 'POST',
          body: data.body,
          queue: queue || 'task-operator',
          timeout: 30000,
          delay,
        });

        if (!result) {
          logger.warn('Task operator re-enqueue skipped: job already exists (waiting/delayed)', {
            agentName,
            queue: queue || 'task-operator',
          });
        } else {
          logger.info('Task operator re-enqueued successfully after error', {
            agentName,
            jobId: result.id,
            delay,
          });
        }
      }

      // Don't throw - we want to re-enqueue even on errors
    }
  }
}
