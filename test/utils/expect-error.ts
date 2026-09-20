import type { Response } from 'supertest';

/** Asserts the standard error body (api-standards §5) with this status and code. */
export function expectError(res: Response, status: number, code: string): void {
  expect({ status: res.status, code: res.body?.code }).toEqual({ status, code });
  expect(res.headers['content-type']).toMatch(/application\/json/);
  expect(Object.keys(res.body).sort()).toEqual(
    ['code', 'details', 'error', 'message', 'path', 'requestId', 'statusCode', 'timestamp'],
  );
  expect(res.body).toMatchObject({
    statusCode: status,
    error: expect.any(String),
    code,
    message: expect.any(String),
    path: expect.any(String),
    timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    requestId: expect.any(String),
  });
  expect(res.headers['x-request-id']).toBe(res.body.requestId);
}
