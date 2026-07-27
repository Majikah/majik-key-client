/**
 * MajikKeyClient.ts
 *
 * Root class for all Majikah app clients (MajikSignatureClient, MajikBuwizClient,
 * and future ones). Centralizes MajikKey account management — creation, import,
 * lock/unlock, passphrase, active-account tracking, and account ordering — so
 * every subclass gets identical, uniform key-management behavior for free.
 *
 * Deliberately does NOT manage contacts. Every Majikah app has a different
 * contact directory shape (MajikContactManager, MajikInvoiceContactManager,
 * etc.), so subclasses own their own directory and sync into it via the
 * three hook methods below.
 */

import { MajikKey, MajikKeyFingerprint } from "@majikah/majik-key";
import { MnemonicLanguage } from "@majikah/majik-key/dist/core/crypto/wordlist";

import { MajikKeyManager } from "./core/crypto/keystore-manager";
import { MajikKeyStorageAdapter } from "./core/storage/keystore/_types";
import { InMemoryKeystoreAdapter } from "./core/storage/keystore/adapter-memory";

import { ClientStateStorageAdapter, SQLiteDatabase } from "./core/storage";
import { InMemoryClientStateAdapter } from "./core/storage/client-state/adapter-memory";
import { MajikKeyClientStateManager } from "./core/client-state-manager";

// ─── Error ────────────────────────────────────────────────────────────────────

export class MajikKeyClientError extends Error {
  cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "MajikKeyClientError";
    this.cause = cause;
  }
}

// ─── Contact contract ─────────────────────────────────────────────────────────

/**
 * The minimum shape MajikKeyClient needs from a subclass's contact type.
 * MajikContact and MajikInvoiceContact both satisfy this structurally —
 * no changes needed to either.
 */
export interface MajikKeyClientContact {
  id: string;
  meta?: { label?: string };
}

// ─── Events ───────────────────────────────────────────────────────────────────

export type MajikKeyClientBaseEvents =
  | "new-account"
  | "removed-account"
  | "updated-account"
  | "active-account-change"
  | "unlock"
  | "lock"
  | "error"
  | "restore-backup";

const MAJIK_KEY_CLIENT_BASE_EVENTS: MajikKeyClientBaseEvents[] = [
  "new-account",
  "removed-account",
  "updated-account",
  "active-account-change",
  "unlock",
  "lock",
  "error",
  "restore-backup",
];

type EventCallback = (...args: any[]) => void;

// ─── Config ───────────────────────────────────────────────────────────────────

export interface MajikKeyClientConfig {
  dbSQL?: SQLiteDatabase;

  /**
   * Pre-constructed key manager. If provided, adapters.keys is ignored.
   * Pass the same instance across clients (Signature/Buwiz/etc.) to share
   * a single keystore.
   */
  keyManager?: MajikKeyManager;

  /**
   * Pre-constructed client state manager. If provided, adapters.clientState
   * is ignored.
   */
  clientStateManager?: MajikKeyClientStateManager;

  adapters?: {
    keys?: MajikKeyStorageAdapter;
    clientState?: ClientStateStorageAdapter;
  };
}

// ─── MajikKeyClient ─────────────────────────────────────────────────────────────

export abstract class MajikKeyClient<
  TContact extends MajikKeyClientContact,
  TContactMeta = unknown,
  TEvents extends string = MajikKeyClientBaseEvents,
  TStateManager extends MajikKeyClientStateManager = MajikKeyClientStateManager,
