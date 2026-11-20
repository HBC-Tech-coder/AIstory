import { fileURLToPath } from "node:url";
import path from "node:path";

// Do not read runtime configuration, open a listener or spawn a child. There is
// no owner-claim window in pending activation v2. Old automation must stop here.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stderr.write("OWNER_CLAIM_SUPERSEDED_PENDING_ACTIVATION_V2\n");
  process.exitCode = 1;
}
