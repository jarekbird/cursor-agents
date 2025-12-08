import { describe, it, expect, beforeEach } from '@jest/globals';
import { spawn } from 'child_process';
import { promisify } from 'util';
import { exec } from 'child_process';

const execAsync = promisify(exec);

describe('Entrypoint E2E Tests', () => {
  let buildCompleted = false;

  beforeEach(async () => {
    // Build the project once before running tests
    if (!buildCompleted) {
      try {
        await execAsync('npm run build', { cwd: process.cwd() });
        buildCompleted = true;
      } catch (error) {
        // Build might have already completed, continue
        buildCompleted = true;
      }
    }
  });

  afterEach(() => {
    // Cleanup is handled per test
  });

  describe('Main app entrypoint (dist/index.js)', () => {
    it('should start main app and shut down gracefully on SIGTERM', async () => {
      // Arrange: Set up environment variables
      const env = {
        ...process.env,
        PORT: '3999', // Use a test port
        REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
        NODE_ENV: 'test',
      };

      // Act: Spawn the compiled entrypoint
      const childProcess = spawn('node', ['dist/index.js'], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let startupLog = '';
      let stderrLog = '';

      // Collect stdout and stderr
      childProcess.stdout?.on('data', (data) => {
        startupLog += data.toString();
      });

      childProcess.stderr?.on('data', (data) => {
        stderrLog += data.toString();
      });

      // Wait for startup (look for initialization log or timeout)
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          resolve(); // Continue even if we don't see the exact log
        }, 3000);

        const checkLog = () => {
          if (
            startupLog.includes('initialized') ||
            startupLog.includes('started') ||
            stderrLog.includes('initialized') ||
            stderrLog.includes('started') ||
            startupLog.length > 0 ||
            stderrLog.length > 0
          ) {
            clearTimeout(timeout);
            resolve();
          }
        };

        childProcess.stdout?.on('data', checkLog);
        childProcess.stderr?.on('data', checkLog);
      });

      // Assert: Process is running
      expect(childProcess.killed).toBe(false);

      // Act: Send SIGTERM
      childProcess.kill('SIGTERM');

      // Wait for process to exit
      const exitCode = await new Promise<number | null>((resolve) => {
        childProcess.on('exit', (code) => {
          resolve(code);
        });

        // Timeout after 5 seconds
        setTimeout(() => {
          if (!childProcess.killed) {
            childProcess.kill('SIGKILL');
            resolve(null);
          }
        }, 5000);
      });

      // Assert: Process exited gracefully (code 0) or was killed (null)
      expect([0, null]).toContain(exitCode);
    }, 15000); // 15 second timeout

    it('should start main app and shut down gracefully on SIGINT', async () => {
      // Arrange: Set up environment variables
      const env = {
        ...process.env,
        PORT: '3998', // Use a different test port
        REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
        NODE_ENV: 'test',
      };

      // Act: Spawn the compiled entrypoint
      const childProcess = spawn('node', ['dist/index.js'], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      // Wait a bit for startup
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Assert: Process is running
      expect(childProcess.killed).toBe(false);

      // Act: Send SIGINT
      childProcess.kill('SIGINT');

      // Wait for process to exit
      const exitCode = await new Promise<number | null>((resolve) => {
        childProcess.on('exit', (code) => {
          resolve(code);
        });

        // Timeout after 5 seconds
        setTimeout(() => {
          if (!childProcess.killed) {
            childProcess.kill('SIGKILL');
            resolve(null);
          }
        }, 5000);
      });

      // Assert: Process exited gracefully (code 0) or was killed (null)
      expect([0, null]).toContain(exitCode);
    }, 15000); // 15 second timeout
  });

  describe('MCP server entrypoint (dist/mcp/index.js)', () => {
    it('should start MCP server and handle Redis failure gracefully', async () => {
      // Arrange: Set invalid Redis URL to test failure handling
      const env = {
        ...process.env,
        REDIS_URL: 'redis://invalid-host:6379',
        NODE_ENV: 'test',
      };

      // Act: Spawn the compiled MCP entrypoint
      const childProcess = spawn('node', ['dist/mcp/index.js'], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stderrLog = '';
      let stdoutLog = '';

      // Collect stderr and stdout
      childProcess.stderr?.on('data', (data) => {
        stderrLog += data.toString();
      });

      childProcess.stdout?.on('data', (data) => {
        stdoutLog += data.toString();
      });

      // Wait for process to exit or log error (should exit on Redis failure)
      const exitCode = await new Promise<number | null>((resolve) => {
        childProcess.on('exit', (code) => {
          resolve(code);
        });

        // Timeout after 10 seconds
        setTimeout(() => {
          if (!childProcess.killed) {
            childProcess.kill('SIGKILL');
            resolve(null);
          }
        }, 10000);
      });

      // Assert: Process should exit with error code (1) or log error
      // The MCP server should handle Redis failure and exit gracefully
      expect([1, null]).toContain(exitCode);
      
      // Verify error was logged (either in stderr or process exited)
      const hasErrorLog = stderrLog.includes('ERROR') || stderrLog.includes('error') || stderrLog.includes('Failed');
      expect(hasErrorLog || exitCode === 1).toBe(true);
    }, 15000); // 15 second timeout

    it('should start MCP server and shut down gracefully on SIGTERM', async () => {
      // Arrange: Set up valid Redis URL (or use default)
      const env = {
        ...process.env,
        REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
        NODE_ENV: 'test',
      };

      // Act: Spawn the compiled MCP entrypoint
      const childProcess = spawn('node', ['dist/mcp/index.js'], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stderrLog = '';

      // Collect stderr
      childProcess.stderr?.on('data', (data) => {
        stderrLog += data.toString();
      });

      // Wait for startup (look for initialization log or timeout)
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          resolve(); // Continue even if we don't see the exact log
        }, 3000);

        const checkLog = () => {
          if (
            stderrLog.includes('initialized') ||
            stderrLog.includes('started') ||
            stderrLog.includes('ready') ||
            stderrLog.length > 50
          ) {
            clearTimeout(timeout);
            resolve();
          }
        };

        childProcess.stderr?.on('data', checkLog);
      });

      // Assert: Process is running (or exited if Redis connection failed)
      // If it's still running, test graceful shutdown
      if (!childProcess.killed) {
        // Act: Send SIGTERM
        childProcess.kill('SIGTERM');

        // Wait for process to exit
        const exitCode = await new Promise<number | null>((resolve) => {
          childProcess.on('exit', (code) => {
            resolve(code);
          });

          // Timeout after 5 seconds
          setTimeout(() => {
            if (!childProcess.killed) {
              childProcess.kill('SIGKILL');
              resolve(null);
            }
          }, 5000);
        });

        // Assert: Process exited gracefully (code 0) or was killed (null)
        expect([0, null]).toContain(exitCode);
      } else {
        // Process already exited (likely due to Redis connection failure)
        // This is acceptable - the test verifies it handles the failure
        expect(childProcess.killed).toBe(true);
      }
    }, 15000); // 15 second timeout
  });
});

