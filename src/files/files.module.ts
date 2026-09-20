import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FileVariant } from './entities/file-variant.entity.js';
import { StoredFile } from './entities/stored-file.entity.js';
import { FilesController } from './files.controller.js';
import { FilesService } from './files.service.js';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([StoredFile, FileVariant])],
  controllers: [FilesController],
  providers: [FilesService],
  exports: [FilesService],
})
export class FilesModule {}
