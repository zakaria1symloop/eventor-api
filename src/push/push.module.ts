import { Global, Module } from '@nestjs/common';
import { pushProvider, PushService } from './push.service.js';

/** FCM push. Currently a logging stub (PushProvider interface ready for FCM HTTP v1). */
@Global()
@Module({
  providers: [pushProvider, PushService],
  exports: [PushService],
})
export class PushModule {}
