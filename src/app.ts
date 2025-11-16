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
        const queues = await this.queueManager.listQueues();
        res.json({ queues });
      } catch (error) {
        logger.error('Failed to list queues', { error });
        res.status(500).json({ error: 'Failed to list queues' });
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
