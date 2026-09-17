import { db } from "../src/db";
import { users, auditEvents } from "../src/db/schema";
import { eq, sql } from "drizzle-orm";
import { hashPassword, normalizeEmail } from "../src/lib/password";
import { nanoid } from "../src/lib/nanoid";
import fs from "fs";
import readline from "readline";

async function promptPasswordInteractive(promptText: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = function _writeToOutput(s: string) {
      if (s.includes("\n") || s.includes("\r")) {
        process.stdout.write("\n");
      }
    };

    process.stdout.write(promptText);
    rl.question("", (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  let email = process.env.PLATFORM_OWNER_EMAIL?.trim() ?? "";
  let password = process.env.PLATFORM_OWNER_PASSWORD?.trim() ?? "";
  let force = process.env.ALLOW_PLATFORM_BOOTSTRAP_FORCE === "1";
  let passedViaCli = false;

  const passwordFile = process.env.PLATFORM_OWNER_PASSWORD_FILE?.trim();
  if (!password && passwordFile && fs.existsSync(passwordFile)) {
    try {
      password = fs.readFileSync(passwordFile, "utf8").trim();
    } catch (err) {
      console.error(`Error reading PLATFORM_OWNER_PASSWORD_FILE at ${passwordFile}:`, err);
      process.exit(1);
    }
  }

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--email" && args[i + 1]) {
      email = args[i + 1].trim();
      i++;
    } else if (args[i] === "--password" && args[i + 1]) {
      password = args[i + 1].trim();
      passedViaCli = true;
      i++;
    } else if (args[i] === "--force") {
      force = true;
    }
  }

  if (passedViaCli) {
    console.warn("SECURITY WARNING: Passing password via CLI arguments exposes secrets in shell history and process lists.");
    console.warn("Recommended: Use PLATFORM_OWNER_PASSWORD environment variable or TTY interactive prompt.");
  }

  if (!email && process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    email = await new Promise<string>((res) => {
      rl.question("Enter Platform Owner Email: ", (ans) => {
        rl.close();
        res(ans.trim());
      });
    });
  }

  if (!password && process.stdin.isTTY) {
    password = await promptPasswordInteractive("Enter Platform Owner Password: ");
  }

  if (!email || !password) {
    console.error("Usage: npx tsx scripts/bootstrap-platform-owner.ts [--email <email>] [--force]");
    console.error("Set PLATFORM_OWNER_EMAIL and PLATFORM_OWNER_PASSWORD environment variables or run in interactive TTY.");
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

  const success = await db.transaction(async (tx) => {
    // Transaction-level PostgreSQL advisory lock on fixed key.
    // Serializes bootstrap executions globally even on a fresh DB with zero rows.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('platform_bootstrap_lock'))`);

    const existing = await tx.execute(sql`
      SELECT id, email FROM users WHERE is_platform_owner = true FOR UPDATE
    `);

    if (existing.rows.length > 0 && !force) {
      console.log(`Platform Owner already exists (${existing.rows.length} owner(s) found). First-boot bootstrap skipped.`);
      console.log("Use --force or set ALLOW_PLATFORM_BOOTSTRAP_FORCE=1 if you explicitly intend to promote or reset an owner.");
      return false;
    }

    const userMatch = await tx.execute(sql`
      SELECT id FROM users WHERE email = ${normalized} FOR UPDATE
    `);

    let uId: string;
    if (userMatch.rows.length > 0) {
      uId = String((userMatch.rows[0] as { id: string }).id);
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
    } else {
      uId = `usr_${nanoid(18)}`;
      await tx.insert(users).values({
        id: uId,
        email: normalized,
        passwordHash,
        isPlatformOwner: true,
        emailVerifiedAt: now,
      });
      console.log(`Successfully created new Platform Owner account (${normalized}).`);
    }

    // Atomic Audit Event insertion inside the SAME transaction boundary.
    await tx.insert(auditEvents).values({
      id: `audit_${nanoid(14)}`,
      tenantId: null,
      actorType: "platform",
      actorId: uId,
      action: "platform.bootstrap",
      resourceType: "platform_owner",
      resourceId: uId,
      metadata: { email: normalized, forced: force },
    });

    return true;
  });

  if (success) {
    console.log("Platform Owner bootstrap completed and audit log committed successfully.");
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("Platform Owner bootstrap failed:", err);
  process.exit(1);
});
