import { Queue, Worker, QueueEvents, RepeatOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { logger } from '../logger.js';
import { PromptProcessor, AgentJobData, PromptJobData } from './prompt-processor.js';

export interface RecurringPromptOptions {
  name: string;
  prompt: string;
  schedule: string | RepeatOptions;
  options?: {
    repository?: string;
    branch?: string;
    maxIterations?: number;
    [key: string]: unknown;
  };
}

export interface AgentConfig {
  name: string;
  targetUrl: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  headers?: Record<string, string>;
  body?: unknown;
  schedule?: string; // Cron pattern or interval for recurring jobs
  oneTime?: boolean; // If true, run once immediately
  timeout?: number; // Request timeout in milliseconds
}

export interface PromptStatus {
  name: string;
  isActive: boolean;
  lastRun?: Date;
  nextRun?: Date;
  jobId?: string;
}

export interface AgentStatus extends PromptStatus {
  targetUrl?: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  headers?: Record<string, string>;
  body?: unknown;
  schedule?: string;
  timeout?: number;
}

// Factory function types for dependency injection
export type QueueFactory = (name: string, options?: { connection: Redis }) => Queue;

export type WorkerFactory = (
  name: string,
  processor: (job: { id?: string; name?: string; data: unknown }) => Promise<void>,
  options?: { connection: Redis; concurrency?: number }
) => Worker;

export type QueueEventsFactory = (name: string, options?: { connection: Redis }) => QueueEvents;

export class QueueManager {
  private redis: Redis;
  private queues: Map<string, Queue> = new Map();
  private workers: Map<string, Worker> = new Map();
  private queueEvents: Map<string, QueueEvents> = new Map();
  private promptProcessor: PromptProcessor;
  private queueFactory: QueueFactory;
  private workerFactory: WorkerFactory;
  private queueEventsFactory: QueueEventsFactory;

  /**
   * Get all queues for Bull Board dashboard
   */
  getQueues(): Queue[] {
    return Array.from(this.queues.values());
  }

  constructor(
    redis?: Redis,
    promptProcessor?: PromptProcessor,
    queueFactory?: QueueFactory,
    workerFactory?: WorkerFactory,
    queueEventsFactory?: QueueEventsFactory
  ) {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379/0';
    this.redis =
      redis ||
      new Redis(redisUrl, {
        maxRetriesPerRequest: null, // Required by BullMQ - BullMQ manages its own retry logic
      });
    this.promptProcessor = promptProcessor || new PromptProcessor();

    // Use provided factories or default to actual BullMQ classes
    this.queueFactory = queueFactory || ((name, options) => new Queue(name, options));
    this.workerFactory =
      workerFactory ||
      ((name, processor, options) => new Worker(name, processor as never, options));
    this.queueEventsFactory =
      queueEventsFactory || ((name, options) => new QueueEvents(name, options));
  }

  async initialize(): Promise<void> {
    logger.info('Initializing QueueManager...');

    // Test Redis connection
    try {
      await this.redis.ping();
      logger.info('Redis connection established', { url: process.env.REDIS_URL });
    } catch (error) {
      logger.error('Failed to connect to Redis', { error });
      throw error;
    }

    // Start processing existing queues
    await this.loadExistingQueues();

    logger.info('QueueManager initialized');
  }

  private async loadExistingQueues(): Promise<void> {
    // Load existing queues from Redis
    // BullMQ stores queue metadata with keys like "bull:{queueName}:meta"
    logger.info('Loading existing queues...');

    try {
      // Scan Redis for all BullMQ queue keys
      // BullMQ uses keys like "bull:{queueName}:meta", "bull:{queueName}:id", etc.
      const keys: string[] = [];
      let cursor = '0';

      do {
        const [nextCursor, foundKeys] = await this.redis.scan(
          cursor,
          'MATCH',
          'bull:*:meta',
          'COUNT',
          100
        );
        cursor = nextCursor;
        keys.push(...foundKeys);
      } while (cursor !== '0');

      // Extract queue names from keys (format: "bull:{queueName}:meta")
      const queueNames = new Set<string>();
      for (const key of keys) {
        const match = key.match(/^bull:([^:]+):meta$/);
        if (match) {
          queueNames.add(match[1]);
        }
      }

      logger.info('Found existing queues in Redis', {
        count: queueNames.size,
        queues: Array.from(queueNames),
      });

      // Recreate queues, workers, and queue events for each existing queue
      for (const queueName of queueNames) {
        try {
          // Recreate queue
          const queue = this.queueFactory(queueName, {
            connection: this.redis,
          });
          this.queues.set(queueName, queue);

          // Recreate worker
          const worker = this.workerFactory(
            queueName,
            async (job) => {
              logger.info('Processing agent job', { jobId: job.id, name: job.name });
              await this.promptProcessor.process(job.data as PromptJobData | AgentJobData);
            },
            {
              connection: this.redis,
              concurrency: parseInt(process.env.BULLMQ_CONCURRENCY || '5', 10),
            }
          );

          worker.on('completed', (job) => {
            logger.info('Agent job completed', { jobId: job.id, name: job.name });
          });

          worker.on('failed', (job, err) => {
            logger.error('Agent job failed', { jobId: job?.id, name: job?.name, error: err });
          });

          this.workers.set(queueName, worker);

          // Recreate queue events
          const queueEvents = this.queueEventsFactory(queueName, { connection: this.redis });
          this.queueEvents.set(queueName, queueEvents);

          logger.info('Restored queue from Redis', { queueName });
        } catch (error) {
          logger.error('Failed to restore queue from Redis', { queueName, error });
          // Continue with other queues even if one fails
        }
      }

      logger.info('Finished loading existing queues', { restoredCount: this.queues.size });
    } catch (error) {
      logger.error('Error loading existing queues from Redis', { error });
      // Don't throw - allow application to start even if queue loading fails
      // Queues will be created on-demand when new agents are added
    }
  }

  async addRecurringPrompt(options: RecurringPromptOptions): Promise<{ id: string; name: string }> {
    const { name, prompt, schedule, options: jobOptions } = options;

    let queue = this.queues.get(name);
    if (!queue) {
      queue = this.queueFactory(name, {
        connection: this.redis,
      });
      this.queues.set(name, queue);

      // Create worker for this queue
      const worker = this.workerFactory(
        name,
        async (job) => {
          logger.info('Processing job', { jobId: job.id, name: job.name, queue: name });
          await this.promptProcessor.process(job.data as PromptJobData | AgentJobData);
        },
        {
          connection: this.redis,
          concurrency: parseInt(process.env.BULLMQ_CONCURRENCY || '5', 10),
        }
      );

      worker.on('completed', (job) => {
        logger.info('Job completed', { jobId: job.id, name: job.name });
      });

      worker.on('failed', (job, err) => {
        logger.error('Job failed', { jobId: job?.id, name: job?.name, error: err });
      });

      this.workers.set(name, worker);

      // Create queue events listener
      const queueEvents = this.queueEventsFactory(name, { connection: this.redis });
      this.queueEvents.set(name, queueEvents);
    }

    // Add recurring job
    const repeatOptions: RepeatOptions =
      typeof schedule === 'string' ? { pattern: schedule } : schedule;

    const jobId = `recurring:${name}`;

    // Remove existing repeatable job if it exists
    try {
      await queue.removeRepeatableByKey(jobId);
    } catch {
      // Ignore if job doesn't exist
    }

    const job = await queue.add(
      name,
      {
        prompt,
        options: jobOptions || {},
      },
      {
        repeat: repeatOptions,
        jobId,
      }
    );

    logger.info('Recurring prompt added', {
      name,
      jobId: job.id,
      schedule: repeatOptions.pattern || (repeatOptions as { cron?: string }).cron || 'unknown',
    });

    return { id: job.id!, name: job.name! };
  }

  async getPromptStatus(name: string): Promise<PromptStatus | null> {
    const queue = this.queues.get(name);
    if (!queue) {
      return null;
    }

    const repeatableJobs = await queue.getRepeatableJobs();
    const jobKey = `recurring:${name}`;
    const job = repeatableJobs.find((j) => j.id === jobKey || j.key === jobKey);

    if (!job) {
      return { name, isActive: false };
    }

    // Get last completed job
    const completed = await queue.getCompleted(0, 0);
    const lastJob = completed.length > 0 ? completed[0] : null;

    return {
      name,
      isActive: true,
      lastRun: lastJob?.finishedOn ? new Date(lastJob.finishedOn) : undefined,
      nextRun: job.next ? new Date(job.next) : undefined,
      jobId: job.id || undefined,
    };
  }

  async removeRecurringPrompt(name: string): Promise<void> {
    const queue = this.queues.get(name);
    if (!queue) {
      throw new Error(`Queue ${name} not found`);
    }

    // Remove repeatable job
    const jobKey = `recurring:${name}`;
    try {
      await queue.removeRepeatableByKey(jobKey);
    } catch (error) {
      logger.warn('Failed to remove repeatable job', { error, name, jobKey });
    }

    // Clean up
    const worker = this.workers.get(name);
    if (worker) {
      await worker.close();
      this.workers.delete(name);
    }

    const queueEvents = this.queueEvents.get(name);
    if (queueEvents) {
      await queueEvents.close();
      this.queueEvents.delete(name);
    }

    await queue.close();
    this.queues.delete(name);

    logger.info('Recurring prompt removed', { name });
  }

  async listQueues(): Promise<string[]> {
    return Array.from(this.queues.keys());
  }

  /**
   * Add a one-time agent that executes immediately
   */
  async addOneTimeAgent(config: AgentConfig): Promise<{ id: string; name: string }> {
    const { name, targetUrl, method = 'POST', headers = {}, body, timeout = 30000 } = config;

    let queue = this.queues.get(name);
    if (!queue) {
      queue = this.queueFactory(name, {
        connection: this.redis,
      });
      this.queues.set(name, queue);

      // Create worker for this queue
      logger.info('Creating worker for queue', { queueName: name });
      const worker = this.workerFactory(
        name,
        async (job) => {
          logger.info('Worker picked up job', { jobId: job.id, name: job.name, queueName: name });
          await this.promptProcessor.process(job.data as PromptJobData | AgentJobData);
        },
        {
          connection: this.redis,
          concurrency: parseInt(process.env.BULLMQ_CONCURRENCY || '5', 10),
        }
      );

      worker.on('completed', (job) => {
        logger.info('Agent job completed', { jobId: job.id, name: job.name, queueName: name });
      });

      worker.on('failed', (job, err) => {
        logger.error('Agent job failed', {
          jobId: job?.id,
          name: job?.name,
          queueName: name,
          error: err,
        });
      });

      worker.on('active', (job) => {
        logger.info('Agent job started processing', {
          jobId: job.id,
          name: job.name,
          queueName: name,
        });
      });

      this.workers.set(name, worker);
      logger.info('Worker created and ready', { queueName: name });

      // Create queue events listener
      const queueEvents = this.queueEventsFactory(name, { connection: this.redis });
      this.queueEvents.set(name, queueEvents);
    }

    // Add one-time job
    const jobData: AgentJobData = {
      targetUrl,
      method,
      headers,
      body,
      timeout,
    };

    const job = await queue.add(name, jobData, {
      jobId: `agent:${name}:${Date.now()}`,
    });

    logger.info('One-time agent added', {
      name,
      jobId: job.id,
      targetUrl,
      method,
    });

    return { id: job.id!, name: job.name! };
  }

  /**
   * Add a recurring agent that executes on a schedule
   */
  async addRecurringAgent(config: AgentConfig): Promise<{ id: string; name: string }> {
    const {
      name,
      targetUrl,
      method = 'POST',
      headers = {},
      body,
      schedule,
      timeout = 30000,
    } = config;

    if (!schedule) {
      throw new Error('Schedule is required for recurring agents');
    }

    let queue = this.queues.get(name);
    if (!queue) {
      queue = this.queueFactory(name, {
        connection: this.redis,
      });
      this.queues.set(name, queue);

      // Create worker for this queue
      logger.info('Creating worker for queue', { queueName: name });
      const worker = this.workerFactory(
        name,
        async (job) => {
          logger.info('Worker picked up job', { jobId: job.id, name: job.name, queueName: name });
          await this.promptProcessor.process(job.data as PromptJobData | AgentJobData);
        },
        {
          connection: this.redis,
          concurrency: parseInt(process.env.BULLMQ_CONCURRENCY || '5', 10),
        }
      );

      worker.on('completed', (job) => {
        logger.info('Agent job completed', { jobId: job.id, name: job.name, queueName: name });
      });

      worker.on('failed', (job, err) => {
        logger.error('Agent job failed', {
          jobId: job?.id,
          name: job?.name,
          queueName: name,
          error: err,
        });
      });

      worker.on('active', (job) => {
        logger.info('Agent job started processing', {
          jobId: job.id,
          name: job.name,
          queueName: name,
        });
      });

      this.workers.set(name, worker);
      logger.info('Worker created and ready', { queueName: name });

      // Create queue events listener
      const queueEvents = this.queueEventsFactory(name, { connection: this.redis });
      this.queueEvents.set(name, queueEvents);
    }

    // Add recurring job
    const repeatOptions: RepeatOptions =
      typeof schedule === 'string' ? { pattern: schedule } : schedule;

    const jobId = `agent:${name}`;

    // Remove existing repeatable job if it exists
    try {
      await queue.removeRepeatableByKey(jobId);
    } catch {
      // Ignore if job doesn't exist
    }

    const jobData: AgentJobData = {
      targetUrl,
      method,
      headers,
      body,
      timeout,
    };

    const job = await queue.add(name, jobData, {
      repeat: repeatOptions,
      jobId,
    });

    logger.info('Recurring agent added', {
      name,
      jobId: job.id,
      targetUrl,
      method,
      schedule: repeatOptions.pattern || (repeatOptions as { cron?: string }).cron || 'unknown',
    });

    return { id: job.id!, name: job.name! };
  }

  /**
   * Get agent status with full configuration
   */
  async getAgentStatus(name: string): Promise<AgentStatus | null> {
    const queue = this.queues.get(name);
    if (!queue) {
      return null;
    }

    // Get basic status
    const basicStatus = await this.getPromptStatus(name);
    if (!basicStatus) {
      return null;
    }

    // Try to get agent configuration from the most recent job
    // Check waiting, active, and completed jobs
    const [waiting, active, completed] = await Promise.all([
      queue.getWaiting(0, 1),
      queue.getActive(0, 1),
      queue.getCompleted(0, 1),
    ]);

    const recentJob = waiting[0] || active[0] || completed[0];
    let agentConfig: Partial<AgentStatus> = {};

    if (recentJob && recentJob.data) {
      const jobData = recentJob.data as AgentJobData;
      agentConfig = {
        targetUrl: jobData.targetUrl,
        method: jobData.method,
        headers: jobData.headers,
        body: jobData.body,
        timeout: jobData.timeout,
      };
    }

    // Get schedule from repeatable job
    const repeatableJobs = await queue.getRepeatableJobs();
    const jobKey = `agent:${name}`;
    const repeatableJob = repeatableJobs.find((j) => j.id === jobKey || j.key === jobKey);

    if (repeatableJob?.pattern) {
      agentConfig.schedule = repeatableJob.pattern;
    }

    return {
      ...basicStatus,
      ...agentConfig,
    };
  }

  /**
   * Remove an agent (alias for removeRecurringPrompt for consistency)
   */
  async removeAgent(name: string): Promise<void> {
    return this.removeRecurringPrompt(name);
  }

  async shutdown(): Promise<void> {
    logger.info('Shutting down QueueManager...');

    // Close all workers
    for (const [name, worker] of this.workers) {
      await worker.close();
      logger.info('Worker closed', { name });
    }

    // Close all queue events
    for (const [name, queueEvents] of this.queueEvents) {
      await queueEvents.close();
      logger.info('Queue events closed', { name });
    }

    // Close all queues
    for (const [name, queue] of this.queues) {
      await queue.close();
      logger.info('Queue closed', { name });
    }

    // Close Redis connection
    await this.redis.quit();
    logger.info('Redis connection closed');
  }
}
