import { Queue, Worker, QueueEvents, RepeatOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { logger } from '../logger.js';
import { PromptProcessor, AgentJobData } from './prompt-processor.js';

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

export class QueueManager {
  private redis: Redis;
  private queues: Map<string, Queue> = new Map();
  private workers: Map<string, Worker> = new Map();
  private queueEvents: Map<string, QueueEvents> = new Map();
  private promptProcessor: PromptProcessor;

  constructor() {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379/0';
    this.redis = new Redis(redisUrl);
    this.promptProcessor = new PromptProcessor();
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
    // This would load existing recurring jobs from Redis
    // For now, we'll start fresh on each initialization
    logger.info('Loading existing queues...');
  }

  async addRecurringPrompt(options: RecurringPromptOptions): Promise<{ id: string; name: string }> {
    const { name, prompt, schedule, options: jobOptions } = options;

    let queue = this.queues.get(name);
    if (!queue) {
      queue = new Queue(name, {
        connection: this.redis,
      });
      this.queues.set(name, queue);

      // Create worker for this queue
      const worker = new Worker(
        name,
        async (job) => {
          logger.info('Processing job', { jobId: job.id, name: job.name, queue: name });
          await this.promptProcessor.process(job.data);
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
      const queueEvents = new QueueEvents(name, { connection: this.redis });
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
      queue = new Queue(name, {
        connection: this.redis,
      });
      this.queues.set(name, queue);

      // Create worker for this queue
      const worker = new Worker(
        name,
        async (job) => {
          logger.info('Processing agent job', { jobId: job.id, name: job.name });
          await this.promptProcessor.process(job.data);
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

      this.workers.set(name, worker);

      // Create queue events listener
      const queueEvents = new QueueEvents(name, { connection: this.redis });
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
      queue = new Queue(name, {
        connection: this.redis,
      });
      this.queues.set(name, queue);

      // Create worker for this queue
      const worker = new Worker(
        name,
        async (job) => {
          logger.info('Processing agent job', { jobId: job.id, name: job.name });
          await this.promptProcessor.process(job.data);
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

      this.workers.set(name, worker);

      // Create queue events listener
      const queueEvents = new QueueEvents(name, { connection: this.redis });
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
   * Get agent status (alias for getPromptStatus for consistency)
   */
  async getAgentStatus(name: string): Promise<PromptStatus | null> {
    return this.getPromptStatus(name);
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
