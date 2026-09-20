import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { envConfig, type Env } from '../config/env.js';
import { buildDataSourceOptions } from './database.options.js';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [envConfig.KEY],
      useFactory: (env: Env) => ({
        ...buildDataSourceOptions(env),
        retryAttempts: 5,
        retryDelay: 2000,
        // `pnpm spec:export` builds the app only to read route metadata; it must
        // not need a reachable database.
        manualInitialization: process.env.OPENAPI_EXPORT === '1',
      }),
    }),
  ],
})
export class DatabaseModule {}
