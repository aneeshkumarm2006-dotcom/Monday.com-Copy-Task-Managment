# Board Vault — Secure Data Tab Implementation Plan

A per-board **Vault** tab for storing passwords, API keys, secure notes, docs, sheets, and files.
Available on **all board types**, rendered beside the existing tabs (Board / Delivery / Goals / People).

---

## 1. Threat model & core security idea

**Requirement:** even if an attacker compromises a user's **email** (and therefore can reset the
app login password and sign in as them), they must NOT be able to read vault contents.

That rules out anything protected only by login. The vault is therefore **zero-knowledge**:

1. **The vault password is never sent to, or stored on, the server in any recoverable form.**
   All encryption/decryption happens in the browser. The server only ever stores ciphertext.
   A full DB dump, a stolen JWT, or a compromised admin account yields nothing readable.
2. **The vault password is not resettable via email.** Losing it means losing the vault,
   with an optional one-time **recovery key** as the only escape hatch.

### Key hierarchy (Bitwarden/LastPass-style envelope encryption)

```
vault password (human)
   │  PBKDF2-SHA-256, ~600k iterations, per-vault random salt   (native WebCrypto)
   ▼
stretched key ──HKDF──┬──► ENCRYPTION KEY (never leaves browser)
                      │        wraps/unwraps the Vault Key
                      └──► AUTH PROOF (sent to server on unlock)
                               server stores only its scrypt hash

Vault Key (VK) — random 256-bit, generated client-side at setup
   │  AES-256-GCM, per-item random IV
   ▼
every vault item (credentials, notes, docs, sheets, files, even titles)
```

- **Server stores:** KDF salt + params, the **wrapped VK** (encrypted with the encryption key),
  the **scrypt hash of the auth proof**, an optional **recovery-key wrap** of VK, and item ciphertexts.
- **Server never sees:** the vault password, the encryption key, VK, or any plaintext.

### Unlock flow

1. Client fetches vault metadata (salt, KDF params), derives both keys from the entered password.
2. Client sends the **auth proof** → server verifies against the scrypt hash
   (constant-time, reusing `server/src/utils/portalCrypto.js`), **rate-limited** (~5/min,
   reusing `server/src/middleware/rateLimit.js` — currently only used on portal routes).
3. Server issues a short-lived **vault-scoped JWT** (~15 min, `scope: 'vault'`, bound to boardId)
   required on every vault item route.
4. Client unwraps VK and holds it **in memory only** (zustand, never localStorage),
   with an idle auto-lock timer.

**Why both halves matter:** the server-side proof means an attacker with a stolen session cannot
even *download* ciphertext or brute-force offline unthrottled; the client-side encryption means
even someone with the full database reads nothing.

### Consequences of the design

| Scenario | Outcome |
|---|---|
| Email compromised → app password reset → attacker logged in | Cannot open the Vault tab (no vault password), cannot fetch ciphertext (no vault JWT) |
| Database stolen | Only ciphertext + scrypt hashes; strong KDF makes offline guessing expensive |
| App JWT stolen | Vault routes additionally require the vault-scoped JWT |
| Vault password changed | Only VK is re-wrapped — items are **never** re-encrypted |
| Vault password forgotten | Recovery key (shown once at setup) unwraps VK; otherwise data is **gone forever — by design** |
| Person leaves the team | Shared-password model: change the vault password (instant, one screen — only VK re-wraps) |

**Deliberate tradeoffs:**
- One shared password per board vault (as requested). Per-user keys are possible later without
  touching stored items, because everything sits behind VK.
- **No email recovery, ever.** If a deliberate escape hatch is wanted (e.g. org-admin recovery-key
  escrow), fold it into Phase 5 as an explicit opt-in.

---

## 2. User experience

- **Vault** tab appears in the board tab bar for users with the capability.
- **First visit** → setup screen: choose vault password, download/copy the one-time recovery key.
- **After setup** → lock screen (password prompt). Unlocking reveals:
  - Item list (mirrors the Group Notes panel UX), titles decrypted client-side.
  - **+ New** → **Credential** (username / password / API key / URL / notes; masked display,
    copy buttons with clipboard auto-clear), **Note** (TipTap, reuses `RichEditor.jsx`),
    **Doc** (same editor, full-page), **Sheet** (simple grid stored as JSON), **File upload**.
- **Files** are encrypted in the browser *before* upload — Cloudinary only receives an opaque
  encrypted blob under a random name (Cloudinary URLs are public-by-possession, so plaintext must
  never reach it). Real filename lives inside the encrypted metadata. Download = fetch blob,
  decrypt locally, save.
- **Auto-lock** on idle (~5 min), on navigating away from the tab, and manually via a Lock button.

---

## 3. Data model

### `server/src/models/Vault.js` (one per board)
| field | notes |
|---|---|
| `board` | ObjectId ref Board, unique, indexed |
| `kdf` | `{ algo: 'PBKDF2-SHA256', iterations, salt }` |
| `wrappedVK` | VK encrypted with the password-derived encryption key |
| `proofHash` | scrypt hash of the auth proof (`portalCrypto` format) |
| `recoveryWrap` | VK encrypted with the recovery key (nullable) |
| `createdBy`, timestamps | |

### `server/src/models/VaultItem.js`
| field | notes |
|---|---|
| `vault` | ObjectId ref Vault, indexed |
| `board` | denormalised for board-scoped queries (Note.js pattern) |
| `type` | `'credential' \| 'note' \| 'doc' \| 'sheet' \| 'file'` |
| `ciphertext`, `iv` | AES-256-GCM output — includes the encrypted title |
| `file` | `{ url, publicId, size }` for type `file` (blob is ciphertext) |
| `createdBy`, `lastEditedBy`, timestamps | |

