import fs from 'fs/promises';

export type NativeDbErrorCode =
  | 'LBUG_WAL_CORRUPT'
  | 'LBUG_FTS_UNAVAILABLE'
  | 'LBUG_VECTOR_UNAVAILABLE'
  | 'LBUG_EXTENSION_UNAVAILABLE'
  | 'LBUG_LOCKED'
  | 'LBUG_NATIVE_ERROR';

export interface NativeDbErrorInfo {
  code: NativeDbErrorCode;
  error: string;
  details?: string;
  recovery?: string;
  walRecoveryEligible: boolean;
}

export interface WalRecoveryResult {
  moved: boolean;
  walPath: string;
  corruptPath?: string;
  reason?: string;
}

export interface WalRecoveryOptions {
  cleanup?: () => Promise<void>;
  now?: () => Date;
}

export const LBUG_REINDEX_RECOVERY =
  'Remove the repository .gitnexus directory and rerun gitnexus analyze.';

export class WalRecoveryFailedError extends Error {
  constructor(
    message: string,
    readonly causeError: unknown,
  ) {
    super(message);
    this.name = 'WalRecoveryFailedError';
  }
}

const stringifyError = (err: unknown): string => {
  if (err instanceof Error) return err.message;
  return String(err);
};

export const isWalCorruptionError = (err: unknown): boolean => {
  if (err instanceof WalRecoveryFailedError) return false;
  const msg = stringifyError(err);
  return (
    /corrupted wal file/i.test(msg) ||
    /invalid WAL record type/i.test(msg) ||
    /wal_record\.cpp/i.test(msg) ||
    /UNREACHABLE_CODE/i.test(msg)
  );
};

export const classifyNativeDbError = (err: unknown): NativeDbErrorInfo | null => {
  const details = stringifyError(err);
  const lower = details.toLowerCase();

  if (err instanceof WalRecoveryFailedError) {
    return {
      code: 'LBUG_WAL_CORRUPT',
      error: 'LadybugDB WAL recovery failed.',
      details,
      recovery: LBUG_REINDEX_RECOVERY,
      walRecoveryEligible: false,
    };
  }

  if (isWalCorruptionError(err)) {
    return {
      code: 'LBUG_WAL_CORRUPT',
      error: 'LadybugDB WAL appears corrupted.',
      details,
      recovery: LBUG_REINDEX_RECOVERY,
      walRecoveryEligible: true,
    };
  }

  if (lower.includes('could not set lock') || lower.includes('database is locked')) {
    return {
      code: 'LBUG_LOCKED',
      error: 'LadybugDB is locked by another GitNexus process.',
      details,
      recovery:
        'Stop other gitnexus analyze, serve, or mcp processes for this repository and retry.',
      walRecoveryEligible: false,
    };
  }

  const hasExtensionFailure =
    lower.includes('load extension') ||
    lower.includes('extension load failed') ||
    lower.includes('extension load failure') ||
    lower.includes('extension unavailable') ||
    lower.includes('extension not found') ||
    lower.includes('failed to load extension');

  if (hasExtensionFailure) {
    if (lower.includes('vector')) {
      return {
        code: 'LBUG_VECTOR_UNAVAILABLE',
        error: 'LadybugDB VECTOR extension is unavailable.',
        details,
        recovery:
          'Semantic search will use exact-scan fallback when embeddings exist and fit the configured limit.',
        walRecoveryEligible: false,
      };
    }
    if (lower.includes('fts')) {
      return {
        code: 'LBUG_FTS_UNAVAILABLE',
        error: 'LadybugDB FTS extension is unavailable.',
        details,
        recovery:
          'Run gitnexus analyze after the native extension issue is resolved to rebuild indexes.',
        walRecoveryEligible: false,
      };
    }
    if (lower.includes('duckdb') || lower.includes('kuzu') || lower.includes('ladybug')) {
      return {
        code: 'LBUG_EXTENSION_UNAVAILABLE',
        error: 'LadybugDB native extension is unavailable.',
        details,
        recovery: 'Retry after resolving the native LadybugDB extension load failure.',
        walRecoveryEligible: false,
      };
    }
  }

  if (
    lower.includes('ladybugdb') ||
    lower.includes('duckdb') ||
    lower.includes('kuzu') ||
    lower.includes('@ladybugdb/core')
  ) {
    return {
      code: 'LBUG_NATIVE_ERROR',
      error: 'LadybugDB native layer failed.',
      details,
      recovery: 'Retry the operation. If it persists, rebuild the index with gitnexus analyze.',
      walRecoveryEligible: false,
    };
  }

  return null;
};

