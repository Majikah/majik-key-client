export * from "./sql-schema";

export * from "./sql-db-manager";
export * from "./storage-adapter";
export * from "./idb-adapter";

export * from "./keystore/adapter-idb";
export * from "./keystore/adapter-sql";
export * from "./keystore/adapter-memory";
export type * from "./keystore/_types";

export * from "./client-state/adapter-idb";
export * from "./client-state/adapter-sql";
export * from "./client-state/adapter-memory";
export type * from "./client-state/_types";

export type {
  MnemonicJSON,
  MajikKeyAddress,
  MajikKeyJSON,
  MajikKeyMetadata,
  MajikKeyIdentity,
  MajikKeyFingerprint,
  MajikKeyConstructorOptions,
  MajikKeyDangerousJSON,
  MajikKeySolanaNamespace,
  MajikKeyBitcoinNamespace,
  MajikKeyWeb3Namespace,
  BitcoinDerivationOptions,
  BitcoinKeypairMaterial,
  SerializedIdentity,
  SolanaKeypairMaterial,
} from "@majikah/majik-key";
