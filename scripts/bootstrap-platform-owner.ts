import { db } from "../src/db";
import { users } from "../src/db/schema";
import { eq, sql } from "drizzle-orm";
import { hashPassword, normalizeEmail } from "../src/lib/password";
import { nanoid } from "../src/lib/nanoid";
import { writeAuditEvent } from "../src/lib/audit";

async function main() {
  const args = process.argv.slice(2);
  let email = process.env.PLATFORM_OWNER_EMAIL?.trim() ?? "";
  let password = process.env.PLATFORM_OWNER_PASSWORD?.trim() ?? "";
  let force = process.env.ALLOW_PLATFORM_BOOTSTRAP_FORCE === "1";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--email" && args[i + 1]) {
      email = args[i + 1].trim();
      i++;
    } else if (args[i] === "--password" && args[i + 1]) {
      password = args[i + 1].trim();
      i++;
    } else if (args[i] === "--force") {
      force = true;
    }
  }

  if (!email || !password) {
    console.error("Usage: npx tsx scripts/bootstrap-platform-owner.ts --email <email> --password <password> [--force]");
    console.error("Or set PLATFORM_OWNER_EMAIL and PLATFORM_OWNER_PASSWORD environment variables.");
    process.exit(1);
  }

  const normalized = normalizeEmail(email);
  if (!normalized) {
    console.error("Error: Invalid email address provided.");
    process.exit(1);
  }

  if (password.length < 10) {
    console.error("Error: Platform Owner password must be at least 10 characters.");
    process.exit(1);
  }

  const passwordHash = await hashPassword(password);
  const now = new Date();

  const targetUserId = await db.transaction(async (tx) => {
    // Acquire exclusive table-level advisory or row lock to prevent race conditions during bootstrap
    const existing = await tx.execute(sql`
      SELECT id, email FROM users WHERE is_platform_owner = true FOR UPDATE
    `);

    if (existing.rows.length > 0 && !force) {
      console.log(`Platform Owner already exists (${existing.rows.length} owner(s) found). First-boot bootstrap skipped.`);
      console.log("Use --force or set ALLOW_PLATFORM_BOOTSTRAP_FORCE=1 if you explicitly intend to promote or reset an owner.");
      return null;
    }

    const userMatch = await tx.execute(sql`
      SELECT id FROM users WHERE email = ${normalized} FOR UPDATE
    `);

    if (userMatch.rows.length > 0) {
      const uId = String((userMatch.rows[0] as { id: string }).id);
      await tx
        .update(users)
        .set({
          isPlatformOwner: true,
          passwordHash,
          emailVerifiedAt: now,
          updatedAt: now,
        })
        .where(eq(users.id, uId));
      console.log(`Successfully promoted existing user (${normalized}) to Platform Owner.`);
      return uId;
    } else {
      const uId = `usr_${nanoid(18)}`;
      await tx.insert(users).values({
        id: uId,
        email: normalized,
        passwordHash,
        isPlatformOwner: true,
        emailVerifiedAt: now,
      });
      console.log(`Successfully created new Platform Owner account (${normalized}).`);
      return uId;
    }
  });

  if (targetUserId) {
    await writeAuditEvent({
      tenantId: "platform",
      actorType: "platform",
      actorId: targetUserId,
      action: "platform.bootstrap",
      resourceType: "platform_owner",
      resourceId: targetUserId,
      metadata: { email: normalized, forced: force },
    });
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("Platform Owner bootstrap failed:", err);
  process.exit(1);
});
