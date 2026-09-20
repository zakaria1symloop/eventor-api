/**
 * The BullMQ branch of QueueService, proven without a Redis server.
 *
 * `bullmq` is replaced by fakes that record how `Queue` and `Worker` are built
 * and hand back the processor function, and `ioredis` by a fake constructor, so
 * the test can assert two things a Redis-less environment never exercises:
 *
 *  - `REDIS_URL` set switches the driver to `bullmq`, builds one `Queue` and one
 *    `Worker` on `QUEUE_NAME` with the same connection, and `add()` enqueues a
 *    job (with retries and backoff) instead of running the handler inline;
 *  - the connection object handed to BullMQ is one `ioredis` accepts, and the
 *    worker's processor dispatches to the handler the owning module registered.
 *
 * The inline branch is asserted alongside it so a regression in the driver
 * choice fails here rather than in production.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeEnv, type Env } from '../config/env.js';

interface RecordedQueue {
  name: string;
  options: any;
  add: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}
interface RecordedWorker {
  name: string;
  processor: (job: { name: string; data: unknown; id?: string }) => Promise<void>;
  options: any;
  on: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

const queues: RecordedQueue[] = [];
const workers: RecordedWorker[] = [];
/** Connection options every fake Redis client was constructed with. */
const redisClients: unknown[] = [];

/**
 * Stand-in for the `ioredis` client BullMQ opens under the hood, with the same
 * contract: it accepts a URL string or an option object carrying one, and
 * throws on anything else. Nothing here dials a socket.
 */
class FakeIoRedis {
  constructor(options: unknown) {
    const url = typeof options === 'string' ? options : (options as { url?: unknown } | null)?.url;
    if (typeof url !== 'string' || !url.startsWith('redis')) {
      throw new Error(`ioredis cannot connect with ${JSON.stringify(options)}`);
    }
    redisClients.push(options);
  }
}

vi.mock('bullmq', () => ({
  Queue: class {
    add = vi.fn(async () => ({ id: '1' }));
    close = vi.fn(async () => {});
    constructor(name: string, options: any) {
      queues.push({ name, options, add: this.add, close: this.close });
      // BullMQ hands `connection` to ioredis: do the same, so the test fails if
      // QueueService ever passes something a real client would reject.
      new FakeIoRedis(options.connection);
    }
  },
  Worker: class {
    on = vi.fn();
    close = vi.fn(async () => {});
    constructor(name: string, processor: any, options: any) {
      workers.push({ name, processor, options, on: this.on, close: this.close });
      new FakeIoRedis(options.connection);
    }
  },
}));

const { QueueService, QUEUE_NAME } = await import('./queue.service.js');

const REDIS_URL = 'redis://127.0.0.1:6379';

function env(overrides: Partial<Env> = {}): Env {
  return { NODE_ENV: NodeEnv.Test, REDIS_URL: '', ...overrides } as Env;
}

beforeEach(() => {
  queues.length = 0;
  workers.length = 0;
  redisClients.length = 0;
  delete process.env.OPENAPI_EXPORT;
});

describe('QueueService (BullMQ branch)', () => {
  it('connects a queue and a worker when REDIS_URL is set', () => {
    const service = new QueueService(env({ REDIS_URL }));
    expect(service.driver).toBe('bullmq');

    service.onModuleInit();

    expect(queues).toHaveLength(1);
    expect(workers).toHaveLength(1);
    expect(queues[0]!.name).toBe(QUEUE_NAME);
    expect(workers[0]!.name).toBe(QUEUE_NAME);
    // Both halves share one connection description, and it is one ioredis takes.
    expect(queues[0]!.options.connection).toEqual({ url: REDIS_URL });
    expect(workers[0]!.options.connection).toEqual({ url: REDIS_URL });
    // One client each for the producer and the consumer, as BullMQ requires.
    expect(redisClients).toEqual([{ url: REDIS_URL }, { url: REDIS_URL }]);
    expect(workers[0]!.options.concurrency).toBe(4);
    // Failures are logged, so a dead job is visible without opening Redis.
    expect(workers[0]!.on).toHaveBeenCalledWith('failed', expect.any(Function));
  });

  it('enqueues instead of running the handler in-process', async () => {
    const service = new QueueService(env({ REDIS_URL }));
    service.onModuleInit();

    const handler = vi.fn();
    service.registerHandler('demo.job', handler);
    await service.add('demo.job', { id: 7 }, { attempts: 5, delay: 1_000, jobId: 'demo-7' });

    expect(handler).not.toHaveBeenCalled();
    expect(queues[0]!.add).toHaveBeenCalledTimes(1);
    const [name, data, options] = queues[0]!.add.mock.calls[0]!;
    expect(name).toBe('demo.job');
    expect(data).toEqual({ id: 7 });
    expect(options).toMatchObject({
      attempts: 5,
      delay: 1_000,
      jobId: 'demo-7',
      backoff: { type: 'exponential', delay: 5_000 },
    });
    expect(options.removeOnComplete).toBeGreaterThan(0);
    expect(options.removeOnFail).toBeGreaterThan(0);
  });

  it('runs the registered handler when the worker picks the job up', async () => {
    const service = new QueueService(env({ REDIS_URL }));
    service.onModuleInit();

    const handler = vi.fn(async () => {});
    service.registerHandler('demo.job', handler);
    await workers[0]!.processor({ name: 'demo.job', data: { id: 7 }, id: '1' });

    expect(handler).toHaveBeenCalledWith({ id: 7 });
  });

  it('rejects a job the worker has no handler for', async () => {
    const service = new QueueService(env({ REDIS_URL }));
    service.onModuleInit();

    await expect(workers[0]!.processor({ name: 'unknown.job', data: {} })).rejects.toThrow(
      /No handler registered/,
    );
  });

  it('closes the worker and the queue on shutdown', async () => {
    const service = new QueueService(env({ REDIS_URL }));
    service.onModuleInit();

    await service.onApplicationShutdown();

    expect(workers[0]!.close).toHaveBeenCalled();
    expect(queues[0]!.close).toHaveBeenCalled();
  });

  it('never connects during the OpenAPI export', () => {
    process.env.OPENAPI_EXPORT = '1';
    const service = new QueueService(env({ REDIS_URL }));
    service.onModuleInit();

    expect(service.driver).toBe('inline');
    expect(queues).toHaveLength(0);
    expect(redisClients).toHaveLength(0);
  });
});

describe('QueueService (inline branch)', () => {
  it('runs the handler in-process and opens no connection', async () => {
    const service = new QueueService(env());
    service.onModuleInit();
    expect(service.driver).toBe('inline');

    const handler = vi.fn(async () => {});
    service.registerHandler('demo.job', handler);
    await service.add('demo.job', { id: 7 });

    expect(handler).toHaveBeenCalledWith({ id: 7 });
    expect(queues).toHaveLength(0);
    expect(redisClients).toHaveLength(0);
  });

  it('retries a failing handler and swallows the final failure', async () => {
    const service = new QueueService(env());
    service.onModuleInit();

    const handler = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined);
    service.registerHandler('demo.job', handler);

    await expect(service.add('demo.job', {}, { attempts: 2 })).resolves.toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(2);
  });
});
