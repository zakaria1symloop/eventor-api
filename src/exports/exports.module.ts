import { Global, Module } from '@nestjs/common';
import { AdminExportsController } from './admin-exports.controller.js';
import { ExportRegistry } from './export-registry.js';
import { ExportsService } from './exports.service.js';

/** STA-05 exports. Global so every module can register its resources with ExportRegistry. */
@Global()
@Module({
  controllers: [AdminExportsController],
  providers: [ExportRegistry, ExportsService],
  exports: [ExportRegistry],
})
export class ExportsModule {}
