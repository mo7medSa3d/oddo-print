# External Authoritative Documentation Sources

This document lists all official documentation, standards, and engineering advisories consulted during the forensic engineering audit.

---

## Technical Standards & Guidance Consulted

1. **Node.js Crypto API Documentation**
   - Topic: `crypto.timingSafeEqual` input length requirements and SHA-256 length masking patterns.
   - Reference: [Node.js Crypto Documentation](https://nodejs.org/api/crypto.html#cryptotimingsafeequala-b)
   - Research Date: September 2026

2. **OWASP Password Storage Cheat Sheet**
   - Topic: Argon2id parameter choices (memory cost 64MB, time cost 3, parallelism 4) vs scrypt backward compatibility.
   - Reference: [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
   - Research Date: September 2026

3. **Go Language Specification & Concurrency Guidelines**
   - Topic: Mutex lock ordering, buffered channel semaphores, `runtime.KeepAlive` for cgo/syscall pointers, `-race` detector mechanics.
   - Reference: [Go Memory Model](https://golang.org/ref/mem) & [Go Race Detector Documentation](https://go.dev/doc/articles/race_detector)
   - Research Date: September 2026

4. **PostgreSQL 16 Documentation**
   - Topic: `FOR UPDATE SKIP LOCKED` query semantics, advisory locks (`pg_advisory_xact_lock`), and index optimization.
   - Reference: [PostgreSQL Explicit Locking Documentation](https://www.postgresql.org/docs/16/explicit-locking.html)
   - Research Date: September 2026

5. **Drizzle ORM Documentation**
   - Topic: Relational query builders, transaction isolation, migration execution, and schema constraints.
   - Reference: [Drizzle ORM Docs](https://orm.drizzle.team/docs/overview)
   - Research Date: September 2026

6. **Odoo 19 Developer Documentation**
   - Topic: Environment rebinding (`with_env`), company context switching, and client action return dictionaries.
   - Reference: [Odoo ORM API Guide](https://www.odoo.com/documentation/master/developer/reference/backend/orm.html)
   - Research Date: September 2026
