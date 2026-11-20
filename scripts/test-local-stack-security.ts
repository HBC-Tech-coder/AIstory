import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

interface SafeLaunchOptions {
  allowLanBinding: boolean;
  backendRoot: string;
  port: number;
}

interface SqliteStatement {
  run(...values: unknown[]): unknown;
}

interface SqliteDatabase {
  close(): void;
  exec(sql: string): void;
  open: boolean;
  prepare(sql: string): SqliteStatement;
}

interface SqliteConstructor {
  new (
    filename: string,
    options?: { fileMustExist?: boolean; readonly?: boolean },
  ): SqliteDatabase;
}

interface SafeLauncher {
  applySafeRuntimeConfig(
    config: Record<string, unknown>,
    options: SafeLaunchOptions,
  ): { server: Record<string, unknown> };
  enforceTlsVerification(): void;
  installSafeResumeGuard(videoService: {
    resumeProcessingVideoGenerations(
      database: SqliteDatabase,
      logger?: unknown,
    ): unknown;
  }): void;
  parseLaunchArgs(argv: string[]): SafeLaunchOptions;
  preflightResumableTasks(
    options: SafeLaunchOptions,
    config: Record<string, unknown>,
    Database: SqliteConstructor,
  ): number;
  resolveBindHost(options: SafeLaunchOptions): string;
  resolveDatabasePath(
    backendRoot: string,
    databaseConfig: Record<string, unknown>,
  ): string;
}

const require = createRequire(import.meta.url);
const projectRoot = resolve(import.meta.dirname, "..");
const donorBackendRoot =
  "D:\\AI-story\\repos\\localminidrama\\backend-node";
const safeLauncher = require(
  join(projectRoot, "scripts", "localminidrama-safe-launch.cjs"),
) as SafeLauncher;
const Database = require(
  join(donorBackendRoot, "node_modules", "better-sqlite3"),
) as SqliteConstructor;

const defaultOptions = safeLauncher.parseLaunchArgs([
  "--backend-root",
  donorBackendRoot,
  "--port",
  "5679",
]);
assert.equal(defaultOptions.allowLanBinding, false);
assert.equal(defaultOptions.port, 5679);
assert.equal(safeLauncher.resolveBindHost(defaultOptions), "127.0.0.1");

const lanOptions = safeLauncher.parseLaunchArgs([
  "--backend-root",
  donorBackendRoot,
  "--port",
  "5679",
  "--allow-lan-binding",
]);
assert.equal(safeLauncher.resolveBindHost(lanOptions), "0.0.0.0");
assert.throws(
  () => safeLauncher.parseLaunchArgs(["--allow-insecure-tls"]),
  /Unsupported LocalMiniDrama launch argument/,
);

const safeConfig = safeLauncher.applySafeRuntimeConfig(
  {
    server: {
      host: "0.0.0.0",
      insecure_tls: true,
      INSECURE_TLS: true,
    },
  },
  defaultOptions,
);
assert.equal(safeConfig.server.host, "127.0.0.1");
assert.equal(safeConfig.server.port, 5679);
assert.equal(safeConfig.server.insecure_tls, false);
assert.equal(safeConfig.server.INSECURE_TLS, false);

const inheritedTlsValue = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
safeLauncher.enforceTlsVerification();
assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, undefined);
if (inheritedTlsValue !== undefined) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = inheritedTlsValue;
}

assert.throws(
  () =>
    safeLauncher.resolveDatabasePath(donorBackendRoot, {
      type: "sqlite",
      path: "..\\outside.db",
    }),
  /inside the donor backend root/,
);

