import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "../src/db";

async function main() {
  const hasDatabaseSettings = Boolean(
    process.env.DATABASE_URL ||
    process.env.PGHOST ||
    process.env.PGDATABASE ||
    process.env.PGUSER ||
    process.env.PGPASSWORD,
  );
  if (!hasDatabaseSettings) {
    throw new Error("PostgreSQL connection settings are required");
  }
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("PostgreSQL migrations applied successfully");
  await pool.end();
  process.exit(0);
}

main().catch(async (e) => {
  console.error(e);
  await pool.end().catch(() => {});
  process.exit(1);
});
