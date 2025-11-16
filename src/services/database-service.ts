import Database from 'better-sqlite3';
import { logger } from '../logger.js';

/**
 * Service for accessing the shared SQLite database
 * Used to read system settings and tasks
 */
export class DatabaseService {
  private db: Database.Database | null = null;
  private readonly dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath || process.env.SHARED_DB_PATH || '/app/shared_db/shared.sqlite3';
  }

  /**
   * Get database connection (lazy initialization)
   */
  private getDatabase(): Database.Database {
    if (!this.db) {
      try {
        this.db = new Database(this.dbPath, { readonly: false });
        // Enable WAL mode for better concurrency
        this.db.pragma('journal_mode = WAL');
        logger.info('Database connection established', { path: this.dbPath });
      } catch (error) {
        logger.error('Failed to connect to database', {
          path: this.dbPath,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }
    return this.db;
  }

  /**
   * Check if a system setting is enabled
   * This method reads fresh data from the database each time it's called
   * (no caching), ensuring we get the latest value even if it was changed
   * by another process.
   */
  isSystemSettingEnabled(settingName: string): boolean {
    try {
      const db = this.getDatabase();
      // Execute a fresh query each time to get the latest value
      // SQLite with WAL mode ensures we see committed writes from other processes
      const row = db
        .prepare('SELECT value FROM system_settings WHERE name = ?')
        .get(settingName) as { value: number } | undefined;

      // SQLite stores booleans as 0/1 integers
      // Returns false if setting doesn't exist (default behavior)
      return row?.value === 1;
    } catch (error) {
      logger.error('Failed to read system setting', {
        settingName,
        error: error instanceof Error ? error.message : String(error),
      });
      // Return false on error to be safe (fail closed)
      return false;
    }
  }

  /**
   * Set a system setting value
   */
  setSystemSetting(settingName: string, value: boolean): boolean {
    try {
      const db = this.getDatabase();
      // Use INSERT with ON CONFLICT to handle both insert and update
      // This preserves created_at on updates and sets it on inserts
      const stmt = db.prepare(
        `INSERT INTO system_settings (name, value, created_at, updated_at) 
         VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT(name) DO UPDATE SET 
           value = excluded.value,
           updated_at = CURRENT_TIMESTAMP`
      );
      stmt.run(settingName, value ? 1 : 0);
      logger.info('System setting updated', { settingName, value });
      return true;
    } catch (error) {
      logger.error('Failed to set system setting', {
        settingName,
        value,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Task status enum values
   * 0 = ready (ready to be processed)
   * 1 = complete (task completed)
   * 2 = archived (task archived)
   * 3 = backlogged (task in backlog)
   */
  static readonly STATUS_READY = 0;
  static readonly STATUS_COMPLETE = 1;
  static readonly STATUS_ARCHIVED = 2;
  static readonly STATUS_BACKLOGGED = 3;

  /**
   * Get the next ready task (lowest order)
   * Only returns tasks with status = 0 (ready)
   */
  getNextReadyTask(): {
    id: number;
    prompt: string;
    order: number;
    uuid: string;
    status: number;
  } | null {
    try {
      const db = this.getDatabase();
      const row = db
        .prepare(
          'SELECT id, prompt, "order", uuid, status FROM tasks WHERE status = 0 ORDER BY "order" ASC, id ASC LIMIT 1'
        )
        .get() as
        | { id: number; prompt: string; order: number; uuid: string; status: number }
        | undefined;

      return row || null;
    } catch (error) {
      logger.error('Failed to get next ready task', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Update task status
   * @param taskId - Task ID
   * @param status - New status (0=ready, 1=complete, 2=archived, 3=backlogged)
   */
  updateTaskStatus(taskId: number, status: number): boolean {
    try {
      const db = this.getDatabase();
      const result = db
        .prepare('UPDATE tasks SET status = ?, updatedat = CURRENT_TIMESTAMP WHERE id = ?')
        .run(status, taskId);
      return result.changes > 0;
    } catch (error) {
      logger.error('Failed to update task status', {
        taskId,
        status,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Mark a task as complete (status = 1)
   */
  markTaskComplete(taskId: number): boolean {
    return this.updateTaskStatus(taskId, DatabaseService.STATUS_COMPLETE);
  }

  /**
   * Close database connection
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      logger.info('Database connection closed');
    }
  }
}
