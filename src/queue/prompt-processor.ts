import { logger } from '../logger.js';

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

export class PromptProcessor {
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
}
