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

/**
 * Error type thrown by {@link MajikKeyClient} when a client-level operation
 * cannot be completed.
 *
 * @remarks
 * The original error is preserved in {@link MajikKeyClientError.cause} when
 * one is available. This makes it possible for applications to distinguish
 * a client orchestration failure from the underlying cryptographic,
 * persistence, or storage error.
 *
 * @example
 * ```ts
 * try {
 *   await client.resetData();
 * } catch (error) {
 *   if (error instanceof MajikKeyClientError) {
 *     console.error(error.message, error.cause);
 *   }
 * }
 * ```
 */
export class MajikKeyClientError extends Error {
  /**
   * The original underlying error, when the client wrapped an existing error.
   */
  cause?: unknown;

  /**
   * Creates a new client-level error.
   *
   * @param message Human-readable description of the failure.
   * @param cause Optional underlying error that triggered the client-level error.
   */
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
/**
 * Minimum contact contract required by {@link MajikKeyClient}.
 *
 * @remarks
 * Subclasses can use any richer contact shape they need as long as it contains
 * a stable string `id`. The optional `meta.label` field is used by the base
 * client when synchronizing account labels.
 *
 * @example
 * ```ts
 * interface MyContact extends MajikKeyClientContact {
 *   email: string;
 *   role: "owner" | "admin";
 * }
 * ```
 */
export interface MajikKeyClientContact {
  /**
   * Stable identifier for the account/contact.
   *
   * @remarks
   * This value is used as the account key throughout the client, including
   * ordering, active-account tracking, key-store lookup, and removal.
   */
  id: string;

  /**
   * Optional application metadata associated with the contact.
   */
  meta?: {
    /**
     * User-facing label for the account.
     *
     * @remarks
     * The base client keeps this value synchronized with the underlying
     * `MajikKey` label when {@link MajikKeyClient.updateAccountLabel} is used.
     */
    label?: string;
  };
}

// ─── Events ───────────────────────────────────────────────────────────────────

/**
 * Events emitted by the base {@link MajikKeyClient} implementation.
 *
 * @remarks
 * Subclasses can extend this union with application-specific events through
 * the `TEvents` generic parameter.
 *
 * Base events and their emitted argument shapes are:
 * - `new-account`: `(contact)`
 * - `removed-account`: `(accountId)`
 * - `updated-account`: `(contact)`
 * - `active-account-change`: `(activeContact, previousAccountId)`
 * - `unlock`: `(accountId)`
 * - `lock`: `(accountId)`
 * - `error`: `(error, context)`
 * - `restore-backup`: reserved for backup-restore flows.
 */
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

/**
 * Internal event callback signature used by {@link MajikKeyClient}.
 *
 * @remarks
 * Event payloads are intentionally open-ended at the base class level so
 * subclasses can define richer event contracts on top of `TEvents`.
 */
type EventCallback = (...args: any[]) => void;

// ─── Config ───────────────────────────────────────────────────────────────────

/**
 * Construction options for {@link MajikKeyClient}.
 *
 * @remarks
 * All dependencies are optional. When omitted, the client creates in-memory
 * storage adapters and a default {@link MajikKeyClientStateManager}.
 *
 * @example
 * ```ts
 * const client = new MyClient({
 *   adapters: {
 *     keys: myKeyStorageAdapter,
 *     clientState: myStateStorageAdapter,
 *   },
 * });
 * ```
 */
export interface MajikKeyClientConfig {
  /**
   * Optional SQLite database used for client-level maintenance during
   * {@link MajikKeyClient.resetData}.
   */
  dbSQL?: SQLiteDatabase;

  /**
   * Pre-constructed key manager. If provided, adapters.keys is ignored.
   * Pass the same instance across clients (Signature/Buwiz/etc.) to share
   * a single keystore.
   */
  keyManager?: MajikKeyManager;

  /**
   * Pre-constructed client state manager. If provided,
   * `adapters.clientState` is ignored.
   *
   * @remarks
   * Supplying the same state manager instance to multiple clients is useful
   * when they intentionally share persisted account ordering or state.
   */
  clientStateManager?: MajikKeyClientStateManager;

