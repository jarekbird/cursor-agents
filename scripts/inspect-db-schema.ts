#!/usr/bin/env tsx
/**
 * Script to inspect the schema of the shared database that cursor-agents uses
 * This helps verify that the database schema matches what the application expects
 */

import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Use the same database path logic as DatabaseService
const dbPath = process.env.SHARED_DB_PATH || '/app/shared_db/shared.sqlite3';

console.log('='.repeat(80));
console.log('Database Schema Inspector');
console.log('='.repeat(80));
console.log(`Database path: ${dbPath}`);
console.log();

// Check if database file exists
try {
  const fs = await import('fs/promises');
  try {
    await fs.access(dbPath);
  } catch {
    console.error(`❌ Database file not found at: ${dbPath}`);
    console.error('\nPossible solutions:');
    console.error('1. If running locally, set SHARED_DB_PATH environment variable');
    console.error('2. If running in Docker, ensure the volume is mounted correctly');
    console.error('3. Run the cursor-runner/scripts/access-shared-db.sh script to mount the database locally');
    process.exit(1);
  }
} catch (error) {
  // If fs import fails, continue anyway (might work in some environments)
  console.warn('Could not check if file exists, continuing anyway...');
}

let db: Database.Database | null = null;

try {
  // Connect to database
  console.log('Connecting to database...');
  db = new Database(dbPath, { readonly: true });
  console.log('✅ Connected successfully\n');

  // Get all tables
  console.log('📋 Tables in database:');
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    )
    .all() as Array<{ name: string }>;
  
  if (tables.length === 0) {
    console.log('  (no tables found)');
  } else {
    tables.forEach((table) => {
      console.log(`  - ${table.name}`);
    });
  }
  console.log();

  // Inspect tasks table specifically
  console.log('='.repeat(80));
  console.log('Tasks Table Schema');
  console.log('='.repeat(80));

  const tableInfo = db
    .prepare('PRAGMA table_info(tasks)')
    .all() as Array<{
    cid: number;
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
  }>;

  if (tableInfo.length === 0) {
    console.error('❌ Tasks table not found in database!');
    console.error('\nThe tasks table may not have been created yet.');
    console.error('Run migrations: docker-compose exec app bundle exec rails db:migrate');
  } else {
    console.log('\nColumns:');
    console.log('-'.repeat(80));
    console.log(
      `${'Column Name'.padEnd(20)} ${'Type'.padEnd(15)} ${'Nullable'.padEnd(10)} ${'Default'.padEnd(20)} ${'Primary Key'}`
    );
    console.log('-'.repeat(80));

    tableInfo.forEach((col) => {
      const nullable = col.notnull === 0 ? 'YES' : 'NO';
      const pk = col.pk === 1 ? 'YES' : 'NO';
      const defaultVal = col.dflt_value || '(none)';
      console.log(
        `${col.name.padEnd(20)} ${col.type.padEnd(15)} ${nullable.padEnd(10)} ${defaultVal.padEnd(20)} ${pk}`
      );
    });

    // Check for specific columns we care about
    console.log('\n' + '='.repeat(80));
    console.log('Column Checks');
    console.log('='.repeat(80));

    const columnNames = tableInfo.map((col) => col.name.toLowerCase());
    const checks = [
      { name: 'id', required: true },
      { name: 'prompt', required: true },
      { name: 'status', required: true },
      { name: 'order', required: false },
      { name: 'uuid', required: false },
      { name: 'createdat', required: false },
      { name: 'updatedat', required: false },
      { name: 'created_at', required: false },
      { name: 'updated_at', required: false },
    ];

    checks.forEach((check) => {
      const exists = columnNames.includes(check.name.toLowerCase());
      const status = exists ? '✅' : check.required ? '❌' : '⚠️ ';
      const req = check.required ? '(required)' : '(optional)';
      console.log(`${status} ${check.name.padEnd(20)} ${req}`);
    });

    // Check for updatedat specifically
    const hasUpdatedAt = columnNames.includes('updatedat');
    console.log('\n' + '='.repeat(80));
    if (hasUpdatedAt) {
      console.log('✅ updatedat column EXISTS');
      const updatedAtCol = tableInfo.find(
        (col) => col.name.toLowerCase() === 'updatedat'
      );
      if (updatedAtCol) {
        console.log(`   Type: ${updatedAtCol.type}`);
        console.log(`   Default: ${updatedAtCol.dflt_value || '(none)'}`);
        console.log(`   Nullable: ${updatedAtCol.notnull === 0 ? 'YES' : 'NO'}`);
      }
    } else {
      console.log('❌ updatedat column MISSING');
      console.log('\nThis is the column that cursor-agents is trying to use.');
      console.log('The column should be added via migration or the application will');
      console.log('fall back to updating only the status field.');
    }

    // Show sample data if any
    console.log('\n' + '='.repeat(80));
    console.log('Sample Data (first 5 rows)');
    console.log('='.repeat(80));

    try {
      const sampleRows = db
        .prepare('SELECT * FROM tasks LIMIT 5')
        .all() as Array<Record<string, unknown>>;

      if (sampleRows.length === 0) {
        console.log('(no tasks in database)');
      } else {
        console.log(`Found ${sampleRows.length} task(s):\n`);
        sampleRows.forEach((row, index) => {
          console.log(`Task ${index + 1}:`);
          Object.entries(row).forEach(([key, value]) => {
            const displayValue =
              value === null
                ? '(null)'
                : typeof value === 'string' && value.length > 50
                  ? value.substring(0, 50) + '...'
                  : String(value);
            console.log(`  ${key}: ${displayValue}`);
          });
          console.log();
        });

        // Get total count
        const totalCount = db
          .prepare('SELECT COUNT(*) as count FROM tasks')
          .get() as { count: number };
        if (totalCount.count > sampleRows.length) {
          console.log(`... and ${totalCount.count - sampleRows.length} more task(s)`);
        }
      }
    } catch (error) {
      console.error('Error reading sample data:', error);
    }
  }

  // Show indexes
  console.log('\n' + '='.repeat(80));
  console.log('Indexes on tasks table');
  console.log('='.repeat(80));

  try {
    const indexes = db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='tasks'")
      .all() as Array<{ name: string; sql: string | null }>;

    if (indexes.length === 0) {
      console.log('(no indexes found)');
    } else {
      indexes.forEach((index) => {
        console.log(`\n${index.name}:`);
        console.log(`  ${index.sql || '(auto-generated)'}`);
      });
    }
  } catch (error) {
    console.error('Error reading indexes:', error);
  }

  console.log('\n' + '='.repeat(80));
  console.log('Inspection complete!');
  console.log('='.repeat(80));
} catch (error) {
  console.error('\n❌ Error inspecting database:');
  if (error instanceof Error) {
    console.error(`   ${error.message}`);
    if (error.stack) {
      console.error('\nStack trace:');
      console.error(error.stack);
    }
  } else {
    console.error(error);
  }
  process.exit(1);
} finally {
  if (db) {
    db.close();
    console.log('\nDatabase connection closed.');
  }
}

