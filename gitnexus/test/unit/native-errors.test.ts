import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyNativeDbError,
  moveWalAsideForRecovery,
  runWithWalRecovery,
} from '../../src/core/lbug/native-errors.js';

const tempDirs: string[] = [];

const makeTempDir = async (): Promise<string> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-native-errors-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('native DB error classification', () => {
  it.each([
    'Runtime exception: Corrupted wal file',
    'Read out invalid WAL record type',
    'Assertion failed in file "/__w/ladybug/ladybug/src/storage/wal/wal_record.cpp"',
    'Assertion failed: UNREACHABLE_CODE',
  ])('classifies WAL corruption pattern: %s', (message) => {
    const classified = classifyNativeDbError(new Error(message));

    expect(classified?.code).toBe('LBUG_WAL_CORRUPT');
    expect(classified?.walRecoveryEligible).toBe(true);
    expect(classified?.recovery).toContain('Remove the repository .gitnexus directory');
  });

  it('does not treat plain VECTOR extension load failure as WAL corruption', () => {
    const classified = classifyNativeDbError(
      new Error('GitNexus: VECTOR extension load failed: Extension "vector" not found'),
    );

    expect(classified?.code).toBe('LBUG_VECTOR_UNAVAILABLE');
    expect(classified?.walRecoveryEligible).toBe(false);
  });

  it('does not treat plain FTS extension load failure as WAL corruption', () => {
    const classified = classifyNativeDbError(
      new Error('FTS extension load failure: Extension "fts" not found'),
    );

    expect(classified?.code).toBe('LBUG_FTS_UNAVAILABLE');
    expect(classified?.walRecoveryEligible).toBe(false);
  });
});

describe('WAL sidecar recovery helpers', () => {
  it('moves only the sidecar .wal file aside', async () => {
    const dir = await makeTempDir();
    const dbPath = path.join(dir, 'lbug');
    await fs.writeFile(dbPath, 'db');
    await fs.writeFile(`${dbPath}.wal`, 'wal');

    const result = await moveWalAsideForRecovery(dbPath, () => new Date('2026-05-03T12:00:00Z'));

    expect(result.moved).toBe(true);
    expect(result.corruptPath).toBe(`${dbPath}.wal.corrupt-2026-05-03T12-00-00-000Z`);
    await expect(fs.readFile(dbPath, 'utf-8')).resolves.toBe('db');
    await expect(fs.readFile(result.corruptPath!, 'utf-8')).resolves.toBe('wal');
    await expect(fs.stat(`${dbPath}.wal`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retries once after moving a corrupt WAL aside', async () => {
    const dir = await makeTempDir();
    const dbPath = path.join(dir, 'lbug');
    await fs.writeFile(dbPath, 'db');
    await fs.writeFile(`${dbPath}.wal`, 'wal');
    let attempts = 0;

    const result = await runWithWalRecovery(
      dbPath,
      async () => {
        attempts++;
        if (attempts === 1) {
          throw new Error('Runtime exception: Corrupted wal file');
        }
        return 'opened';
      },
      { now: () => new Date('2026-05-03T12:00:00Z') },
    );

    expect(result).toBe('opened');
    expect(attempts).toBe(2);
    await expect(
      fs.readFile(`${dbPath}.wal.corrupt-2026-05-03T12-00-00-000Z`, 'utf-8'),
    ).resolves.toBe('wal');
  });

  it('does not retry or move WAL for plain extension unavailability', async () => {
    const dir = await makeTempDir();
    const dbPath = path.join(dir, 'lbug');
    await fs.writeFile(`${dbPath}.wal`, 'wal');
    let attempts = 0;

    await expect(
      runWithWalRecovery(dbPath, async () => {
        attempts++;
        throw new Error('VECTOR extension load failed: Extension "vector" not found');
      }),
    ).rejects.toThrow('VECTOR extension load failed');

    expect(attempts).toBe(1);
    await expect(fs.readFile(`${dbPath}.wal`, 'utf-8')).resolves.toBe('wal');
  });
});
