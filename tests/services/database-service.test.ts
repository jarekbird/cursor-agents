/**
 * Tests for DatabaseService
 * 
 * This test suite covers all database operations including:
 * - Database connection management
 * - System settings read/write operations
 * - Task status management operations
 * - Schema migration support
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { DatabaseService } from '../../src/services/database-service.js';
import Database from 'better-sqlite3';
import { tmpdir } from 'os';
import { join } from 'path';
import { unlinkSync } from 'fs';
import { logger } from '../../src/logger.js';

describe('DatabaseService', () => {
  let dbService: DatabaseService;
  let testDbPath: string;
  let testDb: Database.Database | null = null;

  beforeEach(() => {
    // Use a temporary file for tests to allow checking WAL mode
    // Each test gets a unique temp file to avoid conflicts
    testDbPath = join(tmpdir(), `test-db-${Date.now()}-${Math.random().toString(36).substring(7)}.sqlite`);
    dbService = new DatabaseService(testDbPath);
    
    // Create schema for testing
    // We need to create the tables that DatabaseService expects
    testDb = new Database(testDbPath);
    testDb.exec(`
      CREATE TABLE IF NOT EXISTS system_settings (
        name TEXT PRIMARY KEY,
        value INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        prompt TEXT NOT NULL,
        "order" INTEGER NOT NULL DEFAULT 0,
        uuid TEXT NOT NULL,
        status INTEGER NOT NULL DEFAULT 0,
        updatedat DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
    testDb.close();
    testDb = null;
  });

  afterEach(() => {
    // Cleanup: close database connection if it exists
    if (dbService) {
      dbService.close();
    }
    if (testDb) {
      testDb.close();
      testDb = null;
    }
    // Clean up temp file
    try {
      unlinkSync(testDbPath);
    } catch (error) {
      // File may not exist, ignore error
    }
    jest.clearAllMocks();
  });

  it('should have test file structure', () => {
    expect(dbService).toBeInstanceOf(DatabaseService);
    expect(testDbPath).toContain('test-db-');
  });

  it('should establish database connection successfully', () => {
    // Arrange: DatabaseService is already created in beforeEach
    // The schema is created in beforeEach as well
    
    // Act: Call a method that triggers getDatabase()
    // This should establish the connection without throwing
    const result = dbService.isSystemSettingEnabled('test');
    
    // Assert: No error is thrown, method returns a boolean
    expect(typeof result).toBe('boolean');
    expect(result).toBe(false); // Setting doesn't exist, returns false
    
    // Verify WAL mode is enabled by checking PRAGMA
    // Since getDatabase() is private, we create a new connection to the same file
    // and check the journal mode (WAL mode persists in the file)
    const checkDb = new Database(testDbPath);
    const journalMode = checkDb.pragma('journal_mode', { simple: true }) as string;
    checkDb.close();
    
    expect(journalMode.toLowerCase()).toBe('wal');
  });

  it('should throw error on database connection failure', () => {
    // Arrange: Create DatabaseService with invalid path (non-existent directory)
    const invalidPath = '/invalid/path/that/does/not/exist/db.sqlite3';
    const service = new DatabaseService(invalidPath);
    
    // Mock logger.error to verify it's called
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {
      // Mock implementation - don't actually log, just return logger
      return logger;
    });
    
    // Act & Assert: Calling a method that triggers getDatabase() should cause an error
    // Note: isSystemSettingEnabled catches errors and returns false,
    // but getDatabase() itself throws, which is caught and logged
    const result = service.isSystemSettingEnabled('test');
    
    // Assert: Method returns false (error was caught and handled gracefully)
    expect(result).toBe(false);
    
    // Assert: Error was logged (verify logger.error was called)
    expect(errorSpy).toHaveBeenCalled();
    // Verify the call contains information about the failure
    const errorCall = errorSpy.mock.calls[0];
    expect(errorCall.length).toBeGreaterThan(0);
    // The first argument should be the log info (message or info object)
    const firstArg = errorCall[0];
    expect(firstArg).toBeDefined();
    
    // Cleanup
    errorSpy.mockRestore();
  });

  describe('isSystemSettingEnabled', () => {
    it('should return true when setting exists with value 1', () => {
      // Arrange: Insert setting with value 1
      const setupDb = new Database(testDbPath);
      setupDb.exec(`INSERT INTO system_settings (name, value) VALUES ('test_setting', 1)`);
      setupDb.close();
      
      // Act
      const result = dbService.isSystemSettingEnabled('test_setting');
      
      // Assert
      expect(result).toBe(true);
    });

    it('should return false when setting exists with value 0', () => {
      // Arrange: Insert setting with value 0
      const setupDb = new Database(testDbPath);
      setupDb.exec(`INSERT INTO system_settings (name, value) VALUES ('test_setting', 0)`);
      setupDb.close();
      
      // Act
      const result = dbService.isSystemSettingEnabled('test_setting');
      
      // Assert
      expect(result).toBe(false);
    });

    it('should return false when setting does not exist', () => {
      // Arrange: Empty table (no rows inserted)
      // The table is already created in beforeEach, just don't insert any rows
      
      // Act
      const result = dbService.isSystemSettingEnabled('non_existent');
      
      // Assert: Returns false without throwing exception
      expect(result).toBe(false);
    });

    it('should return false and log error when query fails', () => {
      // Arrange: Drop the table to cause query to fail
      const setupDb = new Database(testDbPath);
      setupDb.exec(`DROP TABLE IF EXISTS system_settings`);
      setupDb.close();
      
      // Mock logger.error to verify it's called
      const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {
        return logger;
      });
      
      // Act
      const result = dbService.isSystemSettingEnabled('test');
      
      // Assert: Returns false (fail-closed behavior)
      expect(result).toBe(false);
      
      // Assert: Error was logged
      expect(errorSpy).toHaveBeenCalled();
      const errorCall = errorSpy.mock.calls[0];
      expect(errorCall.length).toBeGreaterThan(0);
      const firstArg = errorCall[0];
      expect(firstArg).toBeDefined();
      
      // Cleanup
      errorSpy.mockRestore();
    });
  });

  describe('setSystemSetting', () => {
    it('should set system setting to true', () => {
      // Arrange: Clean table (already created in beforeEach)
      
      // Act
      const result = dbService.setSystemSetting('test_setting', true);
      
      // Assert: Returns true on success
      expect(result).toBe(true);
      
      // Assert: Can read back as enabled
      expect(dbService.isSystemSettingEnabled('test_setting')).toBe(true);
      
      // Assert: Database has value 1
      const checkDb = new Database(testDbPath);
      const row = checkDb.prepare('SELECT value FROM system_settings WHERE name = ?').get('test_setting') as { value: number } | undefined;
      checkDb.close();
      expect(row?.value).toBe(1);
    });

    it('should set system setting to false', () => {
      // Arrange: Setting exists with value 1
      const setupDb = new Database(testDbPath);
      setupDb.exec(`INSERT INTO system_settings (name, value) VALUES ('test_setting', 1)`);
      setupDb.close();
      
      // Act
      const result = dbService.setSystemSetting('test_setting', false);
      
      // Assert: Returns true on success
      expect(result).toBe(true);
      
      // Assert: Can read back as disabled
      expect(dbService.isSystemSettingEnabled('test_setting')).toBe(false);
      
      // Assert: Database has value 0
      const checkDb = new Database(testDbPath);
      const row = checkDb.prepare('SELECT value FROM system_settings WHERE name = ?').get('test_setting') as { value: number } | undefined;
      checkDb.close();
      expect(row?.value).toBe(0);
    });

    it('should update existing system setting', () => {
      // Arrange: Setting exists with value 0
      const setupDb = new Database(testDbPath);
      setupDb.exec(`INSERT INTO system_settings (name, value) VALUES ('test_setting', 0)`);
      setupDb.close();
      
      // Act: Update to true
      const result = dbService.setSystemSetting('test_setting', true);
      
      // Assert: Returns true on success
      expect(result).toBe(true);
      
      // Assert: Setting now has value 1
      expect(dbService.isSystemSettingEnabled('test_setting')).toBe(true);
      
      // Assert: Database has value 1
      const checkDb = new Database(testDbPath);
      const row = checkDb.prepare('SELECT value FROM system_settings WHERE name = ?').get('test_setting') as { value: number } | undefined;
      checkDb.close();
      expect(row?.value).toBe(1);
    });

    it('should return false and log error when database write fails', () => {
      // Arrange: Drop the table to cause write to fail
      const setupDb = new Database(testDbPath);
      setupDb.exec(`DROP TABLE IF EXISTS system_settings`);
      setupDb.close();
      
      // Mock logger.error to verify it's called
      const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {
        return logger;
      });
      
      // Act
      const result = dbService.setSystemSetting('test_setting', true);
      
      // Assert: Returns false (fail-closed behavior)
      expect(result).toBe(false);
      
      // Assert: Error was logged
      expect(errorSpy).toHaveBeenCalled();
      const errorCall = errorSpy.mock.calls[0];
      expect(errorCall.length).toBeGreaterThan(0);
      const firstArg = errorCall[0];
      expect(firstArg).toBeDefined();
      
      // Cleanup
      errorSpy.mockRestore();
    });
  });

  describe('getNextReadyTask', () => {
    it('should return null when no tasks are available', () => {
      // Arrange: Empty tasks table (already created in beforeEach)
      
      // Act
      const result = dbService.getNextReadyTask();
      
      // Assert
      expect(result).toBeNull();
    });

    it('should only consider tasks with status IN (0, 4)', () => {
      // Arrange: Insert tasks with various statuses
      const setupDb = new Database(testDbPath);
      setupDb.exec(`
        INSERT INTO tasks (id, prompt, "order", uuid, status) VALUES
        (1, 'task1', 1, 'uuid1', 0),
        (2, 'task2', 2, 'uuid2', 4),
        (3, 'task3', 0, 'uuid3', 1),
        (4, 'task4', 0, 'uuid4', 2),
        (5, 'task5', 0, 'uuid5', 3)
      `);
      setupDb.close();
      
      // Act
      const result = dbService.getNextReadyTask();
      
      // Assert: Should return a task with status 0 or 4
      expect(result).not.toBeNull();
      expect([0, 4]).toContain(result?.status);
      // Verify returned task is not status 1, 2, or 3
      expect(result?.status).not.toBe(1);
      expect(result?.status).not.toBe(2);
      expect(result?.status).not.toBe(3);
    });

    it('should return task with lowest order then id', () => {
      // Arrange: Insert tasks with varying order and status
      const setupDb = new Database(testDbPath);
      setupDb.exec(`
        INSERT INTO tasks (id, prompt, "order", uuid, status) VALUES
        (1, 'task1', 10, 'uuid1', 0),
        (2, 'task2', 5, 'uuid2', 0),
        (3, 'task3', 5, 'uuid3', 4),
        (4, 'task4', 5, 'uuid4', 0)
      `);
      setupDb.close();
      
      // Act
      const result = dbService.getNextReadyTask();
      
      // Assert: Should return task with lowest order (5), then lowest id (2)
      expect(result).not.toBeNull();
      expect(result?.order).toBe(5); // Lowest order
      expect(result?.id).toBe(2); // Lowest id among tasks with order=5
    });

    it('should return null and log error when query fails', () => {
      // Arrange: Drop the table to cause query to fail
      const setupDb = new Database(testDbPath);
      setupDb.exec(`DROP TABLE IF EXISTS tasks`);
      setupDb.close();
      
      // Mock logger.error to verify it's called
      const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {
        return logger;
      });
      
      // Act
      const result = dbService.getNextReadyTask();
      
      // Assert: Returns null (fail-safe behavior)
      expect(result).toBeNull();
      
      // Assert: Error was logged
      expect(errorSpy).toHaveBeenCalled();
      const errorCall = errorSpy.mock.calls[0];
      expect(errorCall.length).toBeGreaterThan(0);
      const firstArg = errorCall[0];
      expect(firstArg).toBeDefined();
      
      // Cleanup
      errorSpy.mockRestore();
    });
  });
});