export const nativeDbErrorPayload = (
  err: unknown,
  fallback: string,
): { error: string; code?: NativeDbErrorCode; recovery?: string; details?: string } => {
  const classified = classifyNativeDbError(err);
  if (!classified) {
    return { error: stringifyError(err) || fallback };
  }
  return {
    error: classified.error,
    code: classified.code,
    recovery: classified.recovery,
    details: classified.details,
  };
};

export const formatNativeDbErrorForTool = (err: unknown): string => {
  const payload = nativeDbErrorPayload(err, 'LadybugDB operation failed');
  const parts = [payload.error];
  if (payload.code) parts.push(`code: ${payload.code}`);
  if (payload.recovery) parts.push(`recovery: ${payload.recovery}`);
  if (payload.details) parts.push(`details: ${payload.details}`);
  return parts.join('\n');
};

const walBackupTimestamp = (date: Date): string => date.toISOString().replace(/[:.]/g, '-');

export const moveWalAsideForRecovery = async (
  dbPath: string,
  now: () => Date = () => new Date(),
): Promise<WalRecoveryResult> => {
  const walPath = `${dbPath}.wal`;
  let stat;
  try {
    stat = await fs.lstat(walPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { moved: false, walPath, reason: 'wal not found' };
    throw err;
  }

  if (!stat.isFile()) {
    return { moved: false, walPath, reason: 'wal is not a regular file' };
  }

  const base = `${walPath}.corrupt-${walBackupTimestamp(now())}`;
  for (let i = 0; i < 10; i++) {
    const corruptPath = i === 0 ? base : `${base}-${i}`;
    try {
      await fs.lstat(corruptPath);
      continue;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw err;
    }

    try {
      await fs.rename(walPath, corruptPath);
      return { moved: true, walPath, corruptPath };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { moved: false, walPath, reason: 'wal not found' };
      throw err;
    }
  }

  throw new Error(`Unable to move corrupt WAL aside for ${dbPath}: backup name collision`);
};

export const runWithWalRecovery = async <T>(
  dbPath: string,
  operation: () => Promise<T>,
  options: WalRecoveryOptions = {},
): Promise<T> => {
  try {
    return await operation();
  } catch (firstErr) {
    if (!isWalCorruptionError(firstErr)) throw firstErr;

    await options.cleanup?.().catch(() => {});
    const recovery = await moveWalAsideForRecovery(dbPath, options.now);
    if (!recovery.moved) {
      const details = stringifyError(firstErr);
      throw new WalRecoveryFailedError(
        `LadybugDB WAL recovery failed for ${dbPath}: ${recovery.reason}. ${LBUG_REINDEX_RECOVERY} (${details})`,
        firstErr,
      );
    }

    try {
      return await operation();
    } catch (retryErr) {
      await options.cleanup?.().catch(() => {});
      const details = stringifyError(retryErr);
      throw new WalRecoveryFailedError(
        `LadybugDB WAL recovery failed for ${dbPath} after moving ${recovery.walPath} to ${recovery.corruptPath}. ${LBUG_REINDEX_RECOVERY} (${details})`,
        retryErr,
      );
    }
  }
};
