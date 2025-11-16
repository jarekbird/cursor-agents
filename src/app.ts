import express, { Application, Request, Response } from 'express';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { QueueManager } from './queue/queue-manager.js';
import { logger } from './logger.js';

export class CursorAgentsApp {
  public app: Application;
  private queueManager: QueueManager;
  private serverAdapter!: ExpressAdapter;

  constructor(queueManager?: QueueManager) {
    this.app = express();
    this.queueManager = queueManager || new QueueManager();
    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    this.app.use(express.json());
    this.app.use((req, _res, next) => {
      logger.info('HTTP Request', {
        method: req.method,
        path: req.path,
        ip: req.ip,
      });
      next();
    });
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
    this.app.get('/health', (_req: Request, res: Response) => {
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
  }

  async initialize(): Promise<void> {
    await this.queueManager.initialize();

    // Update Bull Board with all queues after initialization
    this.updateBullBoard();

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
