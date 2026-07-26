// core/client-state/base-client-state-manager.ts

import { AccountOrderValue, ClientStateEntry, ClientStateStorageAdapter, InMemoryClientStateAdapter, MajikStorageAdapter } from "./storage";


export const BASE_CLIENT_STATE_KEYS = {
  ACCOUNT_ORDER: "user_account_order",
} as const;

export type BaseClientStateKey =
  (typeof BASE_CLIENT_STATE_KEYS)[keyof typeof BASE_CLIENT_STATE_KEYS];


/**
 * Base client-state manager — owned by MajikKeyClient. Knows about exactly
 * one well-known key (account order) plus a generic get/set escape hatch.
 * App-specific clients (MajikSignatureClient, future clients) extend this
 * to add their own typed keys (e.g. USER_APP_PREFERENCES) without
 * duplicating hydration/caching/adapter plumbing.
 */
export class MajikKeyClientStateManager {
  protected _cache: Map<string, string> = new Map();
  protected _adapter: ClientStateStorageAdapter;

  constructor(
    adapter: ClientStateStorageAdapter = new InMemoryClientStateAdapter(),
  ) {
    this._adapter = adapter;
  }

  get adapter(): ClientStateStorageAdapter {
    return this._adapter;
  }

  setAdapter(adapter: ClientStateStorageAdapter): void {
    this._adapter = adapter;
  }

  async hydrate(): Promise<void> {
    const entries = await this._adapter.list();
    this._cache.clear();
    for (const entry of entries) this._cache.set(entry.id, entry.value);
  }

  async get(id: string): Promise<string | null> {
    const cached = this._cache.get(id);
    if (cached !== undefined) return cached;
    const entry = await this._adapter.getById(id);
    if (!entry) return null;
    this._cache.set(id, entry.value);
    return entry.value;
  }

  async set(id: string, value: string): Promise<void> {
    await this._adapter.save({ id, value });
    this._cache.set(id, value);
  }

  async remove(id: string): Promise<boolean> {
    const removed = await this._adapter.remove(id);
    this._cache.delete(id);
    return removed;
  }

  async clear(): Promise<void> {
    await this._adapter.clear();
    this._cache.clear();
  }

  hasCached(id: string): boolean {
    return this._cache.has(id);
  }

  async exists(id: string): Promise<boolean> {
    if (this._cache.has(id)) return true;
    return this._adapter.exists(id);
  }

  listCachedEntries(): ClientStateEntry[] {
    return Array.from(this._cache.entries()).map(([id, value]) => ({
      id,
      value,
    }));
  }

  async bulkSet(entries: ClientStateEntry[]): Promise<void> {
    if (entries.length === 0) return;
    await this._adapter.bulkSave(entries);
    for (const e of entries) this._cache.set(e.id, e.value);
  }

  async count(): Promise<number> {
    return this._adapter.count();
  }

  // ── Typed: account order (shared by every Majikah app) ────────────────────

  async getAccountOrder(): Promise<AccountOrderValue | null> {
    const raw = await this.get(BASE_CLIENT_STATE_KEYS.ACCOUNT_ORDER);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as AccountOrderValue;
    } catch {
      console.warn(
        "MajikKeyClientStateManager: malformed account order — discarding.",
      );
      return null;
    }
  }

  async setAccountOrder(order: AccountOrderValue): Promise<void> {
    await this.set(BASE_CLIENT_STATE_KEYS.ACCOUNT_ORDER, JSON.stringify(order));
  }

  async removeAccountOrder(): Promise<void> {
    await this.remove(BASE_CLIENT_STATE_KEYS.ACCOUNT_ORDER);
  }
}
