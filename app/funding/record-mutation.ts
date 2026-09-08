export interface SerialRecordStore<Key, RecordValue> {
  read: (key: Key) => Promise<RecordValue | null>;
  write: (key: Key, value: RecordValue) => Promise<void>;
  clear: (key: Key) => Promise<void>;
}

export type SerialRecordUpdate<RecordValue> = (
  current: RecordValue | null,
) => RecordValue | null | undefined | Promise<RecordValue | null | undefined>;

export function createSerialRecordMutator<Key, RecordValue>(
  store: SerialRecordStore<Key, RecordValue>,
): (key: Key, update: SerialRecordUpdate<RecordValue>) => Promise<RecordValue | null> {
  const pending = new Map<Key, Promise<RecordValue | null>>();

  return (key, update) => {
    const previous = pending.get(key) ?? Promise.resolve(null);
    const mutation = previous
      .catch(() => null)
      .then(async () => {
        const current = await store.read(key);
        const next = await update(current);
        if (next === undefined) return current;
        if (next === null) {
          await store.clear(key);
          return null;
        }
        await store.write(key, next);
        return next;
      });

    pending.set(key, mutation);
    void mutation
      .finally(() => {
        if (pending.get(key) === mutation) pending.delete(key);
      })
      .catch(() => undefined);
    return mutation;
  };
}
