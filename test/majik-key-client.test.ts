import { beforeEach, describe, expect, it } from "vitest";
import { MajikKey } from "@majikah/majik-key";

import {
  MajikKeyClient,
  MajikKeyClientContact,
  MajikKeyClientError,
} from "../src/majik-key-client";

// MajikKeyClient uses window.setTimeout/window.clearTimeout for account-order
// persistence. Vitest runs in Node by default, where the timer APIs live on
// globalThis instead of window. This aliases the real global object to prevent
// reference errors during _scheduleOrderSave.
const nodeGlobal = globalThis as typeof globalThis & {
  window?: typeof globalThis;
};
if (!("window" in nodeGlobal)) {
  Object.defineProperty(nodeGlobal, "window", {
    configurable: true,
    value: nodeGlobal,
  });
}

// ─── Mock Concrete Client Implementation ──────────────────────────────────────

interface TestContact extends MajikKeyClientContact {
  email?: string;
}

class TestKeyClient extends MajikKeyClient<TestContact> {
  public synchronizedAccounts: string[] = [];
  public removedAccounts: string[] = [];
  public resetTriggered = false;

  protected _buildOwnAccountContact(
    key: MajikKey,
    meta?: Partial<unknown>,
  ): TestContact {
    return {
      id: key.id,
      meta: { label: key.label, ...meta },
    };
  }

  protected _onAccountRegistered(contact: TestContact): void {
    this.synchronizedAccounts.push(contact.id);
  }

  protected _onAccountRemoved(id: string): void {
    this.removedAccounts.push(id);
  }

