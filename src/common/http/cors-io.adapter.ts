import type { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { ServerOptions } from 'socket.io';

/**
 * Socket.IO adapter that applies the HTTP CORS policy (`CORS_ORIGINS`) to every
 * gateway: a `@WebSocketGateway({ cors })` option is static and cannot read the
 * validated environment.
 */
export class CorsIoAdapter extends IoAdapter {
  constructor(
    app: INestApplicationContext,
    private readonly origin: boolean | string[],
  ) {
    super(app);
  }

  override createIOServer(port: number, options?: ServerOptions) {
    return super.createIOServer(port, {
      ...options,
      cors: { origin: this.origin, credentials: true },
      // Events are small JSON payloads; files go through HTTP uploads.
      maxHttpBufferSize: 100_000,
    } as ServerOptions);
  }
}