const fixtureRoot = mkdtempSync(join(tmpdir(), "aistory-stack-security-"));
try {
  const fixtureBackend = join(fixtureRoot, "backend-node");
  const fixtureData = join(fixtureBackend, "data");
  mkdirSync(fixtureData, { recursive: true });
  const fixtureOptions: SafeLaunchOptions = {
    allowLanBinding: false,
    backendRoot: fixtureBackend,
    port: 5679,
  };
  const fixtureConfig = {
    database: {
      type: "sqlite",
      path: ".\\data\\drama_generator.db",
    },
  };

  assert.equal(
    safeLauncher.preflightResumableTasks(
      fixtureOptions,
      fixtureConfig,
      Database,
    ),
    0,
  );

  const databasePath = join(fixtureData, "drama_generator.db");
  let database = new Database(databasePath);
  database.exec(`
    CREATE TABLE video_generations (
      status TEXT,
      deleted_at TEXT,
      provider_task_id TEXT
    );
    INSERT INTO video_generations VALUES (
      'processing',
      NULL,
      'synthetic-provider-task-id'
    );
  `);
  database.close();

  let blockedMessage = "";
  assert.throws(
    () =>
      safeLauncher.preflightResumableTasks(
        fixtureOptions,
        fixtureConfig,
        Database,
      ),
    (error: unknown) => {
      blockedMessage = error instanceof Error ? error.message : String(error);
      return /1 resumable supplier task/.test(blockedMessage);
    },
  );
  assert.doesNotMatch(blockedMessage, /synthetic-provider-task-id/);

  let originalResumeCalls = 0;
  const fakeVideoService = {
    resumeProcessingVideoGenerations(
      _database: SqliteDatabase,
      _logger?: unknown,
    ) {
      void _database;
      void _logger;
      originalResumeCalls += 1;
    },
  };
  safeLauncher.installSafeResumeGuard(fakeVideoService);
  database = new Database(databasePath);
  assert.throws(
    () => fakeVideoService.resumeProcessingVideoGenerations(database),
    /1 resumable supplier task/,
  );
  database.close();
  assert.equal(originalResumeCalls, 0);

  database = new Database(databasePath);
  database.prepare(
    "UPDATE video_generations SET status = 'completed'",
  ).run();
  database.close();
  database = new Database(databasePath);
  fakeVideoService.resumeProcessingVideoGenerations(database);
  database.close();
  assert.equal(originalResumeCalls, 0);
  assert.equal(
    safeLauncher.preflightResumableTasks(
      fixtureOptions,
      fixtureConfig,
      Database,
    ),
    0,
  );

  database = new Database(databasePath);
  database.exec(`
    DROP TABLE video_generations;
    CREATE TABLE video_generations (status TEXT);
  `);
  database.close();
  assert.throws(
    () =>
      safeLauncher.preflightResumableTasks(
        fixtureOptions,
        fixtureConfig,
        Database,
      ),
    /schema cannot be verified safely/,
  );
} finally {
  rmSync(fixtureRoot, { force: true, recursive: true });
}

const stackScript = readFileSync(
  join(projectRoot, "scripts", "start-aistory-local-stack.ps1"),
  "utf8",
);
const legacyScript = readFileSync(
  join(projectRoot, "scripts", "start-aistory-dev-4200.ps1"),
  "utf8",
);
const launcherSource = readFileSync(
  join(projectRoot, "scripts", "localminidrama-safe-launch.cjs"),
  "utf8",
);
const packageJson = JSON.parse(
  readFileSync(join(projectRoot, "package.json"), "utf8"),
) as { scripts: Record<string, string> };

assert.match(stackScript, /\[switch\]\$AllowLanBinding/);
assert.match(
  stackScript,
  /\$bindHost = if \(\$AllowLanBinding\) \{ "0\.0\.0\.0" \} else \{ "127\.0\.0\.1" \}/,
);
assert.match(stackScript, /localminidrama-safe-launch\.cjs/);
assert.match(stackScript, /-MaximumRedirection 0/);
assert.match(stackScript, /\$status -eq \$Service\.ExpectedStatus/);
assert.match(
  stackScript,
  /4200\/studio"; ExpectedStatus = 200/,
);
assert.match(stackScript, /4107\/health/);
assert.match(stackScript, /LocalAddress/);
assert.match(stackScript, /RequiredCommandLineFragments/);
assert.match(stackScript, /Get-CimInstance/);
assert.match(stackScript, /expected AIstory-owned command/);
assert.doesNotMatch(stackScript, /\$status -lt 500/);
assert.doesNotMatch(stackScript, /Arguments = @\("start"\)/);

assert.match(legacyScript, /\[switch\]\$AllowLanBinding/);
assert.match(legacyScript, /-H \$bindHost/);
assert.doesNotMatch(legacyScript, /-H 0\.0\.0\.0/);

assert.match(packageJson.scripts.dev, /--hostname 127\.0\.0\.1/);
assert.match(packageJson.scripts.start, /--hostname 127\.0\.0\.1/);

assert.match(launcherSource, /delete process\.env\.NODE_TLS_REJECT_UNAUTHORIZED/);
assert.match(launcherSource, /assertNoResumableTasksInDatabase\(database\)/);
assert.match(launcherSource, /installSafeResumeGuard\(videoService\)/);
assert.doesNotMatch(launcherSource, /return originalResume/);
assert.doesNotMatch(launcherSource, /require\([^\n]*server\.js/);
assert.doesNotMatch(
  launcherSource,
  /NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']0["']/,
);

console.log("Local stack security tests passed.");
