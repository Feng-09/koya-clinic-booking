// Boots embedded Postgres + the app on :3000 for manual testing.
process.env.API_KEY = process.env.API_KEY || "dev-key";
process.env.DATABASE_URL = "postgres://postgres:postgres@localhost:55432/postgres";

const EmbeddedPostgres = require("embedded-postgres").default;

async function main() {
  const pg = new EmbeddedPostgres({
    databaseDir: "./test/pgdata-dev",
    user: "postgres",
    password: "postgres",
    port: 55432,
  });
  await pg.initialise();
  await pg.start();

  const { migrate } = require("../src/db");
  await migrate();

  const app = require("../src/app");
  app.listen(3000, () => console.log("dev server on http://localhost:3000 (key: dev-key)"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
