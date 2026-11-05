// Run after npm run build. This boots real Nest modules against a disposable DB.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pingvin-startup-'));
process.env.DATABASE_URL = `file:${temp}/test.db`;
process.env.DATA_DIRECTORY = temp;
process.env.CONFIG_FILE = path.join(temp, 'config.yaml');
process.env.NODE_ENV = 'test';
const timeout = setTimeout(() => { console.error('Startup timed out'); process.exit(1); }, 30000);
(async () => {
  let app;
  try {
    execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], { env: process.env });
    execFileSync(process.execPath, ['dist/prisma/seed/config.seed.js'], { env: process.env });
    const { NestFactory } = require('@nestjs/core');
    const { AppModule } = require('../dist/src/app.module');
    const { PrismaService } = require('../dist/src/prisma/prisma.service');
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
    const response = await fetch(`${await app.getUrl()}/api/health`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'OK');
    await app.get(PrismaService).$disconnect();
    console.log('Full Nest application startup and database health check passed');
  } finally {
    if (app) await app.close();
    clearTimeout(timeout);
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
