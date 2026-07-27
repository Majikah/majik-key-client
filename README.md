# Majik Key Client


[![Developed by Zelijah](https://img.shields.io/badge/Developed%20by-Zelijah-red?logo=github&logoColor=white)](https://www.thezelijah.world) ![GitHub Sponsors](https://img.shields.io/github/sponsors/jedlsf?style=plastic&label=Sponsors&link=https%3A%2F%2Fgithub.com%2Fsponsors%2Fjedlsf)

![npm](https://img.shields.io/npm/v/@majikah/majik-key-client) ![npm downloads](https://img.shields.io/npm/dm/@majikah/majik-key-client) ![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue) [![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

**Majik Key Client** is the foundational root class that powers all Majikah application clients. It acts as the central orchestration layer for `@majikah/majik-key`, handling everything from multi-account lifecycle management to client state persistence, so downstream apps (like Majik Signature or Majik Buwiz) get unified, battle-tested cryptographic management out of the box.

---

## Why Majik Key Client?
[![ZENODO](https://img.shields.io/badge/Read_the_Technical_Whitepaper_Here-1682D4?style=for-the-badge&logo=zenodo&logoColor=white)](https://doi.org/10.5281/zenodo.21339132)


When building products on top of `Majik Key` (which turns a BIP-39 mnemonic into a hybrid post-quantum identity), applications consistently need the same infrastructure:
- **Account Management**: Creating, importing, updating, and removing cryptographic identities.
- **State Persistence**: Safely storing locked `MajikKey` instances in a keystore, tracking which account is active, and persisting user preferences.
- **Session Security**: Providing unified lock/unlock flows, passphrase verification, and lifecycle events.

Instead of duplicating this logic in every app, `@majikah/majik-key-client` provides it all in a single abstract class: `MajikKeyClient`. 

By extending this class, a child client gets robust, event-driven key management for free, leaving the child class responsible only for its specific domain logic (e.g., managing a contact directory or signing files).

---

## Features

- **Centralized Keystore Management**: Uses `MajikKeyManager` to seamlessly read and write `MajikKey` data to any storage adapter (in-memory by default, extensible to SQLite, IndexedDB, etc.).
- **Client State Synchronization**: Manages the ordering of loaded accounts and tracks the currently active identity via `MajikKeyClientStateManager`.
- **Event-Driven Architecture**: Exposes typed event hooks (`new-account`, `unlock`, `active-account-change`, `error`, etc.) making it easy to wire up reactive UIs.
- **Account Hydration & Recovery**: Built-in methods to hydrate keys from storage on boot, and robust flows to import or replace accounts from Mnemonic backups.
- **Agnostic Domain Logic**: Deliberately abstracts away the contact directory shape via hooks (`_buildOwnAccountContact`, `_onAccountRegistered`, `_onAccountRemoved`). Subclasses define what a "Contact" looks like in their ecosystem.

---

## Architecture Overview

```mermaid
flowchart TD
    A[12/24-word BIP-39 Seed Phrase] --> B[Majik Key]

    %% Signing branch
    B --> S[Signing]
    S --> S1[Ed25519]
    S --> S2[ML-DSA-87]

    %% Encryption branch
    B --> E[Encryption]
    E --> E1[ML-KEM-768]
    E --> E2[AES-256-GCM]

    %% Identity branch
    B --> I[Identity]
    I --> I1[BIP-39]
    I --> I2[X25519]

    %% Experimental Web3 branch
    B -.-> W[Web3 - Experimental]
    W -.-> W1[Bitcoin - BIP-32/84]
    W -.-> W2[Solana - Ed25519-derived]

    %% Products (fan-in)
    S1 --> P1[Majik Signature]
    S2 --> P1

    S1 --> P2[Majik Buwiz]
    S2 --> P2
    E1 --> P2
    E2 --> P2
    I1 --> P2
    I2 --> P2
    

    E1 --> P3[Majik Message]
    E2 --> P3

    I1 --> P4[Majik Universal ID]
    I2 --> P4

    P4 --> P5[Majik SLink]
```


## Ecosystem

- [Majik Signature Web App](https://signature.majikah.solutions)
- [Majik Signature on Microsoft Store](https://apps.microsoft.com/detail/9pl9g3xzvd1x)
- [Majik Signature Official Repository](https://github.com/Majikah/majik-signature)
- [Majikah Solutions](https://majikah.solutions)

---

## License

**License:** [Apache-2.0](LICENSE) — free for personal and commercial use.

## Author

Developed by **Josef Elijah Fabian (Zelijah)** | [Majikah Solutions OPC](https://majikah.solutions/about)


**Developer**: [Josef Elijah Fabian](https://github.com/jedlsf)

**GitHub**: [https://github.com/Majikah](https://github.com/Majikah)

**Project Repository**: [https://github.com/Majikah/majik-signature](https://github.com/Majikah/majik-signature)

**Technical Whitepaper**: [https://zenodo.org/records/21339132](https://zenodo.org/records/21339132)

---

## Contact

- **Business Email**: [business@majikah.solutions](mailto:business@majikah.solutions)
- **Official Website**: [https://www.thezelijah.world](https://www.thezelijah.world)
- **Majikah Ecosystem**: [https://majikah.solutions](https://majikah.solutions)