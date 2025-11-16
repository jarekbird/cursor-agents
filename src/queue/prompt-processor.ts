import { logger } from '../logger.js';
import { TaskOperatorService } from '../services/task-operator-service.js';
import type { QueueManager } from './queue-manager.js';

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
}

// Special job type for task operator
export interface TaskOperatorJobData {
  type: 'task_operator';
  agentName: string;
  queue?: string;
}

export class PromptProcessor {
  private queueManager?: QueueManager;
  private taskOperatorService: TaskOperatorService;

  constructor(queueManager?: QueueManager) {
    this.queueManager = queueManager;
    this.taskOperatorService = new TaskOperatorService();
  }

  async process(data: PromptJobData | AgentJobData | TaskOperatorJobData): Promise<void> {
    // Check if this is a task operator job
    if ('type' in data && data.type === 'task_operator') {
      await this.processTaskOperatorJob(data as TaskOperatorJobData);
    } else if ('targetUrl' in data) {
      // Agent job (HTTP request)
      await this.processAgentJob(data as AgentJobData);
    } else {
      // Prompt job
      await this.processPromptJob(data as PromptJobData);
    }
  }

  private async processAgentJob(data: AgentJobData): Promise<void> {
    const { agentName, targetUrl, method, headers = {}, body, timeout = 30000 } = data;
    const startTime = Date.now();

    // Check if this is a task operator internal job
    if (targetUrl === 'task-operator://internal') {
      // Extract task operator job data from body
      if (body && typeof body === 'object' && 'type' in body && body.type === 'task_operator') {
        const taskOperatorData = body as TaskOperatorJobData;
        await this.processTaskOperatorJob(taskOperatorData);
        return;
      }
    }

    // Log incoming request with full details
    logger.info('Agent job request received', {
      agentName,
      targetUrl,
      method,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      body: body ? (typeof body === 'string' ? body.substring(0, 500) : body) : undefined,
      timeout,
    });

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
   * Process task operator job
   * Checks system setting, processes next task, and re-enqueues if enabled
   */
  private async processTaskOperatorJob(data: TaskOperatorJobData): Promise<void> {
    const { agentName, queue } = data;

    logger.info('Task operator job started', { agentName });

    // Check if task operator is enabled at the start
    if (!this.taskOperatorService.isTaskOperatorEnabled()) {
      logger.info('Task operator is disabled, stopping immediately', { agentName });
      return;
    }

    // Process the next task
    const result = await this.taskOperatorService.processNextTask();

    if (result.processed && result.taskId) {
      logger.info('Task processed by task operator', {
        agentName,
        taskId: result.taskId,
      });
    } else {
      logger.info('No tasks to process', { agentName });
    }

    // CRITICAL: Check the system setting again before re-enqueueing
    // This ensures that if the setting was changed to false during processing,
    // we will stop re-enqueueing
    const isStillEnabled = this.taskOperatorService.isTaskOperatorEnabled();

    if (!isStillEnabled) {
      logger.info('Task operator setting is now false, stopping re-enqueueing', { agentName });
      return;
    }

    // Only re-enqueue if still enabled and queue manager is available
    if (this.queueManager) {
      const delay = 5000; // 5 second delay before checking again
      logger.info('Re-enqueueing task operator', { agentName, delay: `${delay}ms` });

      // Add a delayed one-time job to re-enqueue the task operator
      await this.queueManager.addOneTimeAgent(
        {
          name: agentName,
          targetUrl: `task-operator://internal`, // Special URL to identify task operator
          method: 'POST',
          body: { type: 'task_operator', agentName, queue },
          queue: queue || 'task-operator',
          timeout: 30000,
        },
        delay
      );
    } else {
      logger.warn('Queue manager not available, cannot re-enqueue task operator', { agentName });
    }
  }
}
