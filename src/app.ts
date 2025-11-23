import express, { Application, Request, Response } from 'express';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { QueueManager } from './queue/queue-manager.js';
import { DatabaseService } from './services/database-service.js';
import { logger } from './logger.js';

export class CursorAgentsApp {
  public app: Application;
  private queueManager: QueueManager;
  private databaseService: DatabaseService;
  private serverAdapter!: ExpressAdapter;

  constructor(queueManager?: QueueManager, databaseService?: DatabaseService) {
    this.app = express();
    this.queueManager = queueManager || new QueueManager();
    this.databaseService = databaseService || new DatabaseService();
    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    this.app.use(express.json());
  }

  private setupRoutes(): void {
    // Bull Board dashboard (similar to Sidekiq UI)
    // Base path includes /agents prefix because Traefik strips it before forwarding,
    // but the browser still needs the full path for asset loading
    this.serverAdapter = new ExpressAdapter();
    this.serverAdapter.setBasePath('/agents/admin/queues');

    // Initialize Bull Board with empty queues (will be updated after initialization)
    createBullBoard({
      queues: [],
      serverAdapter: this.serverAdapter,
    });

    this.app.use('/admin/queues', this.serverAdapter.getRouter());

    // Health check endpoint
    this.app.get('/health', (req: Request, res: Response) => {
      logger.info('Health check requested', {
        ip: req.ip,
        userAgent: req.get('user-agent'),
        service: 'cursor-agents',
      });
      res.json({
        status: 'ok',
        service: 'cursor-agents',
        timestamp: new Date().toISOString(),
      });
    });

    // Queue management endpoints
    this.app.get('/queues', async (_req: Request, res: Response) => {
      try {
        const queueNames = await this.queueManager.listQueues();
        const queueInfos = await Promise.all(
          queueNames.map(async (queueName) => {
            return await this.queueManager.getQueueInfo(queueName);
          })
        );
        res.json({ queues: queueInfos.filter((info) => info !== null) });
      } catch (error) {
        logger.error('Failed to list queues', { error });
        res.status(500).json({ error: 'Failed to list queues' });
      }
    });

    // Get queue info
    this.app.get('/queues/:queueName', async (req: Request, res: Response): Promise<void> => {
      try {
        const { queueName } = req.params;
        const info = await this.queueManager.getQueueInfo(queueName);

        if (!info) {
          res.status(404).json({ error: `Queue "${queueName}" not found` });
          return;
        }

        res.json(info);
      } catch (error) {
        logger.error('Failed to get queue info', { error, queueName: req.params.queueName });
        res.status(500).json({ error: 'Failed to get queue info' });
      }
    });

    // Delete queue
    this.app.delete('/queues/:queueName', async (req: Request, res: Response): Promise<void> => {
      try {
        const { queueName } = req.params;
        await this.queueManager.deleteQueue(queueName);
        res.json({
          success: true,
          message: `Queue "${queueName}" deleted successfully`,
        });
      } catch (error) {
        logger.error('Failed to delete queue', { error, queueName: req.params.queueName });
        const errorMessage = error instanceof Error ? error.message : 'Failed to delete queue';
        res.status(500).json({ error: errorMessage });
      }
    });

    // Add a recurring prompt
    this.app.post('/prompts/recurring', async (req: Request, res: Response): Promise<void> => {
      try {
        const { name, prompt, schedule, options } = req.body;

        if (!name || !prompt || !schedule) {
          res.status(400).json({
            error: 'Missing required fields: name, prompt, schedule',
          });
          return;
        }

        const job = await this.queueManager.addRecurringPrompt({
          name,
          prompt,
          schedule,
          options: options || {},
        });

        res.json({
          success: true,
          jobId: job.id,
          name: job.name,
        });
      } catch (error) {
        logger.error('Failed to add recurring prompt', { error });
        res.status(500).json({ error: 'Failed to add recurring prompt' });
      }
    });

    // Get prompt status
    this.app.get('/prompts/:name', async (req: Request, res: Response): Promise<void> => {
      try {
        const { name } = req.params;
        const status = await this.queueManager.getPromptStatus(name);

        if (!status) {
          res.status(404).json({ error: 'Prompt not found' });
          return;
        }

        res.json(status);
      } catch (error) {
        logger.error('Failed to get prompt status', { error, name: req.params.name });
        res.status(500).json({ error: 'Failed to get prompt status' });
      }
    });

    // Remove a recurring prompt
    this.app.delete('/prompts/:name', async (req: Request, res: Response) => {
      try {
        const { name } = req.params;
        await this.queueManager.removeRecurringPrompt(name);
        res.json({ success: true, message: `Prompt ${name} removed` });
      } catch (error) {
        logger.error('Failed to remove recurring prompt', { error, name: req.params.name });
        res.status(500).json({ error: 'Failed to remove recurring prompt' });
      }
    });

    // Agent management endpoints
    // Create an agent
    this.app.post('/agents', async (req: Request, res: Response): Promise<void> => {
      try {
        const { name, targetUrl, method, headers, body, schedule, oneTime, timeout, queue } =
          req.body;

        if (!name || !targetUrl) {
          res.status(400).json({
            error: 'Missing required fields: name, targetUrl',
          });
          return;
        }

        if (!oneTime && !schedule) {
          res.status(400).json({
            error: 'Either oneTime must be true or schedule must be provided',
          });
          return;
        }

        let job;
        if (oneTime) {
          job = await this.queueManager.addOneTimeAgent({
            name,
            targetUrl,
            method: method || 'POST',
            headers: headers || {},
            body,
            timeout: timeout || 30000,
            queue,
          });
        } else {
          job = await this.queueManager.addRecurringAgent({
            name,
            targetUrl,
            method: method || 'POST',
            headers: headers || {},
            body,
            schedule: schedule!,
            timeout: timeout || 30000,
            queue,
          });
        }

        res.json({
          success: true,
          message: `Agent "${name}" created successfully`,
          agent: {
            name: job.name,
            jobId: job.id,
            targetUrl,
            method: method || 'POST',
            oneTime,
            schedule: oneTime ? undefined : schedule,
            queue: queue || 'default',
          },
        });
      } catch (error) {
        logger.error('Failed to create agent', { error });
        res.status(500).json({ error: 'Failed to create agent' });
      }
    });

    // List all agents
    this.app.get('/agents', async (_req: Request, res: Response) => {
      try {
        const queues = await this.queueManager.listQueues();
        const agents = await Promise.all(
          queues.map(async (name) => {
            return await this.queueManager.getAgentStatus(name);
          })
        );

        res.json({
          agents: agents.filter((a) => a !== null),
        });
      } catch (error) {
        logger.error('Failed to list agents', { error });
        res.status(500).json({ error: 'Failed to list agents' });
      }
    });

    // Get agent status
    this.app.get('/agents/:name', async (req: Request, res: Response): Promise<void> => {
      try {
        const { name } = req.params;
        const status = await this.queueManager.getAgentStatus(name);

        if (!status) {
          res.status(404).json({ error: `Agent "${name}" not found` });
          return;
        }

        res.json(status);
      } catch (error) {
        logger.error('Failed to get agent status', { error, name: req.params.name });
        res.status(500).json({ error: 'Failed to get agent status' });
      }
    });

    // Delete an agent
    this.app.delete('/agents/:name', async (req: Request, res: Response) => {
      try {
        const { name } = req.params;
        await this.queueManager.removeAgent(name);
        res.json({
          success: true,
          message: `Agent "${name}" deleted successfully`,
        });
      } catch (error) {
        logger.error('Failed to delete agent', { error, name: req.params.name });
        res.status(500).json({ error: 'Failed to delete agent' });
      }
    });

    // Task operator endpoints
    // Create/enqueue task operator agent
    this.app.post('/task-operator', async (req: Request, res: Response): Promise<void> => {
      try {
        const { queue } = req.body;
        const agentName = 'task-operator';
        const targetQueue = queue || 'task-operator';

        // Enable task_operator system setting
        const settingSuccess = this.databaseService.setSystemSetting('task_operator', true);
        if (!settingSuccess) {
          logger.warn(
            'Failed to enable task_operator system setting, but continuing with agent creation'
          );
        }

        // Enqueue a one-time task operator job
        const job = await this.queueManager.addOneTimeAgent({
          name: agentName,
          targetUrl: 'task-operator://internal',
          method: 'POST',
          body: {
            type: 'task_operator',
            agentName,
            queue: targetQueue,
          },
          queue: targetQueue,
          timeout: 30000,
        });

        logger.info('Task operator agent enqueued', {
          agentName,
          queue: targetQueue,
          jobId: job.id,
          settingEnabled: settingSuccess,
        });

        res.json({
          success: true,
          message: 'Task operator agent enqueued successfully',
          agent: {
            name: job.name,
            jobId: job.id,
            queue: targetQueue,
          },
        });
      } catch (error) {
        logger.error('Failed to enqueue task operator', { error });
        res.status(500).json({ error: 'Failed to enqueue task operator' });
      }
    });

    // Delete/disable task operator (sets system setting to false)
    this.app.delete('/task-operator', async (_req: Request, res: Response): Promise<void> => {
      try {
        // Set task_operator system setting to false
        const success = this.databaseService.setSystemSetting('task_operator', false);

        if (!success) {
          res.status(500).json({
            error: 'Failed to disable task operator',
          });
          return;
        }

        // Also try to remove any existing task operator agents
        try {
          await this.queueManager.removeAgent('task-operator');
        } catch (error) {
          // Ignore errors if agent doesn't exist
          logger.info('Task operator agent not found (may already be removed)', { error });
        }

        logger.info('Task operator disabled', {
          setting: 'task_operator',
          value: false,
        });

        res.json({
          success: true,
          message:
            'Task operator disabled successfully. It will stop re-enqueueing after current jobs complete.',
        });
      } catch (error) {
        logger.error('Failed to disable task operator', { error });
        res.status(500).json({ error: 'Failed to disable task operator' });
      }
    });

    // Check task operator Redis lock status
    this.app.get('/task-operator/lock', async (_req: Request, res: Response): Promise<void> => {
      try {
        const { TaskOperatorService } = await import('./services/task-operator-service.js');
        const taskOperatorService = TaskOperatorService.getInstance();

        const isLocked = await taskOperatorService.isProcessing();

        logger.info('Task operator lock status checked via API', {
          isLocked,
        });

        res.json({
          success: true,
          isLocked,
          message: isLocked
            ? 'Task operator Redis lock is currently held'
            : 'Task operator Redis lock is not held',
        });
      } catch (error) {
        logger.error('Failed to check task operator lock status', { error });
        res.status(500).json({ error: 'Failed to check task operator lock status' });
      }
    });

    // Clear task operator Redis lock (forcefully delete the lock)
    this.app.delete('/task-operator/lock', async (_req: Request, res: Response): Promise<void> => {
      try {
        const { TaskOperatorService } = await import('./services/task-operator-service.js');
        const taskOperatorService = TaskOperatorService.getInstance();

        const cleared = await taskOperatorService.clearLock();

        logger.info('Task operator lock cleared via API', {
          lockCleared: cleared,
        });

        res.json({
          success: true,
          message: cleared
            ? 'Task operator Redis lock cleared successfully'
            : 'Task operator Redis lock was not present',
          lockCleared: cleared,
        });
      } catch (error) {
        logger.error('Failed to clear task operator lock', { error });
        res.status(500).json({ error: 'Failed to clear task operator lock' });
      }
    });

    // Task operator callback endpoint (receives callbacks from cursor-runner)
    this.app.post('/task-operator/callback', async (req: Request, res: Response): Promise<void> => {
      try {
        // Verify webhook secret if configured
        const expectedSecret = process.env.WEBHOOK_SECRET;
        if (expectedSecret) {
          const providedSecret =
            req.headers['x-webhook-secret'] ||
            req.headers['x-cursor-runner-secret'] ||
            (req.query as { secret?: string }).secret;

          if (providedSecret !== expectedSecret) {
            const secretStatus = providedSecret ? '[present]' : '[missing]';
            logger.warn('Unauthorized task operator callback - invalid secret', {
              providedSecret: secretStatus,
              ip: req.ip,
            });
            res.status(401).json({ error: 'Unauthorized' });
            return;
          }
        }

        const body = req.body as {
          success?: boolean;
          requestId?: string;
          request_id?: string;
          error?: string;
          output?: string;
          iterations?: number;
          maxIterations?: number;
        };

        const requestId = body.requestId || body.request_id;

        if (!requestId) {
          logger.warn('Callback received without requestId', { body });
          res.status(400).json({ error: 'requestId is required' });
          return;
        }

        logger.info('Task operator callback received', {
          requestId,
          success: body.success,
          successType: typeof body.success,
          hasError: !!body.error,
          hasOutput: !!body.output,
          iterations: body.iterations,
          maxIterations: body.maxIterations,
          fullBody: JSON.stringify(body),
        });

        // Get TaskOperatorService singleton instance to handle the callback
        // We need to import it here to avoid circular dependency
        // Using getInstance() ensures we use the same instance that processes tasks
        const { TaskOperatorService } = await import('./services/task-operator-service.js');
        const taskOperatorService = TaskOperatorService.getInstance();

        // Handle the callback (marks task complete or failed)
        await taskOperatorService.handleCallback(requestId, body);

        // Always return 200 OK to cursor-runner
        res.status(200).json({
          received: true,
          requestId,
        });
      } catch (error) {
        logger.error('Failed to process task operator callback', {
          error: error instanceof Error ? error.message : String(error),
          body: req.body,
        });

        // Still return 200 to prevent cursor-runner from retrying
        res.status(200).json({
          received: true,
          error: 'Internal error processing callback',
        });
      }
    });
  }

