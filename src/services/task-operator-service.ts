import { logger } from '../logger.js';
import { DatabaseService } from './database-service.js';

/**
 * Service for the task operator agent
 * Handles checking system settings and processing tasks
 */
export class TaskOperatorService {
  private databaseService: DatabaseService;
  private readonly cursorRunnerUrl: string;

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
   * Process the next incomplete task
   * Returns true if a task was processed, false if no tasks available
   */
  async processNextTask(): Promise<{ processed: boolean; taskId?: number; prompt?: string }> {
    // Check if task operator is enabled
    if (!this.isTaskOperatorEnabled()) {
      logger.info('Task operator is disabled, skipping task processing');
      return { processed: false };
    }

    // Get next incomplete task
    const task = this.databaseService.getNextIncompleteTask();
    if (!task) {
      logger.info('No incomplete tasks found');
      return { processed: false };
    }

    logger.info('Processing task', {
      taskId: task.id,
      order: task.order,
      promptPreview: task.prompt.substring(0, 100) + '...',
    });

    try {
      // Send task to cursor-runner for processing
      const response = await fetch(`${this.cursorRunnerUrl}/cursor/iterate/async`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: task.prompt,
          // Note: We don't pass a callbackUrl here - the task operator will check again later
          // The task will be marked complete when cursor-runner finishes (or we can add a callback)
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error('Failed to send task to cursor-runner', {
          taskId: task.id,
          status: response.status,
          error: errorText,
        });
        return { processed: false, taskId: task.id, prompt: task.prompt };
      }

      const result = (await response.json()) as { requestId?: string };
      logger.info('Task sent to cursor-runner', {
        taskId: task.id,
        requestId: result.requestId,
      });

      // Note: We don't mark the task as complete here because cursor-runner processes asynchronously
      // The task will be marked complete via a callback or manual update
      // For now, we return the task info so the caller can handle completion

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
   * Mark a task as complete
   */
  markTaskComplete(taskId: number): boolean {
    return this.databaseService.markTaskComplete(taskId);
  }
}
