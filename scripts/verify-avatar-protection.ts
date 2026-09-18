import { connectResolved } from "./lib/supabase-db";

async function main() {
  const { client } = await connectResolved();
  try {
    const column = await client.query(`select data_type, is_nullable from information_schema.columns
      where table_schema = 'public' and table_name = 'video_requests'
      and column_name = 'avatar_generation_started_at'`);
    const migration = await client.query("select 1 from public._migrations_applied where name = $1", ["0014_avatar_single_attempt.sql"]);
    if (column.rows[0]?.data_type !== "timestamp with time zone" || column.rows[0]?.is_nullable !== "YES" || migration.rowCount !== 1) {
      throw new Error("Migration 0014 verification failed");
    }
    console.log("MIGRATION_0014_VERIFIED: column type, nullability and migration ledger confirmed");
  } finally { await client.end(); }
}
main().catch(() => { console.error("MIGRATION_0014_VERIFICATION_FAILED"); process.exitCode = 1; });
