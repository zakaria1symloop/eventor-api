import { Global, Module } from '@nestjs/common';
import { SequencesService } from './sequences.service.js';

@Global()
@Module({
  providers: [SequencesService],
  exports: [SequencesService],
})
export class SequencesModule {}