  /**
   * Storage adapters used when pre-constructed manager instances are not
   * supplied.
   *
   * @remarks
   * Both adapters default to in-memory implementations, which makes the base
   * client usable without external persistence.
   */
  adapters?: {
    /**
     * Key-store adapter used to construct the default {@link MajikKeyManager}.
     */
    keys?: MajikKeyStorageAdapter;

    /**
     * Client-state adapter used to construct the default
     * {@link MajikKeyClientStateManager}.
     */
    clientState?: ClientStateStorageAdapter;
  };
}

// ─── MajikKeyClient ─────────────────────────────────────────────────────────────

/**
 * Abstract root client for Majikah applications that manage Majik Key
 * identities.
 *
 * @remarks
 * `MajikKeyClient` centralizes account lifecycle management so application
 * clients do not need to duplicate key creation, backup import/export,
 * locking, unlocking, active-account tracking, ordering, state hydration,
 * or account events.
 *
 * The class deliberately does **not** own the application's contact
 * directory. Subclasses provide their contact representation through
 * {@link MajikKeyClient._buildOwnAccountContact} and synchronize that
 * representation through the account lifecycle hooks.
 *
 * The default storage strategy is in-memory. Applications that require
 * persistence should provide appropriate adapters through
 * {@link MajikKeyClientConfig} or pass pre-constructed managers.
 *
 * @typeParam TContact Contact representation owned by the concrete client.
 * Must satisfy {@link MajikKeyClientContact}.
 * @typeParam TContactMeta Metadata accepted by the contact builder hook.
 * Defaults to `unknown`.
 * @typeParam TEvents Complete event-name union supported by the concrete
 * client. Defaults to {@link MajikKeyClientBaseEvents}.
 * @typeParam TStateManager Concrete client-state manager used by the client.
 * Defaults to {@link MajikKeyClientStateManager}.
 *
 * @example
 * ```ts
 * interface MyContact extends MajikKeyClientContact {
 *   email: string;
 * }
 *
 * class MyClient extends MajikKeyClient<MyContact, { role?: string }> {
 *   protected _buildOwnAccountContact(
 *     key: MajikKey,
 *     meta?: Partial<{ role?: string }>,
 *   ): MyContact {
 *     return {
 *       id: key.id,
 *       email: "owner@example.com",
 *       meta: { label: key.label, ...meta },
 *     };
 *   }
 *
 *   protected _onAccountRegistered(contact: MyContact): void {
 *     // Synchronize with the application's contact store.
 *   }
 *
 *   protected _onAccountRemoved(id: string): void {
 *     // Remove from the application's contact store.
 *   }
 * }
 * ```
 */
export abstract class MajikKeyClient<
  TContact extends MajikKeyClientContact,
  TContactMeta = unknown,
  TEvents extends string = MajikKeyClientBaseEvents,
  TStateManager extends MajikKeyClientStateManager = MajikKeyClientStateManager,
> {
  /**
   * Optional SQLite database used for reset-time maintenance.
   * @internal
   */
  protected _db: SQLiteDatabase | null;

  /**
   * Key manager responsible for Majik Key lifecycle and persistence.
   * @internal
   */
  protected _keys: MajikKeyManager;

  /**
   * Client-state manager responsible for persisted client state.
   * @internal
   */
  protected _state: TStateManager;

  /**
   * In-memory map of own-account contacts keyed by account ID.
   * @internal
   */
  protected _ownAccounts: Map<string, TContact> = new Map();

  /**
   * Ordered own-account IDs. The first entry represents the active account.
   * @internal
   */
  protected _ownAccountsOrder: string[] = [];

  /**
   * Event listener registry for the client.
   * @internal
   */
  protected _listeners: Map<TEvents, EventCallback[]> = new Map();

  /**
   * Debounce timer used for account-order persistence.
   * @internal
   */
  private _autosaveOrderTimer: number | null = null;

  /**
   * Creates a new Majikah application client.
   *
   * @param config Client dependencies, persistence adapters, and optional
   * pre-constructed managers.
   *
   * @remarks
   * When `config.keyManager` is supplied, `config.adapters?.keys` is ignored.
   * Likewise, `config.clientStateManager` takes precedence over
   * `config.adapters?.clientState`.
   */
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

  /**
   * Access to the underlying key manager used by this client.
   *
   * @returns The active {@link MajikKeyManager} instance.
   *
   * @remarks
   * Use this for advanced integrations that require functionality not exposed
   * directly by the client facade.
   */
  get keyManager(): MajikKeyManager {
    return this._keys;
  }

  /**
   * Override in subclasses that use a richer state manager (e.g. Signature's
   * ClientStateManager) so the default instance matches TStateManager.
   */
  /**
   * Creates the default client-state manager.
   *
   * @remarks
   * Override this hook when a subclass needs a richer state-manager
   * implementation while still allowing the base constructor to initialize it.
   *
   * @param adapter Optional persistence adapter for the state manager.
   * @returns A state manager compatible with {@link MajikKeyClient.stateManager}.
   */
  protected _createDefaultStateManager(
    adapter?: ClientStateStorageAdapter,
  ): TStateManager {
    return new MajikKeyClientStateManager(
      adapter ?? new InMemoryClientStateAdapter(),
    ) as TStateManager;
  }

  /**
   * Access to the client-state manager used for persisted account state.
   *
   * @returns The active state-manager instance.
   */
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
  /**
   * Builds the subclass's contact representation from a Majik Key.
   *
   * @param key Newly created, imported, or hydrated Majik Key.
   * @param meta Optional application-specific metadata supplied by the caller.
   * @returns The contact representation used by the subclass.
   *
   * @remarks
   * This hook is the boundary between generic key management and
   * application-specific contact modeling.
   */
  protected abstract _buildOwnAccountContact(
    key: MajikKey,
    meta?: Partial<TContactMeta>,
  ): TContact;

  /**
   * Called after a key-derived contact is registered as an own account.
   * Subclass syncs it into its own contact directory here (add-if-absent).
   */
  /**
   * Synchronizes a newly registered own-account contact into the subclass's
   * application-specific directory.
   *
   * @param contact Contact representation that has been registered by the
   * base client.
   * @returns Nothing for synchronous handlers, or a promise for asynchronous
   * persistence/synchronization work.
   */
  protected abstract _onAccountRegistered(
    contact: TContact,
  ): void | Promise<void>;

  /**
   * Called when an own account is removed. Subclass removes it from its
   * own contact directory here.
   */
  /**
   * Removes an own-account contact from the subclass's application-specific
   * directory.
   *
   * @param id Stable account/contact identifier being removed.
   * @returns Nothing for synchronous handlers, or a promise for asynchronous
   * persistence/synchronization work.
   */
  protected abstract _onAccountRemoved(id: string): void | Promise<void>;

  /**
   * Optional extra cleanup hook for resetData(). No-op by default —
   * override to clear contacts/stamps/invoices/etc. alongside key data.
   */
  /**
   * Optional cleanup hook invoked before the base client clears key and
   * state storage.
   *
   * @remarks
   * Override this to clear domain-specific data such as contacts, stamps,
   * invoices, or other application state.
   *
   * @returns A promise that resolves when subclass-specific cleanup finishes.
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
  /**
   * Hydrates the client from its configured persistence layers.
   *
   * @remarks
   * Hydration occurs in the following order:
   * 1. Key storage.
   * 2. Client state.
   * 3. Own-account contacts.
   * 4. Persisted account ordering.
   *
   * Subclasses with additional persisted domains should override this method
   * and call the protected hydration pieces in an order that ensures the
   * subclass's contact directory is ready before own-account contacts are
   * registered.
   *
   * @returns A promise that resolves after base hydration completes.
   * @throws {Error} Propagates hydration errors raised by the underlying
   * key or state managers.
   */
  async hydrate(): Promise<void> {
    await this._hydrateKeys();
    await this._hydrateState();
    await this._hydrateOwnAccounts();
    await this._restoreAccountOrder();
  }

  /**
   * Hydrates the underlying key manager.
   *
   * @returns A promise that resolves when key storage has been hydrated.
   */
  protected async _hydrateKeys(): Promise<void> {
    await this._keys.hydrate();
  }

  /**
   * Hydrates the client-state manager.
   *
   * @returns A promise that resolves when client state has been hydrated.
   */
  protected async _hydrateState(): Promise<void> {
    await this._state.hydrate();
  }

  /**
   * Rebuilds the subclass's own-account map from hydrated keys.
   *
   * @remarks
   * Existing in-memory contacts are preserved. Each newly discovered key is
   * converted through `_buildOwnAccountContact()` and synchronized through
   * `_onAccountRegistered()`.
   *
   * @returns A promise that resolves after all discovered accounts are
   * processed.
   */
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

  /**
   * Restores persisted account ordering and removes stale account IDs.
   *
   * @remarks
   * Any currently loaded accounts missing from persisted state are appended in
   * their current in-memory order.
   *
   * @returns A promise that resolves after ordering has been restored.
   */
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

  /**
   * Schedules a debounced persistence of the current own-account ordering.
   *
   * @remarks
   * Multiple order changes within the debounce window are collapsed into one
   * persistence operation.
   */
  protected _scheduleOrderSave(): void {
    if (this._autosaveOrderTimer !== null) {
      window.clearTimeout(this._autosaveOrderTimer);
    }
    this._autosaveOrderTimer = window.setTimeout(() => {
      void this._persistAccountOrder();
      this._autosaveOrderTimer = null;
    }, 300) as unknown as number;
  }

  /**
   * Persists the current own-account ordering through the state manager.
   *
   * @returns A promise that resolves after the save attempt completes.
   */
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

  /**
   * Generates a new BIP-39 mnemonic using the configured Majik Key mnemonic
   * generator.
   *
   * @param strength Mnemonic entropy strength accepted by Majik Key.
   * Defaults to `128`.
   * @param language Word-list language used to encode the mnemonic.
   * Defaults to `"en"`.
   * @returns A newly generated mnemonic phrase.
   * @throws {Error} Propagates mnemonic-generation errors from
   * {@link MajikKeyManager}.
   */
  async generateMnemonic(
    strength: 128 | 256 = 128,
    language: MnemonicLanguage = "en",
  ): Promise<string> {
    return MajikKeyManager.generateMnemonic(strength, language);
  }

  /**
   * Creates, persists, and registers a new Majik Key account.
   *
   * @param mnemonic BIP-39 mnemonic used to derive the new identity.
   * @param passphrase Passphrase protecting the new key material.
   * @param label Optional user-facing label for the account.
   * @param meta Optional subclass-specific contact metadata.
   * @param mnemonicLanguage Language of the supplied mnemonic word list.
   * Defaults to `"en"`.
   * @returns The created account's ID, fingerprint, and mnemonic backup.
   *
   * @throws {Error} Propagates key creation or persistence errors.
   * @fires `new-account` with the created contact.
   * @fires `error` when the operation fails.
   *
   * @remarks
   * The key is persisted before the subclass contact is registered. Use the
   * returned `backup` value to provide the caller with a recovery artifact.
   */
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

  /**
   * Imports an account from a mnemonic backup and registers it as an own account.
   *
   * @param backupBase64 Previously exported mnemonic backup encoded as Base64.
   * @param mnemonic Mnemonic required to decrypt/restore the backup.
   * @param passphrase Passphrase used to unlock the restored key material.
   * @param label Optional account label.
   * @param meta Optional subclass-specific contact metadata.
   * @param language Language of the supplied mnemonic word list.
   * Defaults to `"en"`.
   * @returns The restored account's ID and fingerprint.
   * @throws {MajikKeyClientError} When another own account already uses the
   * restored account ID.
   * @throws {Error} Propagates backup-import or persistence errors.
   * @fires `new-account` with the restored contact.
   * @fires `error` when the operation fails.
   */
  async importAccountFromMnemonicBackup(
    backupBase64: string,
    mnemonic: string,
    passphrase: string,
    label?: string,
    meta?: Partial<TContactMeta>,
    language: MnemonicLanguage = "en",
  ): Promise<{ id: string; fingerprint: MajikKeyFingerprint }> {
    try {
      const key = await this._keys.importFromMnemonicBackup(
        backupBase64,
        mnemonic,
        passphrase,
        label,
        language,
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

  /**
   * Replaces the currently active account with an account restored from a
   * mnemonic backup.
   *
   * @remarks
   * The backup is imported before the current account is removed, so the
   * current account is not mutated until the replacement key has been
   * successfully restored and validated.
   *
   * @param backupBase64 Previously exported mnemonic backup encoded as Base64.
   * @param mnemonic Mnemonic required to restore the backup.
   * @param passphrase Passphrase used to unlock the restored key material.
   * @param label Optional replacement label. When omitted, the current active
   * account label is reused when available.
   * @param meta Optional subclass-specific contact metadata.
   * @param language Language of the supplied mnemonic word list.
   * Defaults to `"en"`.
   * @returns The replacement account's ID and fingerprint.
   * @throws {MajikKeyClientError} When the restored account ID already belongs
   * to a different own account.
   * @throws {Error} Propagates backup-import, removal, or activation errors.
   * @fires `new-account` with the replacement contact.
   * @fires `error` when the operation fails.
   */
  async replaceAccountFromMnemonicBackup(
    backupBase64: string,
    mnemonic: string,
    passphrase: string,
    label?: string,
    meta?: Partial<TContactMeta>,
    language: MnemonicLanguage = "en",
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
        language,
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

  /**
   * Exports an existing account as a mnemonic backup.
   *
   * @param id ID of the account to export.
   * @param mnemonic Mnemonic required to authorize/export the backup.
   * @returns A Base64-encoded mnemonic backup.
   * @throws {Error} Propagates export or key-store errors.
   */
  async exportAccountMnemonicBackup(
    id: string,
    mnemonic: string,
  ): Promise<string> {
    return this._keys.exportMnemonicBackup(id, mnemonic);
  }

  /**
   * Registers an already-defined contact as one of this client's own accounts.
   *
   * @param account Contact representation to register.
   *
   * @remarks
   * This method only registers the account with the client. The contact must
   * already correspond to key material managed by this client if subsequent
   * key-management operations are expected to work.
   *
   * @fires `new-account` with the supplied contact.
   */
  addOwnAccount(account: TContact): void {
    this._registerOwnAccount(account);
    this._emitBase("new-account", account);
  }

  /**
   * Removes an own account from the client and deletes its key material.
   *
   * @param id ID of the own account to remove.
   * @returns `true` when an account was removed; `false` when no matching
   * own account was registered.
   * @throws {Error} Propagates subclass cleanup or key-store deletion errors.
   * @fires `removed-account` with the removed account ID.
   */
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
  /**
   * Updates an account's key label and synchronizes the in-memory contact label.
   *
   * @param id ID of the own account to rename.
   * @param newLabel New user-facing account label.
   * @returns A promise that resolves after the key label has been updated.
   * @throws {Error} Propagates key-manager update errors.
   * @fires `updated-account` with the updated contact when a local contact exists.
   *
   * @remarks
   * This method updates the client-owned contact object but does not update
   * the subclass's external contact directory. Subclasses should synchronize
   * that directory from their `updated-account` listener or their own
   * contact-management API.
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

  /**
   * Looks up one of the client's own accounts by ID.
   *
   * @param id Account ID to look up.
   * @returns The matching contact, or `undefined` when it is not registered.
   */
  getOwnAccountById(id: string): TContact | undefined {
    return this._ownAccounts.get(id);
  }

  /**
   * Returns the currently active own account.
   *
   * @returns The active contact, or `null` when no own account is registered.
   *
   * @remarks
   * The first account in the internal account-order list is treated as active.
   */
  getActiveAccount(): TContact | null {
    if (!this._ownAccountsOrder.length) return null;
    return this._ownAccounts.get(this._ownAccountsOrder[0]) ?? null;
  }

  /**
   * Returns the Majik Key corresponding to the currently active own account.
   *
   * @returns The active key, or `null` when no own account is registered.
   */
  getActiveAccountKey(): MajikKey | null {
    if (!this._ownAccountsOrder.length) return null;
    return this._keys.get(this._ownAccountsOrder[0]) ?? null;
  }

  /**
   * Determines whether a given own account is currently active.
   *
   * @param id Account ID to test.
   * @returns `true` when the account exists and is the active account;
   * otherwise `false`.
   */
  isAccountActive(id: string): boolean {
    return this._ownAccounts.has(id) && this._ownAccountsOrder[0] === id;
  }

  /**
   * Makes an own account the active account.
   *
   * @param id ID of the own account to activate.
   * @param bypassIdentity When `true`, skips the identity-unlock requirement.
   * Defaults to `false`.
   * @returns `true` when the account became the active account; `false` when
   * the account does not exist or identity verification/unlocking fails.
   * @throws {Error} Propagates unexpected errors from the identity-unlock flow.
   * @fires `active-account-change` when the active account actually changes.
   *
   * @remarks
   * Unless `bypassIdentity` is enabled, the target account must be unlockable
   * through {@link MajikKeyClient.ensureIdentityUnlocked}.
   */
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

  /**
   * Lists all registered own accounts in active-first order.
   *
   * @returns A new array containing the currently registered contacts, ordered
   * by the client's persisted account ordering.
   */
  listOwnAccounts(): TContact[] {
    return this._ownAccountsOrder
      .map((id) => this._ownAccounts.get(id))
      .filter((c): c is TContact => !!c);
  }

  /**
   * Unlocks an own account using its passphrase.
   *
   * @param id ID of the account to unlock.
   * @param passphrase Passphrase used to unlock the account.
   * @returns A promise that resolves when the account is unlocked.
   * @throws {Error} Propagates invalid-passphrase and key-manager errors.
   * @fires `unlock` with the unlocked account ID.
   * @fires `error` when unlocking fails.
   */
  async unlockAccount(id: string, passphrase: string): Promise<void> {
    try {
      await this._keys.unlock(id, passphrase);
      this._emitBase("unlock", id);
    } catch (err) {
      this._emitBase("error", err, { context: "unlockAccount", id });
      throw err;
    }
  }

  /**
   * Locks a single own account.
   *
   * @param id ID of the account to lock.
   * @fires `lock` with the locked account ID.
   */
  lockAccount(id: string): void {
    this._keys.lock(id);
    this._emitBase("lock", id);
  }

  /**
   * Locks every registered own account.
   *
   * @fires `lock` once for each registered account ID.
   */
  lockAllAccounts(): void {
    this._keys.lockAll();
    for (const id of this._ownAccountsOrder) this._emitBase("lock", id);
  }

  /**
   * Checks whether a passphrase is valid for a specific own account.
   *
   * @param id ID of the account whose passphrase should be checked.
   * @param passphrase Candidate passphrase to verify.
   * @returns `true` when the passphrase is valid; otherwise `false`.
   */
  async verifyPassphrase(id: string, passphrase: string): Promise<boolean> {
    return this._keys.isPassphraseValid(id, passphrase);
  }

  /**
   * Changes an account's passphrase using the currently configured key manager.
   *
   * @param id ID of the account whose passphrase should change.
   * @param currentPassphrase Existing passphrase used to authorize the change.
   * @param newPassphrase Replacement passphrase.
   * @returns A promise that resolves after the passphrase is updated.
   * @throws {Error} Propagates validation, authorization, or key-manager errors.
   * @fires `error` when the operation fails.
   */
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

  /**
   * Replaces an account passphrase using mnemonic backup recovery.
   *
   * @param backup Account backup previously produced by the key manager.
   * @param mnemonic Mnemonic used to restore/authorize the account.
   * @param newPassphrase Replacement passphrase.
   * @param id ID of the account whose passphrase is being replaced.
   * @param label Optional replacement account label.
   * @returns The resulting {@link MajikKey} instance.
   * @throws {Error} Propagates backup, mnemonic, or key-manager errors.
   * @fires `error` when the operation fails.
   */
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

  /**
   * Ensures that an account's identity key material is available for use.
   *
   * @param id ID of the account to unlock when necessary.
   * @param promptFn Optional callback used to obtain the passphrase when the
   * identity is locked. The callback receives the account ID.
   * @returns The unlocked identity key, represented as a `CryptoKey` or raw
   * byte payload.
   * @throws {Error} Propagates identity-unlock or key-manager errors.
   */
  async ensureIdentityUnlocked(
    id: string,
    promptFn?: (id: string) => string | Promise<string>,
  ): Promise<CryptoKey | { raw: Uint8Array }> {
    return this._keys.ensureUnlocked(id, promptFn);
  }

  /**
   * Validates a passphrase against a selected account or the active account.
   *
   * @param passphrase Candidate passphrase to validate.
   * @param id Optional account ID. When omitted, the currently active account
   * is used.
   * @returns `true` when the passphrase is valid for the selected account;
   * otherwise `false`.
   */
  async isPassphraseValid(passphrase: string, id?: string): Promise<boolean> {
    const target = id ? this.getOwnAccountById(id) : this.getActiveAccount();
    if (!target) return false;
    return this._keys.isPassphraseValid(target.id, passphrase);
  }

  /**
   * Checks whether an account has signing key material available.
   *
   * @param accountId Optional account ID. When omitted, the active account is
   * checked.
   * @returns `true` when the selected account has signing keys; otherwise
   * `false`.
   */
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
  /**
   * Wipes key-store and client-state data and resets in-memory account tracking.
   *
   * @remarks
   * The subclass hook {@link MajikKeyClient._onResetKeyData} runs before the
   * base key/state stores are cleared. Subclasses should use that hook to
   * clear application-specific domains that are outside the base client.
   *
   * @returns A promise that resolves after all base reset work completes.
   * @throws {MajikKeyClientError} Wraps failures that occur while resetting
   * key or client-state data.
   * @fires `active-account-change` with `null` after the in-memory active
   * account state is cleared.
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

  /**
   * Registers a contact in the client's own-account collection.
   *
   * @param contact Contact to register.
   *
   * @remarks
   * Registration is idempotent for an existing account ID. The method also
   * schedules order persistence, synchronizes the subclass directory through
   * `_onAccountRegistered`, and automatically activates the first account.
   */
  protected _registerOwnAccount(contact: TContact): void {
    const hasActive = !!this.getActiveAccount();

    if (!this._ownAccounts.has(contact.id)) {
      this._ownAccounts.set(contact.id, contact);
      // Only push to the order array here if there's already an active account
      if (hasActive) {
        this._ownAccountsOrder.push(contact.id);
      }
      this._scheduleOrderSave();
    }

    void this._onAccountRegistered(contact);

    if (!hasActive) {
      // setActiveAccount will now correctly handle adding it to _ownAccountsOrder
      // and emitting the "active-account-change" event.
      void this.setActiveAccount(contact.id, true);
    }
  }

  // ==========================================================================
  // ── EVENTS ────────────────────────────────────────────────────────────────
  // ==========================================================================

  /**
   * Initializes listener buckets for a set of event names.
   *
   * @param names Event names that should have registered listener collections.
   * @remarks
   * Existing listener collections are preserved.
   */
  protected _registerEventNames(names: TEvents[]): void {
    for (const name of names) {
      if (!this._listeners.has(name)) this._listeners.set(name, []);
    }
  }

  /**
   * Subscribes a callback to a client event.
   *
   * @param event Event name to subscribe to.
   * @param callback Callback invoked whenever the event is emitted.
   *
   * @example
   * ```ts
   * client.on("unlock", (accountId) => {
   *   console.log(`Unlocked ${accountId}`);
   * });
   * ```
   */
  on(event: TEvents, callback: EventCallback): void {
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event)!.push(callback);
  }

  /**
   * Removes one listener from an event, or clears every listener for that event.
   *
   * @param event Event name whose listeners should be changed.
   * @param callback Optional specific callback to remove. When omitted, all
   * listeners registered for the event are removed.
   *
   * @example
   * ```ts
   * const onUnlock = (accountId: string) => {
   *   console.log(accountId);
   * };
   *
   * client.on("unlock", onUnlock);
   * client.off("unlock", onUnlock);
   * ```
   */
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

  /**
   * Emits an event to all registered listeners.
   *
   * @param event Event name to emit.
   * @param args Positional payload delivered to every listener.
   *
   * @remarks
   * Listener failures are isolated from the emitter: an exception thrown by
   * one listener is caught and logged so other listeners can still run.
   */
  protected _emit(event: TEvents, ...args: unknown[]): void {
    this._listeners.get(event)?.forEach((cb) => {
      try {
        cb(...args);
      } catch (err) {
        console.warn(`MajikKeyClient event handler error (${event}):`, err);
      }
    });
  }

  /**
   * Emits one of the built-in base events without requiring callers to cast
   * the event name to `TEvents`.
   *
   * @param event Built-in MajikKeyClient event name.
   * @param args Positional payload for the selected event.
   *
   * @remarks
   * This helper is primarily for the base implementation. Subclasses should
   * normally use {@link MajikKeyClient._emit} for custom events.
   */
  protected _emitBase(
    event: MajikKeyClientBaseEvents,
    ...args: unknown[]
  ): void {
    this._emit(event as unknown as TEvents, ...args);
  }
}
