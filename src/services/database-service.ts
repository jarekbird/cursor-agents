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
      // Use INSERT OR REPLACE to handle both insert and update
      const stmt = db.prepare(
        'INSERT OR REPLACE INTO system_settings (name, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)'
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
   * Get the next incomplete task (lowest order)
   */
  getNextIncompleteTask(): { id: number; prompt: string; order: number; uuid: string } | null {
    try {
      const db = this.getDatabase();
      const row = db
        .prepare(
          'SELECT id, prompt, "order", uuid FROM tasks WHERE complete = 0 ORDER BY "order" ASC, id ASC LIMIT 1'
        )
        .get() as { id: number; prompt: string; order: number; uuid: string } | undefined;

      return row || null;
    } catch (error) {
      logger.error('Failed to get next incomplete task', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Mark a task as complete
   */
  markTaskComplete(taskId: number): boolean {
    try {
      const db = this.getDatabase();
      const result = db.prepare('UPDATE tasks SET complete = 1 WHERE id = ?').run(taskId);
      return result.changes > 0;
    } catch (error) {
      logger.error('Failed to mark task as complete', {
        taskId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
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
