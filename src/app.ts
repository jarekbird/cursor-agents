import express, { Application, Request, Response } from 'express';
import { QueueManager } from './queue/queue-manager.js';
import { logger } from './logger.js';

export class CursorAgentsApp {
  public app: Application;
  private queueManager: QueueManager;

  constructor() {
    this.app = express();
    this.queueManager = new QueueManager();
    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    this.app.use(express.json());
    this.app.use((req, res, next) => {
      logger.info('HTTP Request', {
        method: req.method,
        path: req.path,
        ip: req.ip,
      });
      next();
    });
  }

  private setupRoutes(): void {
    // Health check endpoint
    this.app.get('/health', (req: Request, res: Response) => {
      res.json({
        status: 'ok',
        service: 'cursor-agents',
        timestamp: new Date().toISOString(),
      });
    });

    // Queue management endpoints
    this.app.get('/queues', async (req: Request, res: Response) => {
      try {
        const queues = await this.queueManager.listQueues();
        res.json({ queues });
      } catch (error) {
        logger.error('Failed to list queues', { error });
        res.status(500).json({ error: 'Failed to list queues' });
      }
    });

    // Add a recurring prompt
    this.app.post('/prompts/recurring', async (req: Request, res: Response) => {
      try {
        const { name, prompt, schedule, options } = req.body;

        if (!name || !prompt || !schedule) {
          return res.status(400).json({
            error: 'Missing required fields: name, prompt, schedule',
          });
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
    this.app.get('/prompts/:name', async (req: Request, res: Response) => {
      try {
        const { name } = req.params;
        const status = await this.queueManager.getPromptStatus(name);

        if (!status) {
          return res.status(404).json({ error: 'Prompt not found' });
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
    logger.info('Cursor Agents application initialized');
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