  async initialize(): Promise<void> {
    await this.queueManager.initialize();

    // Update Bull Board with all queues after initialization
    this.updateBullBoard();

    // Auto-start task operator if enabled
    if (this.databaseService.isSystemSettingEnabled('task_operator')) {
      logger.info('Task operator is enabled, auto-starting task operator agent');
      try {
        const agentName = 'task-operator';
        const targetQueue = 'task-operator';

        const job = await this.queueManager.addOneTimeAgent({
          name: agentName,
          targetUrl: 'task-operator://internal',
          method: 'POST',
          body: {
            type: 'task_operator',
            agentName,
            queue: targetQueue,
          },
          queue: targetQueue,
          timeout: 30000,
        });

        logger.info('Task operator agent auto-started', {
          agentName,
          queue: targetQueue,
          jobId: job.id,
        });
      } catch (error) {
        logger.error('Failed to auto-start task operator', { error });
        // Don't throw - allow application to start even if task operator fails to start
      }
    }

    logger.info('Cursor Agents application initialized');
    logger.info('Bull Board dashboard available at /admin/queues');
  }

  private updateBullBoard(): void {
    // Update Bull Board with all current queues
    const queues = this.queueManager.getQueues();
    const queueAdapters = queues.map((queue) => new BullMQAdapter(queue));

    // Recreate Bull Board with updated queues
    createBullBoard({
      queues: queueAdapters,
      serverAdapter: this.serverAdapter,
    });

    logger.info('Bull Board updated with queues', { queueCount: queues.length });
  }

  async start(port: number): Promise<void> {
    return new Promise((resolve) => {
      this.app.listen(port, () => {
        logger.info(`Server listening on port ${port}`);
        resolve();
      });
    });
  }

  async shutdown(): Promise<void> {
    await this.queueManager.shutdown();
    logger.info('Cursor Agents application shut down');
  }
}