**Deliberately nothing readable** — no plaintext title, no plaintext filename.

---

## 4. Server surface

- **Capabilities:** new `vault.view` / `vault.manage`, threaded through
  `server/src/utils/capabilities.js` in all 4 places (`CAPABILITY_GROUPS`, `BOARD_SCOPED`,
  `LEVEL_ADDS`, role default sets). Both sit on the **edit** rung — vault should not be readable
  at lower board levels.
- **Routes** (`server/src/routes/vault.js`, mounted `app.use('/api', …)` in `app.js`), every
  handler using the `loadBoardContext` + `requireCapability` idiom from `noteController.js`:

| route | auth | purpose |
|---|---|---|
| `GET  /api/boards/:boardId/vault` | app JWT | vault meta (exists? salt, KDF params) — no ciphertext |
| `POST /api/boards/:boardId/vault` | app JWT | one-time setup (wrappedVK, proofHash, recoveryWrap) |
| `POST /api/boards/:boardId/vault/unlock` | app JWT + **rate limit** | verify proof → issue vault JWT; audit-logged |
| `GET  /api/boards/:boardId/vault/items` | app JWT + **vault JWT** | list ciphertexts |
| `POST /api/boards/:boardId/vault/items` | both | create item |
| `PATCH/DELETE /api/vault/items/:id` | both | update / delete |
| `POST /api/boards/:boardId/vault/items/upload` | both | encrypted-blob upload (raw resource type, 25 MB) |
| `POST /api/boards/:boardId/vault/password` | both | verify old proof → store new wrappedVK + proofHash |

- **`vaultAuth` middleware:** verifies the vault-scoped JWT (separate scope check, mirroring how
  `auth.js` rejects `scope === 'portal'` — app tokens must be rejected here and vault tokens there).
- **Audit log:** unlock attempts (success/fail, user, IP) and item CRUD — metadata only.

---

## 5. Client surface

- **`client/src/utils/vaultCrypto.js`** — the **single crypto contract**. Nothing else in the app
  touches WebCrypto. Exports: `deriveKeys(password, salt, params)`, `generateVK()`,
  `wrapVK / unwrapVK`, `encryptItem / decryptItem`, `encryptFile / decryptFile`,
  `generateRecoveryKey`, `wrapWithRecovery / unwrapWithRecovery`.
- **`client/src/store/vaultStore.js`** — zustand, **non-persisted**: VK, vault token, decrypted
  item cache, lock state, idle timer. Cleared on lock/logout/board change.
- **`client/src/services/vaultService.js`** — thin `api.*` wrappers (noteService pattern).
- **Tab registration** (the whole thing, per `BoardDetailPage.jsx`):
  1. One entry in `VIEW_TABS` (line ~130) with a `visible` gate.
  2. `canViewVault = canOnBoard('vault.view')` near the other gates (lines ~381–405).
  3. One `{view === 'vault' && <ErrorBoundary…><VaultTab/></ErrorBoundary>}` render block.
  - Note: on standard boards the tab bar is hidden when only one tab is visible — Vault becomes
    the second tab, which makes the bar appear. Intended.
- **`client/src/components/vault/`** — `VaultTab.jsx` (setup / locked / unlocked states),
  `VaultSetup.jsx`, `VaultLockScreen.jsx`, `VaultItemList.jsx`, and an **item-type registry**
  (`itemTypes.js` mapping `type → { icon, label, Editor, Viewer }`) so adding a future item type
  is one file. Editors: `CredentialEditor`, `NoteEditor` (RichEditor), `DocEditor`,
  `SheetEditor` (grid), `FileItem` (encrypt-upload / download-decrypt).

---

## 6. Phases

### Phase 1 — Server foundation
Models (`Vault`, `VaultItem`), `vault.view`/`vault.manage` capabilities, `routes/vault.js` +
`vaultController.js`, unlock endpoint (scrypt verify → vault JWT), `vaultAuth` middleware,
rate limiting on unlock, audit log.

### Phase 2 — Client crypto core
`vaultCrypto.js`, `vaultStore.js`, `vaultService.js`, unlock/lock lifecycle.

### Phase 3 — Vault tab UI
Tab registration, setup screen (+ recovery key), lock screen, item list,
credential viewer/editor, note & doc editors. **← usable core ends here**

### Phase 4 — Files & sheets
Browser-side file encryption, raw Cloudinary upload of ciphertext blobs (or proxied via the
existing `routes/proxy.js`), download-and-decrypt; the sheet grid component.

### Phase 5 — Hardening polish
Vault password change (re-wrap), recovery-key restore flow, idle auto-lock + lock-on-tab-switch,
clipboard auto-clear for copied secrets, audit log viewer, optional org-admin recovery escrow
(only if explicitly wanted).

---

## 7. Reused existing contracts

| existing piece | reused for |
|---|---|
| `server/src/utils/portalCrypto.js` (scrypt + `timingSafeEqual`) | auth-proof hashing/verification |
| `server/src/middleware/rateLimit.js` | throttling unlock attempts |
| `server/src/utils/boardContext.js` (`loadBoardContext` + `requireCapability`) | every vault handler |
| `Note.js` / `noteController` / `noteService` / `GroupNotesPanel` pattern | VaultItem model, routes, list UX |
| `RichEditor.jsx` (TipTap) | note & doc editors |
| Cloudinary config + `handleUploadError` (25 MB pattern) | encrypted file blobs |
| `VIEW_TABS` in `BoardDetailPage.jsx` | tab registration |
