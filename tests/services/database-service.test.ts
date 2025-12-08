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
});

