import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retryDelay } from '../src/retry.js';
import { parseConfig } from '../src/config.js';

test('retryDelay doubles from the base and caps at the maximum', () => {
  assert.equal(retryDelay(1), 500);
  assert.equal(retryDelay(2), 1000);
  assert.equal(retryDelay(3), 2000);
  assert.equal(retryDelay(50), 30_000);
});

test('parseConfig applies defaults for optional settings', () => {
  const config = parseConfig({
    DATABASE_URL: 'postgres://app:app@localhost:5432/showcase',
    COUCH_URL: 'http://couchdb:5984',
    COUCH_DB: 'shop',
  });
  assert.deepEqual(config, {
    couchUrl: 'http://couchdb:5984',
    couchDb: 'shop',
    couchUser: undefined,
    couchPassword: undefined,
    databaseUrl: 'postgres://app:app@localhost:5432/showcase',
    batchSize: 500,
    pollTimeoutMs: 10_000,
    port: 8090,
  });
});

test('parseConfig reads numeric overrides and fails fast without DATABASE_URL', () => {
  const config = parseConfig({
    DATABASE_URL: 'postgres://x',
    COUCH_URL: 'http://c',
    COUCH_DB: 'd',
    BATCH_SIZE: '100',
    PORT: '9000',
  });
  assert.equal(config.batchSize, 100);
  assert.equal(config.port, 9000);
  assert.throws(() => parseConfig({ COUCH_URL: 'http://c', COUCH_DB: 'd' }), /DATABASE_URL/);
});
