import { Module } from '@nestjs/common';
import { LegalController } from './legal.controller.js';

/** Public Terms of Use and Privacy Policy (texts in Settings · Legal). */
@Module({ controllers: [LegalController] })
export class LegalModule {}
