import { Global, Module } from '@nestjs/common';
import { pushProvider, PushService } from './push.service.js';

/** Push to phones: FCM HTTP v1 when `FCM_CREDENTIALS_PATH` is set, a logging stub otherwise. */
@Global()
@Module({
  providers: [pushProvider, PushService],
  exports: [PushService],
})
export class PushModule {}
