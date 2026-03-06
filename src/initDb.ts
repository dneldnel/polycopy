import { resolveSqlitePath } from "./config";
import { Store } from "./store";

function main(): void {
  const sqlitePath = resolveSqlitePath(process.cwd());
  const store = new Store(sqlitePath);
  store.close();
  process.stdout.write(`Initialized SQLite schema at ${sqlitePath}\n`);
}

main();
