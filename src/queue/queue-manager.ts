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
  queue?: string; // Queue name (defaults to 'default' if not specified)
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
  queue?: string; // Queue name where the agent is located
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

  // Default queue name when none is specified
  private static readonly DEFAULT_QUEUE = 'default';

  /**
   * Get all queues for Bull Board dashboard
   */
  getQueues(): Queue[] {
    return Array.from(this.queues.values());
  }

  /**
   * Get connection options for BullMQ that ensure maxRetriesPerRequest is set
   * This ensures all BullMQ connections (including internal ones) have the correct setting
   * We pass the Redis instance directly, but also include maxRetriesPerRequest in case
   * BullMQ creates additional connections internally
   */
  private getConnectionOptions(): { connection: Redis } {
    // The Redis instance already has maxRetriesPerRequest: null set
    // BullMQ will use this instance, and any additional connections it creates
    // should inherit from the connection options or use the same instance
    return {
      connection: this.redis,
    };
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
    // Create PromptProcessor with reference to this QueueManager for conditional re-enqueueing
    this.promptProcessor = promptProcessor || new PromptProcessor(this);

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
          const queue = this.queueFactory(queueName, this.getConnectionOptions());
          this.queues.set(queueName, queue);

          // Recreate worker
          // Task operator queue should have concurrency=1 to prevent duplicate processing
          const defaultConcurrency = parseInt(process.env.BULLMQ_CONCURRENCY || '5', 10);
          const concurrency = queueName === 'task-operator' ? 1 : defaultConcurrency;

          const worker = this.workerFactory(
            queueName,
            async (job) => {
              logger.info('Processing agent job', { jobId: job.id, name: job.name });
              await this.promptProcessor.process(job.data as PromptJobData | AgentJobData);
            },
            {
              ...this.getConnectionOptions(),
              concurrency,
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
          const queueEvents = this.queueEventsFactory(queueName, this.getConnectionOptions());
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
      queue = this.queueFactory(name, this.getConnectionOptions());
      this.queues.set(name, queue);

      // Create worker for this queue
      // Task operator queue should have concurrency=1 to prevent duplicate processing
      const defaultConcurrency = parseInt(process.env.BULLMQ_CONCURRENCY || '5', 10);
      const concurrency = name === 'task-operator' ? 1 : defaultConcurrency;

      const worker = this.workerFactory(
        name,
        async (job) => {
          logger.info('Processing job', { jobId: job.id, name: job.name, queue: name });
          await this.promptProcessor.process(job.data as PromptJobData | AgentJobData);
        },
        {
          ...this.getConnectionOptions(),
          concurrency,
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
      const queueEvents = this.queueEventsFactory(name, this.getConnectionOptions());
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
   * Get or create a queue by name, including worker and queue events
   */
  private getOrCreateQueue(queueName: string): Queue {
    let queue = this.queues.get(queueName);
    if (!queue) {
      queue = this.queueFactory(queueName, this.getConnectionOptions());
      this.queues.set(queueName, queue);

      // Create worker for this queue if it doesn't exist
      if (!this.workers.has(queueName)) {
        logger.info('Creating worker for queue', { queueName });

        // Task operator queue should have concurrency=1 to prevent duplicate processing
        const defaultConcurrency = parseInt(process.env.BULLMQ_CONCURRENCY || '5', 10);
        const concurrency = queueName === 'task-operator' ? 1 : defaultConcurrency;

        const worker = this.workerFactory(
          queueName,
          async (job) => {
            logger.info('Worker picked up job', { jobId: job.id, name: job.name, queueName });
            await this.promptProcessor.process(job.data as PromptJobData | AgentJobData);
          },
          {
            ...this.getConnectionOptions(),
            concurrency,
          }
        );

        worker.on('completed', (job) => {
          logger.info('Agent job completed', { jobId: job.id, name: job.name, queueName });
        });

        worker.on('failed', (job, err) => {
          logger.error('Agent job failed', {
            jobId: job?.id,
            name: job?.name,
            queueName,
            error: err,
          });
        });

        worker.on('active', (job) => {
          logger.info('Agent job started processing', {
            jobId: job.id,
            name: job.name,
            queueName,
          });
        });

        this.workers.set(queueName, worker);
        logger.info('Worker created and ready', { queueName });

        // Create queue events listener
        const queueEvents = this.queueEventsFactory(queueName, this.getConnectionOptions());
        this.queueEvents.set(queueName, queueEvents);
      }
    }

    return queue;
  }

  /**
   * Add a one-time agent that executes immediately
   */
  async addOneTimeAgent(config: AgentConfig): Promise<{ id: string; name: string }> {
    const {
      name,
      targetUrl,
      method = 'POST',
      headers = {},
      body,
      timeout = 30000,
      queue = QueueManager.DEFAULT_QUEUE,
    } = config;

    const queueInstance = this.getOrCreateQueue(queue);

    // Add one-time job
    const jobData: AgentJobData = {
      agentName: name,
      targetUrl,
      method,
      headers,
      body,
      timeout,
      queue,
    };

    const job = await queueInstance.add(name, jobData, {
      jobId: `agent:${name}:${Date.now()}`,
    });

    logger.info('One-time agent added', {
      name,
      queue,
      jobId: job.id,
      targetUrl,
      method,
    });

    return { id: job.id!, name: job.name! };
  }

  /**
   * Add a delayed one-time agent that executes after a specified delay
   * Used for conditional re-enqueueing based on response conditions
   */
  async addDelayedAgent(
    config: AgentConfig & { delay: number }
  ): Promise<{ id: string; name: string }> {
    const {
      name,
      targetUrl,
      method = 'POST',
      headers = {},
      body,
      timeout = 30000,
      queue = QueueManager.DEFAULT_QUEUE,
      delay,
    } = config;

    const queueInstance = this.getOrCreateQueue(queue);

    // Add delayed job
    const jobData: AgentJobData = {
      agentName: name,
      targetUrl,
      method,
      headers,
      body,
      timeout,
      queue,
    };

    const job = await queueInstance.add(name, jobData, {
      jobId: `agent:${name}:${Date.now()}`,
      delay, // BullMQ delay in milliseconds
    });

    logger.info('Delayed agent added', {
      name,
      queue,
      jobId: job.id,
      targetUrl,
      method,
      delay: `${delay}ms`,
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
      queue = QueueManager.DEFAULT_QUEUE,
    } = config;

    if (!schedule) {
      throw new Error('Schedule is required for recurring agents');
    }

    const queueInstance = this.getOrCreateQueue(queue);

    // Add recurring job
    const repeatOptions: RepeatOptions =
      typeof schedule === 'string' ? { pattern: schedule } : schedule;

    const jobId = `agent:${name}`;

    // Remove existing repeatable job if it exists
    try {
      await queueInstance.removeRepeatableByKey(jobId);
    } catch {
      // Ignore if job doesn't exist
    }

    const jobData: AgentJobData = {
      agentName: name,
      targetUrl,
      method,
      headers,
      body,
      timeout,
      queue,
    };

    const job = await queueInstance.add(name, jobData, {
      repeat: repeatOptions,
      jobId,
    });

    logger.info('Recurring agent added', {
      name,
      queue,
      jobId: job.id,
      targetUrl,
      method,
      schedule: repeatOptions.pattern || (repeatOptions as { cron?: string }).cron || 'unknown',
    });

    return { id: job.id!, name: job.name! };
  }

  /**
   * Find which queue contains an agent by searching all queues
   */
  private async findAgentQueue(
    agentName: string
  ): Promise<{ queue: Queue; queueName: string } | null> {
    for (const [queueName, queue] of this.queues) {
      // Check repeatable jobs first (for recurring agents)
      const repeatableJobs = await queue.getRepeatableJobs();
      const jobKey = `agent:${agentName}`;
      const repeatableJob = repeatableJobs.find((j) => j.id === jobKey || j.key === jobKey);

      if (repeatableJob) {
        return { queue, queueName };
      }

      // Check waiting, active, and completed jobs
      const [waiting, active, completed] = await Promise.all([
        queue.getWaiting(0, 100),
        queue.getActive(0, 100),
        queue.getCompleted(0, 100),
      ]);

      const allJobs = [...waiting, ...active, ...completed];
      const agentJob = allJobs.find((job) => {
        if (job.name === agentName) return true;
        const jobData = job.data as AgentJobData;
        return jobData?.agentName === agentName;
      });

      if (agentJob) {
        return { queue, queueName };
      }
    }

    return null;
  }

  /**
   * Get agent status with full configuration
   */
  async getAgentStatus(name: string): Promise<AgentStatus | null> {
    const found = await this.findAgentQueue(name);
    if (!found) {
      return null;
    }

    const { queue, queueName } = found;

    // Try to get agent configuration from the most recent job
    // Check waiting, active, and completed jobs
    const [waiting, active, completed] = await Promise.all([
      queue.getWaiting(0, 100),
      queue.getActive(0, 100),
      queue.getCompleted(0, 100),
    ]);

    const allJobs = [...waiting, ...active, ...completed];
    const agentJobs = allJobs.filter((job) => {
      if (job.name === name) return true;
      const jobData = job.data as AgentJobData;
      return jobData?.agentName === name;
    });

    const recentJob = agentJobs[0];
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

    let isActive = false;
    let lastRun: Date | undefined;
    let nextRun: Date | undefined;

    if (repeatableJob) {
      isActive = true;
      nextRun = repeatableJob.next ? new Date(repeatableJob.next) : undefined;
    } else if (agentJobs.length > 0) {
      // One-time job that exists
      isActive = active.some((job) => {
        if (job.name === name) return true;
        const jobData = job.data as AgentJobData;
        return jobData?.agentName === name;
      });
    }

    // Get last completed job
    const completedAgentJob = completed.find((job) => {
      if (job.name === name) return true;
      const jobData = job.data as AgentJobData;
      return jobData?.agentName === name;
    });

    if (completedAgentJob?.finishedOn) {
      lastRun = new Date(completedAgentJob.finishedOn);
    }

    if (repeatableJob?.pattern) {
      agentConfig.schedule = repeatableJob.pattern;
    }

    return {
      name,
      isActive,
      lastRun,
      nextRun,
      jobId: repeatableJob?.id || recentJob?.id,
      queue: queueName,
      ...agentConfig,
    };
  }

  /**
   * Remove an agent from its queue
   */
  async removeAgent(name: string): Promise<void> {
    const found = await this.findAgentQueue(name);
    if (!found) {
      throw new Error(`Agent "${name}" not found`);
    }

    const { queue, queueName } = found;

    // Remove repeatable job if it exists
    const jobKey = `agent:${name}`;
    try {
      await queue.removeRepeatableByKey(jobKey);
    } catch (error) {
      logger.warn('Failed to remove repeatable job', { error, name, jobKey });
    }

    // Remove any waiting or delayed jobs for this agent
    const [waiting, delayed] = await Promise.all([
      queue.getWaiting(0, 100),
      queue.getDelayed(0, 100),
    ]);

    const allJobs = [...waiting, ...delayed];
    const agentJobs = allJobs.filter((job) => {
      if (job.name === name) return true;
      const jobData = job.data as AgentJobData;
      return jobData?.agentName === name;
    });

    for (const job of agentJobs) {
      try {
        await job.remove();
      } catch (error) {
        logger.warn('Failed to remove job', { error, jobId: job.id, name });
      }
    }

    logger.info('Agent removed', { name, queue: queueName });

    // Check if queue is now empty and should be cleaned up
    await this.checkAndCleanupEmptyQueue(queueName);
  }

  /**
   * Check if a queue is empty and optionally clean it up
   */
  private async checkAndCleanupEmptyQueue(queueName: string): Promise<void> {
    const queue = this.queues.get(queueName);
    if (!queue) {
      return;
    }

    // Don't auto-delete the default queue
    if (queueName === QueueManager.DEFAULT_QUEUE) {
      return;
    }

    // Check if queue has any jobs or agents
    const [waiting, active, delayed, repeatable] = await Promise.all([
      queue.getWaitingCount(),
      queue.getActiveCount(),
      queue.getDelayedCount(),
      queue.getRepeatableJobs(),
    ]);

    const hasJobs = waiting > 0 || active > 0 || delayed > 0 || repeatable.length > 0;

    if (!hasJobs) {
      logger.info('Queue is empty, cleaning up', { queueName });
      await this.deleteQueue(queueName);
    }
  }

  /**
   * Delete a queue and clean up all associated resources
   */
  async deleteQueue(queueName: string): Promise<void> {
    const queue = this.queues.get(queueName);
    if (!queue) {
      throw new Error(`Queue "${queueName}" not found`);
    }

    // Don't allow deleting the default queue
    if (queueName === QueueManager.DEFAULT_QUEUE) {
      throw new Error(`Cannot delete the default queue`);
    }

    // Check if queue has any active jobs
    const [waiting, active, delayed, repeatable] = await Promise.all([
      queue.getWaitingCount(),
      queue.getActiveCount(),
      queue.getDelayedCount(),
      queue.getRepeatableJobs(),
    ]);

    if (waiting > 0 || active > 0 || delayed > 0 || repeatable.length > 0) {
      throw new Error(
        `Cannot delete queue "${queueName}" - it still has jobs. Remove all agents first.`
      );
    }

    // Close and remove worker
    const worker = this.workers.get(queueName);
    if (worker) {
      await worker.close();
      this.workers.delete(queueName);
      logger.info('Worker closed', { queueName });
    }

    // Close and remove queue events
    const queueEvents = this.queueEvents.get(queueName);
    if (queueEvents) {
      await queueEvents.close();
      this.queueEvents.delete(queueName);
      logger.info('Queue events closed', { queueName });
    }

    // Close and remove queue
    await queue.close();
    this.queues.delete(queueName);
    logger.info('Queue deleted', { queueName });
  }

  /**
   * Get queue information including job counts
   */
  async getQueueInfo(queueName: string): Promise<{
    name: string;
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
    agents: string[];
  } | null> {
    const queue = this.queues.get(queueName);
    if (!queue) {
      return null;
    }

    const [waiting, active, completed, failed, delayed, repeatable] = await Promise.all([
      queue.getWaitingCount(),
      queue.getActiveCount(),
      queue.getCompletedCount(),
      queue.getFailedCount(),
      queue.getDelayedCount(),
      queue.getRepeatableJobs(),
    ]);

    // Extract agent names from repeatable jobs and recent jobs
    const agentNames = new Set<string>();

    // From repeatable jobs
    for (const job of repeatable) {
      if (job.id?.startsWith('agent:')) {
        const agentName = job.id.replace('agent:', '');
        agentNames.add(agentName);
      }
    }

    // From recent jobs
    const [recentWaiting, recentActive, recentCompleted] = await Promise.all([
      queue.getWaiting(0, 100),
      queue.getActive(0, 100),
      queue.getCompleted(0, 100),
    ]);

    const allRecentJobs = [...recentWaiting, ...recentActive, ...recentCompleted];
    for (const job of allRecentJobs) {
      if (job.name) {
        agentNames.add(job.name);
      }
      const jobData = job.data as AgentJobData;
      if (jobData?.agentName) {
        agentNames.add(jobData.agentName);
      }
    }

    return {
      name: queueName,
      waiting,
      active,
      completed,
      failed,
      delayed,
      agents: Array.from(agentNames),
    };
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
