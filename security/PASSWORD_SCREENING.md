# Password screening policy

Mailbox-owner password setup/recovery and platform-owner bootstrap screen every user-selected new password before hashing or persisting it. Registration collects name and email only and stores a random provisional verifier; a supplied password cannot become the account credential before mailbox proof. A rejected reset does not consume its recovery token. Existing passwords remain valid until changed; automatic rehashing during login does not silently change the user's password.

New selections require at least 12 Unicode code points while retaining the 4096 UTF-16-code-unit resource ceiling. A supplementary-plane character counts once toward the minimum. This check applies only to new passwords; login verification and legacy KDF upgrades preserve existing accepted credentials. Strings, including spaces and combining characters, are never trimmed or normalized before hashing.

Registration performs the same expensive Argon2 operation on a fresh random provisional value before the account-existence branch. Registration, forgot-password and resend-verification email delivery run through Next's tracked `after()` lifecycle after the generic HTTP 202 response and committed token transaction, removing provider latency/retries from that response path. Resend validates an invitation continuation before its account-existence branch so the invitation error does not reveal account state. The custom server drains tracked callbacks before closing its database pool. This removes the reproduced KDF/provider timing differences; it is not a proof of constant-time behavior across every database or infrastructure condition. Email delivery is not a durable outbox: an abrupt process loss or provider outage still requires the existing resend-verification path or another rate-limited reset request. Delivery delay never extends the original token deadline.

The local denylist is the first 3,000 distinct passwords of 12–4,096 Unicode codepoints in the pinned SecLists xato top-million corpus. Only SHA-256 lookup hashes ship in the application. `common-passwords-provenance.json` records the immutable source revision and complete corpus digest; `common-passwords-LICENSE.txt` retains the upstream MIT license. These public lookup hashes are not user password verifiers. User credentials continue to use the existing salted Argon2id KDF.

The context-word list is `yaseir`, `yasser`, `odoo`, `print`, `printing`, `cloud`, `gateway`, `admin`, `administrator`, and `يسير`. Passwords composed only of these words plus digits, punctuation, symbols or whitespace are rejected. Case/Unicode normalization is used only for this policy comparison and never modifies the value passed to Argon2id.

Bootstrap preserves intentional spaces in environment, interactive and command-line password values. The optional password-file format accepts one final LF or CRLF as a line terminator and preserves all other characters. Prefer the secret-file or interactive input over command-line arguments, which can appear in process listings.

Other candidates are checked against the Have I Been Pwned range service using HTTPS. Only the first five hexadecimal characters of a SHA-1 digest are sent. The request includes no password, complete digest, suffix, email or account identity. Response padding is requested, redirects are refused, and a suffix is compared only in the Gateway process. SHA-1 is used solely because the range protocol requires it, never for password storage.

The provider deadline covers headers and body and is four seconds. Each response is capped at 256 KiB. At most eight provider lookups are active per process, with no waiting queue or password cache. Malformed, empty, oversized, all-padding, non-200 and failed responses fail closed with HTTP 503. Known common/contextual/breached candidates return HTTP 400 with `PASSWORD_COMPROMISED`. Existing authentication still works during a provider outage; new password selection must wait for a successful screen. No environment flag disables this production control.

The fixed service URL is `https://api.pwnedpasswords.com/range/`. The deployment must allow this HTTPS egress. Logs and audit records must never contain candidate passwords, full hashes, suffixes or range-response bodies. The protocol is documented at https://haveibeenpwned.com/API/v3#PwnedPasswords.

To verify the local corpus, download the exact URL recorded in the provenance JSON to a temporary file and run:

```sh
python3 scripts/verify-common-passwords.py /path/to/downloaded-public-corpus.txt
npm run test:unit -- tests/password-screening.test.ts tests/password-screening-routes.test.ts
```

The unrelated account/transaction tests use explicit deterministic breach-provider fixtures. The screening tests exercise the real policy and parser, including positive matches, privacy, resource limits and outages. They are distinct from a live provider-availability check.
