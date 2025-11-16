import { logger } from '../logger.js';
import { DatabaseService } from './database-service.js';

/**
 * Service for the task operator agent
 * Handles checking system settings and processing tasks
 */
export class TaskOperatorService {
  private databaseService: DatabaseService;
  private readonly cursorRunnerUrl: string;

  // Task status enum values (matching DatabaseService)
  static readonly STATUS_READY = DatabaseService.STATUS_READY;
  static readonly STATUS_COMPLETE = DatabaseService.STATUS_COMPLETE;
  static readonly STATUS_ARCHIVED = DatabaseService.STATUS_ARCHIVED;
  static readonly STATUS_BACKLOGGED = DatabaseService.STATUS_BACKLOGGED;

  constructor(databaseService?: DatabaseService) {
    this.databaseService = databaseService || new DatabaseService();
    this.cursorRunnerUrl = process.env.CURSOR_RUNNER_URL || 'http://cursor-runner:3001';
  }

  /**
   * Check if task operator is enabled
   */
  isTaskOperatorEnabled(): boolean {
    return this.databaseService.isSystemSettingEnabled('task_operator');
  }

  /**
   * Process the next ready task (status = 0)
   * Returns true if a task was processed, false if no tasks available
   */
  async processNextTask(): Promise<{ processed: boolean; taskId?: number; prompt?: string }> {
    // Check if task operator is enabled
    if (!this.isTaskOperatorEnabled()) {
      logger.info('Task operator is disabled, skipping task processing');
      return { processed: false };
    }

    // Get next ready task (status = 0)
    const task = this.databaseService.getNextReadyTask();
    if (!task) {
      logger.info('No ready tasks found');
      return { processed: false };
    }

    logger.info('Processing task', {
      taskId: task.id,
      order: task.order,
      promptPreview: task.prompt.substring(0, 100) + '...',
    });

    try {
      // Send task to cursor-runner for processing (synchronous - waits for completion)
      const response = await fetch(`${this.cursorRunnerUrl}/cursor/iterate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: task.prompt,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error('Failed to process task in cursor-runner', {
          taskId: task.id,
          status: response.status,
          error: errorText,
        });
        return { processed: false, taskId: task.id, prompt: task.prompt };
      }

      const result = (await response.json()) as { success?: boolean; requestId?: string };
      logger.info('Task processed by cursor-runner', {
        taskId: task.id,
        requestId: result.requestId,
        success: result.success,
      });

      // Mark task as complete if the response indicates success
      if (result.success === true) {
        this.markTaskComplete(task.id);
        logger.info('Task marked as complete', { taskId: task.id });
      } else {
        logger.warn('Task not marked as complete - response indicated failure', {
          taskId: task.id,
          success: result.success,
        });
      }

      return { processed: true, taskId: task.id, prompt: task.prompt };
    } catch (error) {
      logger.error('Error processing task', {
        taskId: task.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return { processed: false, taskId: task.id, prompt: task.prompt };
    }
  }

  /**
   * Update task status
   */
  updateTaskStatus(taskId: number, status: number): boolean {
    return this.databaseService.updateTaskStatus(taskId, status);
  }

  /**
   * Mark a task as complete (status = 1)
   */
  markTaskComplete(taskId: number): boolean {
    return this.databaseService.markTaskComplete(taskId);
  }
}
