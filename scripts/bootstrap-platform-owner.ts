import { db } from "../src/db";
import { users } from "../src/db/schema";
import { eq } from "drizzle-orm";
import { hashPassword, normalizeEmail } from "../src/lib/password";
import { nanoid } from "../src/lib/nanoid";

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

  const existingOwners = await db.query.users.findMany({
    where: eq(users.isPlatformOwner, true),
    columns: { id: true, email: true },
  });

  if (existingOwners.length > 0 && !force) {
    console.log(`Platform Owner already exists (${existingOwners.length} owner(s) found). First-boot bootstrap skipped.`);
    console.log("Use --force or set ALLOW_PLATFORM_BOOTSTRAP_FORCE=1 if you explicitly intend to promote or reset an owner.");
    process.exit(0);
  }

  const passwordHash = await hashPassword(password);
  const now = new Date();

  const userRow = await db.query.users.findFirst({
    where: eq(users.email, normalized),
    columns: { id: true },
  });

  if (userRow) {
    await db
      .update(users)
      .set({
        isPlatformOwner: true,
        passwordHash,
        emailVerifiedAt: now,
        updatedAt: now,
      })
      .where(eq(users.id, userRow.id));
    console.log(`Successfully promoted existing user (${normalized}) to Platform Owner.`);
  } else {
    const userId = `usr_${nanoid(18)}`;
    await db.insert(users).values({
      id: userId,
      email: normalized,
      passwordHash,
      isPlatformOwner: true,
      emailVerifiedAt: now,
    });
    console.log(`Successfully created new Platform Owner account (${normalized}).`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("Platform Owner bootstrap failed:", err);
  process.exit(1);
});
