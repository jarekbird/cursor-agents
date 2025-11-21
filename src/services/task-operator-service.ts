import { logger } from '../logger.js';
import { DatabaseService } from './database-service.js';

interface ProcessNextTaskResult {
  processed: boolean;
  taskId?: number;
  error?: string;
}

interface PendingTask {
  taskId: number;
  requestId: string;
  timestamp: number;
}

/**
 * Service for processing tasks from the database
 * Sends tasks to cursor-runner for execution
 */
export class TaskOperatorService {
  private databaseService: DatabaseService;
  private processingLock = false; // Mutex to ensure only one task processes at a time
  private pendingTasks = new Map<string, PendingTask>(); // requestId -> PendingTask

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
   * Create a new conversation in cursor-runner
   * Returns the conversation ID or null if creation failed
   */
  private async createNewConversation(): Promise<string | null> {
    try {
      const cursorRunnerUrl = process.env.CURSOR_RUNNER_URL || 'http://cursor-runner:3001';
      const conversationUrl = `${cursorRunnerUrl}/cursor/conversation/new`;

      logger.info('Creating new conversation for task', { url: conversationUrl });

      const response = await fetch(conversationUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      const responseText = await response.text();
      let responseData: any;

      try {
        responseData = JSON.parse(responseText);
      } catch {
        logger.error('Failed to parse conversation creation response', {
          response: responseText.substring(0, 500),
        });
        return null;
      }

      if (!response.ok || !responseData.success) {
        logger.error('Failed to create new conversation', {
          status: response.status,
          response: responseData,
        });
        return null;
      }

      logger.info('New conversation created', {
        conversationId: responseData.conversationId,
      });

      return responseData.conversationId || null;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Error creating new conversation', { error: errorMessage });
      return null;
    }
  }

  /**
   * Process the next ready task from the database
   * Sends it to cursor-runner for execution (async with callback)
   * Only processes one task at a time (mutex lock)
   */
  async processNextTask(): Promise<ProcessNextTaskResult> {
    // Check if already processing (mutex lock)
    if (this.processingLock) {
      logger.debug('Task operator is already processing a task, skipping');
      return { processed: false };
    }

    try {
      // Acquire lock
      this.processingLock = true;

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

      // Mark task as in_progress (status = 4)
      const markedInProgress = this.databaseService.updateTaskStatus(
        task.id,
        DatabaseService.STATUS_IN_PROGRESS
      );
      if (!markedInProgress) {
        logger.warn('Failed to mark task as in_progress', { taskId: task.id });
      }

      // Create a new conversation for this task
      const conversationId = await this.createNewConversation();
      if (conversationId) {
        logger.info('Using new conversation for task', {
          taskId: task.id,
          conversationId,
        });
      } else {
        logger.warn('Failed to create new conversation, continuing with task anyway', {
          taskId: task.id,
        });
      }

      // Generate request ID for tracking
      const requestId = `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

      // Store pending task
      this.pendingTasks.set(requestId, {
        taskId: task.id,
        requestId,
        timestamp: Date.now(),
      });

      // Build callback URL (include webhook secret if configured)
      const cursorAgentsUrl = process.env.CURSOR_AGENTS_URL || 'http://cursor-agents:3002';
      let callbackUrl = `${cursorAgentsUrl}/task-operator/callback`;
      const webhookSecret = process.env.WEBHOOK_SECRET;
      if (webhookSecret) {
        callbackUrl = `${callbackUrl}?secret=${encodeURIComponent(webhookSecret)}`;
      }

      // Send task to cursor-runner (async - callback will handle completion)
      const cursorRunnerUrl = process.env.CURSOR_RUNNER_URL || 'http://cursor-runner:3001';
      const targetUrl = `${cursorRunnerUrl}/cursor/iterate/async`;

      const requestBody: any = {
        prompt: task.prompt,
        repository: null, // Use default repositories directory
        maxIterations: 25,
        callbackUrl,
        id: requestId, // Include requestId in body
      };

      // Include conversationId if we successfully created a new conversation
      if (conversationId) {
        requestBody.conversationId = conversationId;
      }

      logger.info('Sending task to cursor-runner (async)', {
        taskId: task.id,
        requestId,
        callbackUrl,
      });

      const response = await fetch(targetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      const responseText = await response.text();
      let responseData: any;

      try {
        responseData = JSON.parse(responseText);
      } catch {
        // If response is not JSON, treat as error
        responseData = { error: responseText };
      }

      if (!response.ok) {
        // Remove pending task on error
        this.pendingTasks.delete(requestId);

        // Mark task as ready again (status = 0) so it can be retried
        this.databaseService.updateTaskStatus(task.id, 0);

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

      logger.info('Task sent to cursor-runner successfully, waiting for callback', {
        taskId: task.id,
        requestId,
        response: responseData,
      });

      // Task is now being processed asynchronously
      // Callback will handle marking it complete or failed
      // Release lock immediately since we're not waiting for completion
      this.processingLock = false;

      return {
        processed: true,
        taskId: task.id,
      };
    } catch (error) {
      logger.error('Failed to process next task', {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        processed: false,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      // Release lock in case of any error
      this.processingLock = false;
    }
  }

  /**
   * Handle callback from cursor-runner when task execution completes
   * @param requestId - Request ID from cursor-runner
   * @param result - Callback result (success/error)
   */
  async handleCallback(
    requestId: string,
    result: {
      success?: boolean;
      error?: string;
      output?: string;
      iterations?: number;
      maxIterations?: number;
    }
  ): Promise<void> {
    const pendingTask = this.pendingTasks.get(requestId);

    if (!pendingTask) {
      logger.warn('Callback received for unknown requestId', { requestId });
      return;
    }

    const { taskId } = pendingTask;

    try {
      if (result.success !== false && !result.error) {
        // Task completed successfully
        const marked = this.databaseService.markTaskComplete(taskId);
        if (marked) {
          logger.info('Task marked as complete after callback', {
            taskId,
            requestId,
            iterations: result.iterations,
          });
        } else {
          logger.warn('Failed to mark task as complete', { taskId, requestId });
        }
      } else {
        // Task failed
        const errorMessage = result.error || 'Unknown error';
        logger.error('Task execution failed', {
          taskId,
          requestId,
          error: errorMessage,
        });

        // Mark task as ready again (status = 0) so it can be retried
        // Or you could mark it as backlogged (status = 3) if you don't want automatic retries
        this.databaseService.updateTaskStatus(taskId, 0);
      }
    } finally {
      // Remove pending task
      this.pendingTasks.delete(requestId);
    }
  }

  /**
   * Check if task operator is currently processing a task
   */
  isProcessing(): boolean {
    return this.processingLock;
  }

  /**
   * Get count of pending tasks waiting for callbacks
   */
  getPendingTaskCount(): number {
    return this.pendingTasks.size;
  }
}