  protected async _onResetKeyData(): Promise<void> {
    this.resetTriggered = true;
  }
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe("MajikKeyClient — abstract root client integration suite", () => {
  let client: TestKeyClient;

  beforeEach(async () => {
    client = new TestKeyClient({});
    await client.hydrate();
  });

  describe("Initialization, hydration & events", () => {
    it("creates and hydrates with default in-memory adapters", () => {
      expect(client.keyManager).toBeDefined();
      expect(client.stateManager).toBeDefined();
    });

    it("registers and triggers domain events through the internal event system", async () => {
      const seen: Array<{ event: string; payload: unknown }> = [];

      client.on("new-account", (contact) =>
        seen.push({ event: "new-account", payload: contact }),
      );
      client.on("active-account-change", (active, prev) =>
        seen.push({
          event: "active-account-change",
          payload: { active, prev },
        }),
      );
      client.on("removed-account", (id) =>
        seen.push({ event: "removed-account", payload: id }),
      );

      const mnemonic = await client.generateMnemonic(128, "en");
      const created = await client.createAccount(
        mnemonic,
        "passphrase",
        "Event Test",
      );

      expect(seen.map((entry) => entry.event)).toEqual(
        expect.arrayContaining(["new-account", "active-account-change"]),
      );

      await client.removeOwnAccount(created.id);
      expect(seen.map((entry) => entry.event)).toContain("removed-account");
    });

    it("supports off(event, callback) and off(event) listener removal", async () => {
      let callbackCount = 0;
      const callback = () => {
        callbackCount += 1;
      };

      client.on("new-account", callback);

      const mnemonic1 = await client.generateMnemonic(128);
      await client.createAccount(mnemonic1, "pass", "A");
      expect(callbackCount).toBe(1);

      client.off("new-account", callback);
      const mnemonic2 = await client.generateMnemonic(128);
      await client.createAccount(mnemonic2, "pass", "B");
      expect(callbackCount).toBe(1); // Should not increment

      client.on("new-account", callback);
      client.off("new-account"); // Clears all
      const mnemonic3 = await client.generateMnemonic(128);
      await client.createAccount(mnemonic3, "pass", "C");
      expect(callbackCount).toBe(1); // Still should not increment
    });
  });

  describe("Account and identity management lifecycle", () => {
    it("generates a mnemonic", async () => {
      const mnemonic = await client.generateMnemonic(128, "en");
      expect(typeof mnemonic).toBe("string");
      expect(mnemonic.trim().split(/\s+/)).toHaveLength(12);
    });

    it("creates an account, synchronizes subclasses, locks, verifies, and unlocks", async () => {
      const mnemonic = await client.generateMnemonic(128, "en");
      const passphrase = "secure-passphrase";

      const created = await client.createAccount(
        mnemonic,
        passphrase,
        "Main Account",
      );

      expect(created.id).toBeTruthy();
      expect(created.fingerprint).toBeTruthy();
      expect(created.backup).toBeTruthy();

      // Verify subclass hooks
      expect(client.synchronizedAccounts).toContain(created.id);

      const ownContact = client.getOwnAccountById(created.id);
      expect(ownContact?.meta?.label).toBe("Main Account");

      client.lockAccount(created.id);
      expect(await client.verifyPassphrase(created.id, passphrase)).toBe(true);

      await client.unlockAccount(created.id, passphrase);
      expect(client.getActiveAccountKey()?.isLocked).toBe(false);
    });

    it("imports a mnemonic backup and registers it as an own account", async () => {
      const sourceClient = new TestKeyClient({});
      const mnemonic = await sourceClient.generateMnemonic(128, "en");
      const passphrase = "import-passphrase";

      const created = await sourceClient.createAccount(
        mnemonic,
        passphrase,
        "Source",
      );

      const backup = await sourceClient.exportAccountMnemonicBackup(
        created.id,
        mnemonic,
      );

      const imported = await client.importAccountFromMnemonicBackup(
        backup,
        mnemonic,
        passphrase,
        "Imported",
      );

      expect(imported.id).toBe(created.id);
      expect(imported.fingerprint).toBe(created.fingerprint);
      expect(client.getOwnAccountById(imported.id)?.meta?.label).toBe(
        "Imported",
      );
    });

    it("rejects duplicate imported account IDs", async () => {
      const mnemonic = await client.generateMnemonic(128, "en");
      const passphrase = "duplicate-pass";

      const created = await client.createAccount(
        mnemonic,
        passphrase,
        "Original",
      );
      const backup = await client.exportAccountMnemonicBackup(
        created.id,
        mnemonic,
      );

      await expect(
        client.importAccountFromMnemonicBackup(
          backup,
          mnemonic,
          passphrase,
          "Duplicate",
        ),
      ).rejects.toThrowError(MajikKeyClientError);
    });

    it("replaces an account from a mnemonic backup", async () => {
      const mnemonic = await client.generateMnemonic(128, "en");
      const passphrase = "replace-pass";

      const initial = await client.createAccount(
        mnemonic,
        passphrase,
        "Initial",
      );
      const backup = await client.exportAccountMnemonicBackup(
        initial.id,
        mnemonic,
      );

      const newMnemonic = await client.generateMnemonic(128, "en");
      const newInitial = await client.createAccount(
        newMnemonic,
        passphrase,
        "New Initial",
      );
      await client.setActiveAccount(newInitial.id, true);

      // Clean up the initial account to properly simulate restoring an external backup
      await client.removeOwnAccount(initial.id);

      const replaced = await client.replaceAccountFromMnemonicBackup(
        backup,
        mnemonic,
        passphrase,
        "Replaced Label",
      );

      expect(replaced.id).toBe(initial.id);
      expect(client.getOwnAccountById(initial.id)?.meta?.label).toBe(
        "Replaced Label",
      );
      expect(client.getActiveAccount()?.id).toBe(initial.id);
      expect(client.removedAccounts).toContain(newInitial.id);
    });

    it("updates own-account metadata label in cache and keys", async () => {
      const mnemonic = await client.generateMnemonic(128);
      const created = await client.createAccount(mnemonic, "pass", "Old Label");

      await client.updateAccountLabel(created.id, "New Label");

      expect(client.getOwnAccountById(created.id)?.meta?.label).toBe(
        "New Label",
      );
      expect(client.getActiveAccountKey()?.label).toBe("New Label");
    });
  });

  describe("Active account & Passphrase operations", () => {
    it("manages active account state and verifies signing capability", async () => {
      const mnemonicA = await client.generateMnemonic(128);
      const accA = await client.createAccount(mnemonicA, "pass", "A");

      const mnemonicB = await client.generateMnemonic(128);
      const accB = await client.createAccount(mnemonicB, "pass", "B");

      expect(client.isAccountActive(accB.id)).toBe(false);

      const activated = await client.setActiveAccount(accB.id, true);

      expect(activated).toBe(true);
      expect(client.isAccountActive(accB.id)).toBe(true);
      expect(client.getActiveAccount()?.id).toBe(accB.id);

      const list = client.listOwnAccounts();
      expect(list[0].id).toBe(accB.id);
      expect(list[1].id).toBe(accA.id);

      expect(client.hasSigningCapability(accB.id)).toBe(true);
    });

    it("updates passphrase on a loaded account", async () => {
      const mnemonic = await client.generateMnemonic(128);
      const created = await client.createAccount(
        mnemonic,
        "old-pass",
        "Target",
      );

      await client.updatePassphrase(created.id, "old-pass", "new-pass");

      expect(await client.verifyPassphrase(created.id, "new-pass")).toBe(true);
      expect(await client.verifyPassphrase(created.id, "old-pass")).toBe(false);
    });

    it("replaces passphrase using mnemonic recovery", async () => {
      const mnemonic = await client.generateMnemonic(128);
      const created = await client.createAccount(
        mnemonic,
        "old-pass",
        "Target",
      );

      const backup = await client.exportAccountMnemonicBackup(
        created.id,
        mnemonic,
      );

      const recoveredKey = await client.replacePassphrase(
        backup,
        mnemonic,
        "recovered-pass",
        created.id,
      );

      expect(recoveredKey.id).toBe(created.id);
      expect(await client.verifyPassphrase(created.id, "recovered-pass")).toBe(
        true,
      );
    });
  });

  describe("Client reset & cleanup", () => {
    it("resets all data, triggers subclass cleanup, and emits null active account", async () => {
      const mnemonic = await client.generateMnemonic(128);
      await client.createAccount(mnemonic, "pass", "To Be Deleted");

      let nullEmitted = false;
      client.on("active-account-change", (active) => {
        if (active === null) nullEmitted = true;
      });

      await client.resetData();

      expect(client.resetTriggered).toBe(true);
      expect(client.listOwnAccounts()).toHaveLength(0);
      expect(client.getActiveAccount()).toBeNull();
      expect(nullEmitted).toBe(true);
    });
  });
});
