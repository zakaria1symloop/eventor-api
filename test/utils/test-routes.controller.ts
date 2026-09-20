import { Body, Controller, Get, Post } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsInt,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import type { AuthUser } from '../../src/auth/auth.types.js';
import { CurrentUser } from '../../src/auth/decorators/current-user.decorator.js';
import { Public } from '../../src/auth/decorators/public.decorator.js';
import { Roles } from '../../src/auth/decorators/roles.decorator.js';
import { EventType } from '../../src/common/enums/catalog.enums.js';
import { UserRole } from '../../src/common/enums/user.enums.js';

class GuestsDto {
  @IsInt()
  @Min(1)
  @Max(5000)
  count: number;
}

class TestCreateDto {
  @IsString()
  @MaxLength(10)
  name: string;

  @IsEmail()
  email: string;

  @IsEnum(EventType)
  eventType: EventType;

  @ValidateNested()
  @Type(() => GuestsDto)
  guests: GuestsDto;
}

/** Test-only routes, mounted by e2e suites through createApp({ controllers }). */
@Controller('__test')
export class TestRoutesController {
  @Get('private')
  whoAmI(@CurrentUser() user: AuthUser) {
    return { data: user };
  }

  @Roles(UserRole.Admin)
  @Get('admin-only')
  adminOnly(@CurrentUser('id') id: string) {
    return { data: { id } };
  }

  @Public()
  @Post('validate')
  validate(@Body() body: TestCreateDto) {
    return { data: body };
  }

  @Public()
  @Get('boom')
  boom(): never {
    throw new Error('secret internal detail');
  }
}
