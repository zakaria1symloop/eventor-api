import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { Queue, Worker, type Job } from 'bullmq';
import { envConfig, type Env } from '../config/env.js';

export interface JobOptions {
  /** Total tries including the first (default 3). */
  attempts?: number;
  /** Delay before the first run, ms (BullMQ only; in-process runs immediately). */
  delay?: number;
  /** Deduplicates jobs with the same id (BullMQ). */
  jobId?: string;
}

export type JobHandler<T = unknown> = (data: T) => Promise<void> | void;

export type QueueDriver = 'bullmq' | 'inline';

export const QUEUE_NAME = 'eventor';

/**
 * One entry point for background jobs.
 *
 * - `REDIS_URL` set → BullMQ: jobs go to Redis and a worker in this process runs
 *   them with retries and exponential backoff.
 * - `REDIS_URL` empty (dev/test without Redis) → inline: `add()` runs the
 *   handler immediately in-process and awaits it, retrying up to `attempts`.
 *   Failures are logged, never thrown to the caller, as with a real queue.
 *
 * Handlers are registered by the owning module in `onModuleInit`:
 *   this.queue.registerHandler(JOBS.processImage, (data) => this.process(data));
 * Every handler must be idempotent.
 */
@Injectable()
export class QueueService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(QueueService.name);
  private readonly handlers = new Map<string, JobHandler<any>>();
  private queue: Queue | null = null;
  private worker: Worker | null = null;
  readonly driver: QueueDriver;

  constructor(@Inject(envConfig.KEY) private readonly env: Env) {
    this.driver =
      env.REDIS_URL && process.env.OPENAPI_EXPORT !== '1' ? 'bullmq' : 'inline';
  }

  onModuleInit(): void {
    if (this.driver !== 'bullmq') {
      this.logger.log('No REDIS_URL: background jobs run in-process (inline driver)');
      return;
    }
    const connection = { url: this.env.REDIS_URL };
    try {
      this.queue = new Queue(QUEUE_NAME, { connection });
      this.worker = new Worker(QUEUE_NAME, (job: Job) => this.dispatch(job.name, job.data), {
        connection,
        concurrency: 4,
      });
    } catch (error) {
      // BullMQ keeps `ioredis` as an optional peer dependency and only requires
      // it when a Redis connection is actually built, so a missing or mismatched
      // install shows up here rather than at import time. Falling back to the
      // inline driver would silently drop delayed jobs and retries in
      // production, so this is fatal on purpose: REDIS_URL asked for Redis.
      throw new Error(
        `REDIS_URL is set but the BullMQ Redis driver could not be loaded: ${
          error instanceof Error ? error.message : String(error)
        }. Install the "ioredis" package (a peer dependency of bullmq) or clear REDIS_URL to run jobs in-process.`,
        { cause: error },
      );
    }
    this.worker.on('failed', (job, error) =>
      this.logger.error(`Job ${job?.name}#${job?.id} failed: ${error.message}`, error.stack),
    );
    // A Redis that is unreachable at boot is retried by ioredis, but a wrong URL
    // or refused auth must be visible in the logs rather than swallowed.
    this.worker.on('error', (error) => this.logger.error(`Queue connection error: ${error.message}`));
    this.logger.log('BullMQ queue connected');
  }

  registerHandler<T>(name: string, handler: JobHandler<T>): void {
    if (this.handlers.has(name)) {
      throw new Error(`A handler for job "${name}" is already registered`);
    }
    this.handlers.set(name, handler as JobHandler<any>);
  }

  async add<T>(name: string, data: T, options: JobOptions = {}): Promise<void> {
    const attempts = Math.max(1, options.attempts ?? 3);

    if (this.queue) {
      await this.queue.add(name, data, {
        attempts,
        delay: options.delay,
        jobId: options.jobId,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: 1_000,
        removeOnFail: 5_000,
      });
      return;
    }

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await this.dispatch(name, data);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (attempt === attempts) {
          this.logger.error(
            `Job ${name} failed after ${attempts} attempt(s): ${message}`,
            error instanceof Error ? error.stack : undefined,
          );
        } else {
          this.logger.warn(`Job ${name} attempt ${attempt} failed: ${message}`);
        }
      }
    }
  }

  private async dispatch(name: string, data: unknown): Promise<void> {
    const handler = this.handlers.get(name);
    if (!handler) {
      throw new Error(`No handler registered for job "${name}"`);
    }
    await handler(data);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
