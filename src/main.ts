import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { API_PREFIX, configureApp } from './app.setup.js';
import { envConfig, type Env } from './config/env.js';
import { DOCS_PATH, setupSwagger } from './config/swagger.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const env = app.get<Env>(envConfig.KEY);

  configureApp(app, env);
  if (env.SWAGGER_ENABLED) {
    setupSwagger(app);
  }

  await app.listen(env.PORT, '0.0.0.0');

  const logger = new Logger('Bootstrap');
  logger.log(`API  http://localhost:${env.PORT}${API_PREFIX}`);
  if (env.SWAGGER_ENABLED) {
    logger.log(`Docs http://localhost:${env.PORT}${DOCS_PATH}`);
  }
}

await bootstrap();
