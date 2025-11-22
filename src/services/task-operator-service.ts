import { Redis } from 'ioredis';
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
  private redis: Redis;
  private pendingTasks = new Map<string, PendingTask>(); // requestId -> PendingTask
  private readonly TASK_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour timeout for tasks
  private readonly LOCK_KEY = 'task_operator:lock'; // Redis lock key
  private readonly LOCK_TTL_SECONDS = 3600; // 1 hour lock TTL (auto-expires if process crashes)
  private readonly lockValue: string; // Unique value for this instance to ensure we only release our own lock

  constructor(redis?: Redis) {
    this.databaseService = new DatabaseService();
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379/0';
    this.redis =
      redis ||
      new Redis(redisUrl, {
        maxRetriesPerRequest: null, // Required by BullMQ - BullMQ manages its own retry logic
      });
    // Generate unique lock value for this instance (process ID + timestamp)
    this.lockValue = `${process.pid}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
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
   * Only processes one task at a time (Redis-based distributed lock)
   */
  async processNextTask(): Promise<ProcessNextTaskResult> {
    // Clean up any stale pending tasks before checking lock
    await this.cleanupStaleTasks();

    // Try to acquire Redis lock (atomic operation: SET key value NX EX ttl)
    // NX = only set if not exists, EX = set expiration in seconds
    const lockAcquired = await this.redis.set(
      this.LOCK_KEY,
      this.lockValue,
      'EX',
      this.LOCK_TTL_SECONDS,
      'NX'
    );

    if (lockAcquired !== 'OK') {
      logger.info('Task operator skipping: Redis lock already held by another instance', {
        lockKey: this.LOCK_KEY,
      });
      return { processed: false };
    }

    logger.debug('Redis lock acquired', { lockValue: this.lockValue });

    try {
      // Get the next ready task
      const task = this.databaseService.getNextReadyTask();

      if (!task) {
        // No task available, release lock
        await this.releaseLock();
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

        // Release lock on error (failed to send request)
        await this.releaseLock();

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
      // DO NOT release lock here - keep it locked until callback arrives
      // The Redis lock will be released in handleCallback() after processing completes
      // Note: Lock has TTL so it will auto-expire if process crashes

      return {
        processed: true,
        taskId: task.id,
      };
    } catch (error) {
      logger.error('Failed to process next task', {
        error: error instanceof Error ? error.message : String(error),
      });
      // Release lock on error (before sending request failed)
      await this.releaseLock();
      return {
        processed: false,
        error: error instanceof Error ? error.message : String(error),
      };
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
      // Release Redis lock after callback is processed - this allows the next task to start
      await this.releaseLock();
      logger.info('Lock released after callback processing', {
        taskId,
        requestId,
        pendingTasksRemaining: this.pendingTasks.size,
      });
    }
  }

  /**
   * Check if task operator is currently processing a task
   * Uses Redis lock to check across all instances
   */
  async isProcessing(): Promise<boolean> {
    const exists = await this.redis.exists(this.LOCK_KEY);
    return exists === 1;
  }

  /**
   * Release the Redis lock atomically
   * Only releases if the lock value matches (ensures we only release our own lock)
   */
  private async releaseLock(): Promise<void> {
    try {
      // Use Lua script for atomic check-and-delete
      // This ensures we only delete the lock if we own it
      const script = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("del", KEYS[1])
        else
          return 0
        end
      `;
      const result = await this.redis.eval(script, 1, this.LOCK_KEY, this.lockValue);
      if (result === 1) {
        logger.debug('Redis lock released successfully', { lockValue: this.lockValue });
      } else {
        logger.warn('Failed to release Redis lock - lock value mismatch or lock already expired', {
          lockValue: this.lockValue,
        });
      }
    } catch (error) {
      logger.error('Error releasing Redis lock', {
        error: error instanceof Error ? error.message : String(error),
        lockValue: this.lockValue,
      });
    }
  }

  /**
   * Get count of pending tasks waiting for callbacks
   */
  getPendingTaskCount(): number {
    return this.pendingTasks.size;
  }

  /**
   * Clean up stale pending tasks that have exceeded the timeout
   * This prevents the lock from being held forever if a callback never arrives
   */
  private async cleanupStaleTasks(): Promise<void> {
    const now = Date.now();
    const staleTasks: string[] = [];

    for (const [requestId, pendingTask] of this.pendingTasks.entries()) {
      const age = now - pendingTask.timestamp;
      if (age > this.TASK_TIMEOUT_MS) {
        staleTasks.push(requestId);
      }
    }

    if (staleTasks.length > 0) {
      logger.warn('Cleaning up stale pending tasks', {
        count: staleTasks.length,
        requestIds: staleTasks,
      });

      for (const requestId of staleTasks) {
        const pendingTask = this.pendingTasks.get(requestId);
        if (pendingTask) {
          // Mark task as ready again (status = 0) so it can be retried
          this.databaseService.updateTaskStatus(pendingTask.taskId, 0);
          this.pendingTasks.delete(requestId);

          logger.warn('Stale task cleaned up and marked for retry', {
            taskId: pendingTask.taskId,
            requestId,
            age: `${Math.round((now - pendingTask.timestamp) / 1000)}s`,
          });
        }
      }

      // If we cleaned up all pending tasks and lock is still held, release it
      if (this.pendingTasks.size === 0) {
        const lockExists = await this.redis.exists(this.LOCK_KEY);
        if (lockExists === 1) {
          logger.warn('Releasing stale processing lock after cleaning up all pending tasks');
          await this.releaseLock();
        }
      }
    }
  }
}