> {
  protected _db: SQLiteDatabase | null;

  protected _keys: MajikKeyManager;
  protected _state: TStateManager;

  protected _ownAccounts: Map<string, TContact> = new Map();
  protected _ownAccountsOrder: string[] = [];

  protected _listeners: Map<TEvents, EventCallback[]> = new Map();

  private _autosaveOrderTimer: number | null = null;

  constructor(config: MajikKeyClientConfig = {}) {
    this._db = config.dbSQL ?? null;

    this._keys =
      config.keyManager ??
      new MajikKeyManager(
        config.adapters?.keys ?? new InMemoryKeystoreAdapter(),
      );

    this._state =
      (config.clientStateManager as TStateManager | undefined) ??
      this._createDefaultStateManager(config.adapters?.clientState);

    this._registerEventNames(
      MAJIK_KEY_CLIENT_BASE_EVENTS as unknown as TEvents[],
    );
  }

  // ── Getters ───────────────────────────────────────────────────────────────

  get keyManager(): MajikKeyManager {
    return this._keys;
  }

  /**
   * Override in subclasses that use a richer state manager (e.g. Signature's
   * ClientStateManager) so the default instance matches TStateManager.
   */
  protected _createDefaultStateManager(
    adapter?: ClientStateStorageAdapter,
  ): TStateManager {
    return new MajikKeyClientStateManager(
      adapter ?? new InMemoryClientStateAdapter(),
    ) as TStateManager;
  }

  get stateManager(): TStateManager {
    return this._state;
  }

  // ==========================================================================
  // ── ABSTRACT HOOKS — implemented by every subclass ───────────────────────
  // ==========================================================================

  /**
   * Build this subclass's contact type from a freshly created/imported key.
   * Signature: `key.toContact<TMeta>(meta)`.
   * A future Buwiz-style client: wrap with party metadata.
   */
  protected abstract _buildOwnAccountContact(
    key: MajikKey,
    meta?: Partial<TContactMeta>,
  ): TContact;

  /**
   * Called after a key-derived contact is registered as an own account.
   * Subclass syncs it into its own contact directory here (add-if-absent).
   */
  protected abstract _onAccountRegistered(
    contact: TContact,
  ): void | Promise<void>;

  /**
   * Called when an own account is removed. Subclass removes it from its
   * own contact directory here.
   */
  protected abstract _onAccountRemoved(id: string): void | Promise<void>;

  /**
   * Optional extra cleanup hook for resetData(). No-op by default —
   * override to clear contacts/stamps/invoices/etc. alongside key data.
   */
  protected async _onResetKeyData(): Promise<void> {
    // no-op by default
  }

  // ==========================================================================
  // ── HYDRATION ──────────────────────────────────────────────────────────────
  // ==========================================================================

  /**
   * Default hydration: keys → state → own accounts → account order.
   * Subclasses with extra domains (contacts, stamps, invoices) should
   * override hydrate() and call the granular _hydrate* pieces themselves
   * in the correct order — own-account hydration depends on the subclass's
   * contact directory already being hydrated (see _onAccountRegistered).
   */
  async hydrate(): Promise<void> {
    await this._hydrateKeys();
    await this._hydrateState();
    await this._hydrateOwnAccounts();
    await this._restoreAccountOrder();
  }

  protected async _hydrateKeys(): Promise<void> {
    await this._keys.hydrate();
  }

  protected async _hydrateState(): Promise<void> {
    await this._state.hydrate();
  }

  protected async _hydrateOwnAccounts(): Promise<void> {
    const keys = this._keys.list();
    for (const key of keys) {
      if (this._ownAccounts.has(key.id)) continue;
      try {
        const contact = this._buildOwnAccountContact(key);
        await this._onAccountRegistered(contact);
        this._ownAccounts.set(key.id, contact);
        if (!this._ownAccountsOrder.includes(key.id)) {
          this._ownAccountsOrder.push(key.id);
        }
      } catch (err) {
        console.warn(
          `MajikKeyClient: failed to hydrate own account "${key.id}":`,
          err,
        );
      }
    }
  }

  protected async _restoreAccountOrder(): Promise<void> {
    try {
      const saved = await this._state.getAccountOrder();
      if (saved) {
        const valid = saved.filter((id) => this._ownAccounts.has(id));
        const appended = this._ownAccountsOrder.filter(
          (id) => !valid.includes(id),
        );
        this._ownAccountsOrder = [...valid, ...appended];
      }
    } catch {
      // Non-fatal — order defaults to insertion order from _hydrateOwnAccounts
    }
  }

  protected _scheduleOrderSave(): void {
    if (this._autosaveOrderTimer !== null) {
      window.clearTimeout(this._autosaveOrderTimer);
    }
    this._autosaveOrderTimer = window.setTimeout(() => {
      void this._persistAccountOrder();
      this._autosaveOrderTimer = null;
    }, 300) as unknown as number;
  }

  protected async _persistAccountOrder(): Promise<void> {
    try {
      await this._state.setAccountOrder(this._ownAccountsOrder);
    } catch (err) {
      console.warn("MajikKeyClient: failed to persist account order:", err);
    }
  }

  // ==========================================================================
  // ── ACCOUNT MANAGEMENT ────────────────────────────────────────────────────
  // ==========================================================================

  async generateMnemonic(
    strength: 128 | 256 = 128,
    language: MnemonicLanguage = "en",
  ): Promise<string> {
    return MajikKeyManager.generateMnemonic(strength, language);
  }

  async createAccount(
    mnemonic: string,
    passphrase: string,
    label?: string,
    meta?: Partial<TContactMeta>,
    mnemonicLanguage: MnemonicLanguage = "en",
  ): Promise<{ id: string; fingerprint: MajikKeyFingerprint; backup: string }> {
    try {
      const key = await MajikKey.create(mnemonic, passphrase, label, {
        mnemonicLanguage: mnemonicLanguage,
      });
      await this._keys.save(key);
      const contact = this._buildOwnAccountContact(key, meta);
      this._registerOwnAccount(contact);
      this._emitBase("new-account", contact);
      return { id: key.id, fingerprint: key.fingerprint, backup: key.backup };
    } catch (err) {
      this._emitBase("error", err, { context: "createAccount" });
      throw err;
    }
  }

  async importAccountFromMnemonicBackup(
    backupBase64: string,
    mnemonic: string,
    passphrase: string,
    label?: string,
    meta?: Partial<TContactMeta>,
  ): Promise<{ id: string; fingerprint: MajikKeyFingerprint }> {
    try {
      const key = await this._keys.importFromMnemonicBackup(
        backupBase64,
        mnemonic,
        passphrase,
        label,
      );
      if (this.getOwnAccountById(key.id)) {
        throw new MajikKeyClientError(
          "Account with the same ID already exists",
        );
      }
      const contact = this._buildOwnAccountContact(key, meta);
      this._registerOwnAccount(contact);
      this._emitBase("new-account", contact);
      return { id: key.id, fingerprint: key.fingerprint };
    } catch (err) {
      this._emitBase("error", err, {
        context: "importAccountFromMnemonicBackup",
      });
      throw err;
    }
  }

  async replaceAccountFromMnemonicBackup(
    backupBase64: string,
    mnemonic: string,
    passphrase: string,
    label?: string,
    meta?: Partial<TContactMeta>,
  ): Promise<{ id: string; fingerprint: MajikKeyFingerprint }> {
    try {
      const currentAccount = this.getActiveAccountKey();
      const currentContact = this.getActiveAccount();
      const finalLabel = label?.trim() || currentContact?.meta?.label;

      // 1. Import first (no mutation yet)
      const key = await this._keys.importFromMnemonicBackup(
        backupBase64,
        mnemonic,
        passphrase,
        finalLabel,
      );

      // 2. Prevent duplicate (except self-replace)
      if (this.getOwnAccountById(key.id) && key.id !== currentAccount?.id) {
        throw new MajikKeyClientError(
          "Account with the same ID already exists",
        );
      }

      const contact = this._buildOwnAccountContact(key, meta);

      // 3. Remove old account if different
      if (currentAccount && currentAccount.id !== key.id) {
        await this.removeOwnAccount(currentAccount.id);
      }

      // 4. Register new + set active
      this._registerOwnAccount(contact);
      await this.setActiveAccount(contact.id, true);

      this._emitBase("new-account", contact);
      return { id: key.id, fingerprint: key.fingerprint };
    } catch (err) {
      this._emitBase("error", err, {
        context: "replaceAccountFromMnemonicBackup",
      });
      throw err;
    }
  }

  async exportAccountMnemonicBackup(
    id: string,
    mnemonic: string,
  ): Promise<string> {
    return this._keys.exportMnemonicBackup(id, mnemonic);
  }

  addOwnAccount(account: TContact): void {
    this._registerOwnAccount(account);
    this._emitBase("new-account", account);
  }

  async removeOwnAccount(id: string): Promise<boolean> {
    if (!this._ownAccounts.has(id)) return false;
    this._ownAccounts.delete(id);
    const idx = this._ownAccountsOrder.indexOf(id);
    if (idx > -1) this._ownAccountsOrder.splice(idx, 1);
    await this._onAccountRemoved(id);
    await this._keys.delete(id);
    this._scheduleOrderSave();
    this._emitBase("removed-account", id);
    return true;
  }

  /**
   * Rename an account's key label and keep the in-memory contact's
   * meta.label in sync. Does not touch the subclass's contact directory —
   * call updateContactMeta() there too if the directory needs updating.
   */
  async updateAccountLabel(id: string, newLabel: string): Promise<void> {
    await this._keys.updateLabel(id, newLabel);
    const contact = this._ownAccounts.get(id);
    if (contact) {
      const updated = {
        ...contact,
        meta: { ...contact.meta, label: newLabel },
      };
      this._ownAccounts.set(id, updated as TContact);
      this._emitBase("updated-account", updated);
    }
  }

  getOwnAccountById(id: string): TContact | undefined {
    return this._ownAccounts.get(id);
  }

  getActiveAccount(): TContact | null {
    if (!this._ownAccountsOrder.length) return null;
    return this._ownAccounts.get(this._ownAccountsOrder[0]) ?? null;
  }

  getActiveAccountKey(): MajikKey | null {
    if (!this._ownAccountsOrder.length) return null;
    return this._keys.get(this._ownAccountsOrder[0]) ?? null;
  }

  isAccountActive(id: string): boolean {
    return this._ownAccounts.has(id) && this._ownAccountsOrder[0] === id;
  }

  async setActiveAccount(id: string, bypassIdentity = false): Promise<boolean> {
    if (!this._ownAccounts.has(id)) return false;
    if (!bypassIdentity) {
      try {
        await this.ensureIdentityUnlocked(id);
      } catch {
        return false;
      }
    }
    const previousActive = this.getActiveAccount()?.id;
    const index = this._ownAccountsOrder.indexOf(id);
    if (index > -1) this._ownAccountsOrder.splice(index, 1);
    this._ownAccountsOrder.unshift(id);
    this._scheduleOrderSave();
    if (previousActive !== id) {
      this._emitBase(
        "active-account-change",
        this.getActiveAccount(),
        previousActive,
      );
    }
    return true;
  }

  listOwnAccounts(): TContact[] {
    return this._ownAccountsOrder
      .map((id) => this._ownAccounts.get(id))
      .filter((c): c is TContact => !!c);
  }

  async unlockAccount(id: string, passphrase: string): Promise<void> {
    try {
      await this._keys.unlock(id, passphrase);
      this._emitBase("unlock", id);
    } catch (err) {
      this._emitBase("error", err, { context: "unlockAccount", id });
      throw err;
    }
  }

  lockAccount(id: string): void {
    this._keys.lock(id);
    this._emitBase("lock", id);
  }

  lockAllAccounts(): void {
    this._keys.lockAll();
    for (const id of this._ownAccountsOrder) this._emitBase("lock", id);
  }

  async verifyPassphrase(id: string, passphrase: string): Promise<boolean> {
    return this._keys.isPassphraseValid(id, passphrase);
  }

  async updatePassphrase(
    id: string,
    currentPassphrase: string,
    newPassphrase: string,
  ): Promise<void> {
    try {
      await this._keys.updatePassphrase(id, currentPassphrase, newPassphrase);
    } catch (err) {
      this._emitBase("error", err, { context: "updatePassphrase", id });
      throw err;
    }
  }

  async replacePassphrase(
    backup: string,
    mnemonic: string,
    newPassphrase: string,
    id: string,
    label?: string,
  ): Promise<MajikKey> {
    try {
      return await this._keys.replacePassphrase(
        backup,
        mnemonic,
        newPassphrase,
        id,
        label,
      );
    } catch (err) {
      this._emitBase("error", err, { context: "replacePassphrase", id });
      throw err;
    }
  }

  async ensureIdentityUnlocked(
    id: string,
    promptFn?: (id: string) => string | Promise<string>,
  ): Promise<CryptoKey | { raw: Uint8Array }> {
    return this._keys.ensureUnlocked(id, promptFn);
  }

  async isPassphraseValid(passphrase: string, id?: string): Promise<boolean> {
    const target = id ? this.getOwnAccountById(id) : this.getActiveAccount();
    if (!target) return false;
    return this._keys.isPassphraseValid(target.id, passphrase);
  }

  hasSigningCapability(accountId?: string): boolean {
    const id = accountId ?? this.getActiveAccount()?.id;
    if (!id) return false;
    return this._keys.get(id)?.hasSigningKeys === true;
  }

  // ==========================================================================
  // ── RESET ─────────────────────────────────────────────────────────────────
  // ==========================================================================

  /**
   * Wipe key + client-state data and reset in-memory account tracking.
   * Subclasses should override to also clear their own domains — call
   * super.resetData() (or just this._resetKeyData()) as part of that.
   */
  async resetData(): Promise<void> {
    try {
      await this._onResetKeyData();
      await this._keys.adapter.clear();
      await this._state.clear();

      if (this._db) {
        await this._db.vacuum();
        await this._db.optimize();
      }

      this._ownAccounts.clear();
      this._ownAccountsOrder = [];
      this._keys = new MajikKeyManager(this._keys.adapter);

      this._emitBase("active-account-change", null);
    } catch (err) {
      throw new MajikKeyClientError(
        `Failed to reset key data: ${err instanceof Error ? err.message : err}`,
        err,
      );
    }
  }

  // ==========================================================================
  // ── PRIVATE / PROTECTED HELPERS ───────────────────────────────────────────
  // ==========================================================================

  protected _registerOwnAccount(contact: TContact): void {
    if (!this._ownAccounts.has(contact.id)) {
      this._ownAccounts.set(contact.id, contact);
      this._ownAccountsOrder.push(contact.id);
      this._scheduleOrderSave();
    }
    void this._onAccountRegistered(contact);
    if (!this.getActiveAccount()) {
      void this.setActiveAccount(contact.id, true);
    }
  }

  // ==========================================================================
  // ── EVENTS ────────────────────────────────────────────────────────────────
  // ==========================================================================

  protected _registerEventNames(names: TEvents[]): void {
    for (const name of names) {
      if (!this._listeners.has(name)) this._listeners.set(name, []);
    }
  }

  on(event: TEvents, callback: EventCallback): void {
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event)!.push(callback);
  }

  off(event: TEvents, callback?: EventCallback): void {
    const cbs = this._listeners.get(event);
    if (!cbs?.length) return;
    if (callback) {
      const i = cbs.indexOf(callback);
      if (i !== -1) cbs.splice(i, 1);
    } else {
      this._listeners.set(event, []);
    }
  }

  protected _emit(event: TEvents, ...args: unknown[]): void {
    this._listeners.get(event)?.forEach((cb) => {
      try {
        cb(...args);
      } catch (err) {
        console.warn(`MajikKeyClient event handler error (${event}):`, err);
      }
    });
  }

  /** Emit a base event without the caller having to cast to TEvents. */
  protected _emitBase(
    event: MajikKeyClientBaseEvents,
    ...args: unknown[]
  ): void {
    this._emit(event as unknown as TEvents, ...args);
  }
}
