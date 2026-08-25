import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

// The persisted game state has one materialized record. Its CONTENT version belongs to
// gameStore's migrations; this database version is only the IndexedDB schema version.
const DATABASE_VERSION = 1;
const STATE_STORE = 'state';
const STATE_KEY = 'game';

export const GAME_DATABASE_NAME = 'whippin-game';

export interface StoredGameState<T> {
  version: number;
  state: T;
}

interface GameDatabaseSchema extends DBSchema {
  state: {
    key: string;
    value: StoredGameState<unknown>;
  };
}

/**
 * The one persistence boundary for game state.
 *
 * A readwrite IndexedDB transaction is exclusive against every other readwrite
 * transaction touching this object store, including transactions opened by sibling tabs.
 * The updater therefore reads the latest committed value and writes its semantic mutation
 * atomically. No caller ever performs a separate read followed by a later write.
 */
export class GameStateDatabase<T> {
  readonly #database: Promise<IDBPDatabase<GameDatabaseSchema>>;

  constructor(name = GAME_DATABASE_NAME) {
    let connection: IDBPDatabase<GameDatabaseSchema> | null = null;
    this.#database = openDB<GameDatabaseSchema>(name, DATABASE_VERSION, {
      upgrade(database) {
        if (!database.objectStoreNames.contains(STATE_STORE)) {
          database.createObjectStore(STATE_STORE);
        }
      },
      // A later build may need a schema upgrade. Do not let this tab's old connection block
      // it indefinitely; the version check will reload the stale application code itself.
      blocking() {
        connection?.close();
      },
      // The reverse: OUR open is blocked by an old tab whose `blocking` handler never ran
      // (frozen, suspended). Nothing here can force that tab's connection closed — log so
      // the stall is diagnosable, and main.tsx's startup deadline turns it into the
      // visible failure instead of a permanently blank page.
      blocked() {
        console.error('Game database open is blocked by another tab holding an older version.');
      },
    }).then((database) => {
      connection = database;
      return database;
    });
  }

  async read(): Promise<StoredGameState<T> | null> {
    const database = await this.#database;
    const stored = await database.get(STATE_STORE, STATE_KEY);
    return (stored as StoredGameState<T> | undefined) ?? null;
  }

  async update(
    updater: (current: StoredGameState<T> | null) => StoredGameState<T>,
  ): Promise<StoredGameState<T>> {
    const database = await this.#database;
    const transaction = database.transaction(STATE_STORE, 'readwrite');
    try {
      const stored = await transaction.store.get(STATE_KEY);
      // `updater` is deliberately synchronous: awaiting unrelated work here would let the
      // IndexedDB transaction auto-close between its read and write.
      const next = updater((stored as StoredGameState<T> | undefined) ?? null);
      await transaction.store.put(next as StoredGameState<unknown>, STATE_KEY);
      await transaction.done;
      return next;
    } catch (error) {
      // Consume `done` on every failure path. In particular, a failed request aborts the
      // transaction and rejects both the request and `done`; leaving the latter unobserved
      // would turn an ordinary retryable storage failure into an unhandled rejection.
      try {
        transaction.abort();
      } catch {
        // It may already have auto-aborted or completed.
      }
      try {
        await transaction.done;
      } catch {
        // Preserve the request/updater error that explains the failure.
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    (await this.#database).close();
  }
}
