// WeakMap-backed cache for promises keyed by object identity.
// On rejection the entry is evicted so a retry with the same key
// gets a fresh attempt instead of a stuck rejection.
export class PromiseWeakCache<K extends object, V> {
  private _map = new WeakMap<K, Promise<V>>();

  getOrCreate(key: K, factory: () => Promise<V>): Promise<V> {
    const cached = this._map.get(key);
    if (cached) return cached;

    let promise: Promise<V>;
    try {
      promise = factory();
    } catch (syncErr) {
      return Promise.reject(syncErr);
    }
    // eslint-disable-next-line no-restricted-syntax
    const tracked = promise.catch((err: unknown) => {
      if (this._map.get(key) === tracked) {
        this._map.delete(key);
      }
      throw err;
    });
    this._map.set(key, tracked);
    return tracked;
  }
}
