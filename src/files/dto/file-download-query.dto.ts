import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';
import { FileVariantKind } from '../../common/enums/file.enums.js';

export class FileDownloadQueryDto {
  @ApiPropertyOptional({ enum: FileVariantKind, example: FileVariantKind.Thumb })
  @IsOptional()
  @IsEnum(FileVariantKind)
  variant?: FileVariantKind;

  @ApiPropertyOptional({ description: 'Expiry, Unix seconds', example: 1789560000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  exp?: number;

  @ApiPropertyOptional({ description: 'HMAC signature from the API', example: 'k3v1…' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  sig?: string;
}
