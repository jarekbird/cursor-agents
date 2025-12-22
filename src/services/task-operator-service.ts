import { Redis } from 'ioredis';
import { logger } from '../logger.js';
import { DatabaseService } from './database-service.js';

interface ProcessNextTaskResult {
  processed: boolean;
  taskId?: number;
  error?: string;
  reason?: 'lock_held' | 'no_tasks' | 'error'; // Reason why processing didn't happen
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

  // Singleton instance
  private static instance: TaskOperatorService | null = null;

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
   * Get the singleton instance of TaskOperatorService
   * This ensures all parts of the application share the same instance
   * and the same pendingTasks Map
   */
  static getInstance(redis?: Redis): TaskOperatorService {
    if (!TaskOperatorService.instance) {
      TaskOperatorService.instance = new TaskOperatorService(redis);
    }
    return TaskOperatorService.instance;
  }

  /**
   * Reset the singleton instance (mainly for testing)
   */
  static resetInstance(): void {
    TaskOperatorService.instance = null;
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

      // Don't specify queueType - let it default to 'default'
      // Each task should get its own conversation, and we'll pass the conversationId explicitly
      const response = await fetch(conversationUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ queueType: 'default' }),
      });

      const responseText = await response.text();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
      // Get lock details for logging
      const [lockValue, ttl] = await Promise.all([
        this.redis.get(this.LOCK_KEY).catch(() => null),
        this.redis.ttl(this.LOCK_KEY).catch(() => -1),
      ]);

      logger.info('Task operator skipping: Redis lock already held by another instance', {
        lockKey: this.LOCK_KEY,
        lockHolder: lockValue || 'unknown',
        ttlSeconds: ttl >= 0 ? ttl : 'unknown',
      });
      return { processed: false, reason: 'lock_held' };
    }

    logger.debug('Redis lock acquired', { lockValue: this.lockValue });

    try {
      // Get the next ready task
      const task = this.databaseService.getNextReadyTask();

      if (!task) {
        // No task available, release lock
        await this.releaseLock();
        return { processed: false, reason: 'no_tasks' };
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
      // Each task MUST have its own conversation to avoid context mixing
      let conversationId = await this.createNewConversation();
      if (!conversationId) {
        // Retry once if conversation creation failed
        logger.warn('Failed to create new conversation, retrying once', {
          taskId: task.id,
        });
        conversationId = await this.createNewConversation();
      }

      if (conversationId) {
        logger.info('Using new conversation for task', {
          taskId: task.id,
          conversationId,
        });
      } else {
        // If we still can't create a conversation, fail the task
        logger.error(
          'Failed to create new conversation after retry, marking task as ready for retry',
          {
            taskId: task.id,
          }
        );
        // Mark task as ready again so it can be retried
        this.databaseService.updateTaskStatus(task.id, 0);
        await this.releaseLock();
        return {
          processed: false,
          taskId: task.id,
          error: 'Failed to create new conversation for task',
          reason: 'error',
        };
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
      const targetUrl = `${cursorRunnerUrl}/cursor/execute/async`;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const requestBody: any = {
        prompt: task.prompt,
        repository: null, // Use default repositories directory
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

      // Include webhook secret in headers if available
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (webhookSecret) {
        headers['X-Webhook-Secret'] = webhookSecret;
      }

      const response = await fetch(targetUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
      });

      const responseText = await response.text();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
          reason: 'error',
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
        reason: 'error',
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
    }
  ): Promise<void> {
    const pendingTask = this.pendingTasks.get(requestId);

    if (!pendingTask) {
      logger.warn('Callback received for unknown requestId', {
        requestId,
        pendingTaskCount: this.pendingTasks.size,
        pendingRequestIds: Array.from(this.pendingTasks.keys()),
      });

      // Check if the lock is from a previous process instance
      // Lock format: "processId-timestamp-random"
      const lockValue = await this.redis.get(this.LOCK_KEY).catch(() => null);
      let shouldClearLock = false;

      if (lockValue) {
        const lockPid = lockValue.split('-')[0];
        const currentPid = String(process.pid);

        if (lockPid !== currentPid) {
          logger.info('Lock is from different process instance, clearing it', {
            requestId,
            lockPid,
            currentPid,
            lockValue,
          });
          shouldClearLock = true;
        } else if (this.pendingTasks.size === 0) {
          // Lock is from this process but no pending tasks - callback must be for cleaned up task
          logger.info('No pending tasks remaining, clearing lock after unknown callback', {
            requestId,
            lockValue,
          });
          shouldClearLock = true;
        }
      } else {
        // Lock doesn't exist, nothing to clear
        logger.info('Lock does not exist, nothing to clear', { requestId });
      }

      if (shouldClearLock) {
        await this.clearLock();
      } else {
        logger.info('Not clearing lock - pending tasks exist or lock is from current process', {
          requestId,
          pendingTaskCount: this.pendingTasks.size,
          lockExists: !!lockValue,
        });
      }
      return;
    }

    const { taskId } = pendingTask;

    try {
      // Log the full callback result for debugging
      logger.info('Processing callback for pending task', {
        taskId,
        requestId,
        success: result.success,
        successType: typeof result.success,
        hasError: !!result.error,
        hasOutput: !!result.output,
        fullResult: JSON.stringify(result),
      });

      // Check if task completed successfully
      // Note: cursor-runner can send success: true even with an error field (warnings/non-fatal errors)
      // So we check success === true explicitly, not just success !== false
      // Also handle string "true" as a fallback (shouldn't happen but be defensive)
      const isSuccess =
        result.success === true ||
        (typeof result.success === 'string' && result.success === 'true');

      if (isSuccess) {
        // Task completed successfully
        const marked = this.databaseService.markTaskComplete(taskId);
        if (marked) {
          logger.info('Task marked as complete after callback', {
            taskId,
            requestId,
            hasErrorField: !!result.error, // Log if error field was present but task still succeeded
          });
        } else {
          logger.error('Failed to mark task as complete - database update returned false', {
            taskId,
            requestId,
          });
        }
      } else {
        // Task failed (success is false or undefined)
        const errorMessage = result.error || 'Unknown error';
        logger.error('Task execution failed', {
          taskId,
          requestId,
          error: errorMessage,
          success: result.success,
          successType: typeof result.success,
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
   * Forcefully clear the Redis lock (for administrative use)
   * This deletes the lock regardless of who owns it
   * Use with caution - only when you need to clear a stale lock
   */
  async clearLock(): Promise<boolean> {
    try {
      const deleted = await this.redis.del(this.LOCK_KEY);
      if (deleted === 1) {
        logger.info('Redis lock forcefully cleared', { lockKey: this.LOCK_KEY });
        return true;
      } else {
        logger.info('Redis lock does not exist (already cleared)', { lockKey: this.LOCK_KEY });
        return false;
      }
    } catch (error) {
      logger.error('Error clearing Redis lock', {
        error: error instanceof Error ? error.message : String(error),
        lockKey: this.LOCK_KEY,
      });
      throw error;
    }
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
   * Only resets tasks that are actually still in_progress (status 4) in the database
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
          // Check the actual database status before resetting
          // Only reset if the task is still in_progress (status 4)
          // If it's already complete (status 1), don't reset it
          try {
            const taskStatus = this.databaseService.getTaskStatus(pendingTask.taskId);

            if (taskStatus === DatabaseService.STATUS_IN_PROGRESS) {
              // Task is still in_progress, so it's truly stale - reset to ready
              this.databaseService.updateTaskStatus(pendingTask.taskId, 0);
              logger.warn('Stale task cleaned up and marked for retry', {
                taskId: pendingTask.taskId,
                requestId,
                age: `${Math.round((now - pendingTask.timestamp) / 1000)}s`,
                previousStatus: taskStatus,
              });
            } else {
              // Task is already complete or in another state - don't reset it
              logger.info('Skipping stale task cleanup - task already in final state', {
                taskId: pendingTask.taskId,
                requestId,
                currentStatus: taskStatus,
                age: `${Math.round((now - pendingTask.timestamp) / 1000)}s`,
              });
            }
          } catch (error) {
            logger.error('Error checking task status during stale cleanup', {
              taskId: pendingTask.taskId,
              requestId,
              error: error instanceof Error ? error.message : String(error),
            });
            // On error, still reset to ready to be safe (but log the error)
            this.databaseService.updateTaskStatus(pendingTask.taskId, 0);
          }

          this.pendingTasks.delete(requestId);
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
