"use strict";

/* eslint-disable @typescript-eslint/no-require-imports -- the donor runtime and its require-cache safety overrides are CommonJS-only */

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const LOOPBACK_HOST = "127.0.0.1";
const LAN_HOST = "0.0.0.0";
const DEFAULT_PORT = 5679;
const REQUIRED_VIDEO_COLUMNS = new Set([
  "status",
  "deleted_at",
  "provider_task_id",
]);

class LocalMiniDramaSafeStartError extends Error {
  constructor(message) {
    super(message);
    this.name = "LocalMiniDramaSafeStartError";
  }
}

function parseLaunchArgs(argv) {
  const options = {
    allowLanBinding: false,
    backendRoot: process.cwd(),
    port: DEFAULT_PORT,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--allow-lan-binding") {
      options.allowLanBinding = true;
      continue;
    }
    if (argument === "--backend-root") {
      const value = argv[index + 1];
      if (!value) {
        throw new LocalMiniDramaSafeStartError(
          "Missing value for --backend-root.",
        );
      }
      options.backendRoot = value;
      index += 1;
      continue;
    }
    if (argument === "--port") {
      const value = Number(argv[index + 1]);
      if (!Number.isInteger(value) || value < 1 || value > 65535) {
        throw new LocalMiniDramaSafeStartError("Invalid --port value.");
      }
      options.port = value;
      index += 1;
      continue;
    }
    throw new LocalMiniDramaSafeStartError(
      `Unsupported LocalMiniDrama launch argument: ${argument}`,
    );
  }

  options.backendRoot = path.resolve(options.backendRoot);
  return options;
}

function resolveBindHost(options) {
  return options.allowLanBinding ? LAN_HOST : LOOPBACK_HOST;
}

function applySafeRuntimeConfig(config, options) {
  const host = resolveBindHost(options);
  return {
    ...config,
    server: {
      ...(config.server || {}),
      host,
      port: options.port,
      insecure_tls: false,
      INSECURE_TLS: false,
    },
  };
}

function enforceTlsVerification() {
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
}

function installSafeResumeGuard(videoService) {
  if (typeof videoService?.resumeProcessingVideoGenerations !== "function") {
    throw new LocalMiniDramaSafeStartError(
      "LocalMiniDrama resume guard is unavailable.",
    );
  }
  videoService.resumeProcessingVideoGenerations = (database) => {
    // AIstory never resumes supplier polling as a startup side effect. This
    // synchronous check still blocks a task already present at createApp().
    assertNoResumableTasksInDatabase(database);
  };
}

function resolveDatabasePath(backendRoot, databaseConfig) {
  if (databaseConfig?.type !== "sqlite") {
    throw new LocalMiniDramaSafeStartError(
      "LocalMiniDrama safe start requires the local SQLite database.",
    );
  }
  if (
    typeof databaseConfig.path !== "string" ||
    databaseConfig.path.trim().length === 0
  ) {
    throw new LocalMiniDramaSafeStartError(
      "LocalMiniDrama SQLite path is not configured.",
    );
  }

  const resolvedRoot = path.resolve(backendRoot);
  const resolvedDatabase = path.resolve(resolvedRoot, databaseConfig.path);
  const relative = path.relative(resolvedRoot, resolvedDatabase);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new LocalMiniDramaSafeStartError(
      "LocalMiniDrama SQLite path must stay inside the donor backend root.",
    );
  }
  return resolvedDatabase;
}

function countResumableTasksInDatabase(database) {
  const table = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'video_generations'",
    )
    .get();
  if (!table) {
    return 0;
  }

  const columns = database
    .prepare("PRAGMA table_info(video_generations)")
    .all();
  const columnNames = new Set(columns.map((column) => String(column.name)));
  for (const requiredColumn of REQUIRED_VIDEO_COLUMNS) {
    if (!columnNames.has(requiredColumn)) {
      throw new LocalMiniDramaSafeStartError(
        "LocalMiniDrama video task schema cannot be verified safely.",
      );
    }
  }

  const row = database
    .prepare(
      `SELECT COUNT(*) AS count
       FROM video_generations
       WHERE status = 'processing'
         AND deleted_at IS NULL
         AND provider_task_id IS NOT NULL
         AND TRIM(provider_task_id) != ''`,
    )
    .get();
  const count = Number(row?.count);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new LocalMiniDramaSafeStartError(
      "LocalMiniDrama resumable task count is invalid.",
    );
  }
  return count;
}

function assertNoResumableTasksInDatabase(database) {
  const count = countResumableTasksInDatabase(database);
  if (count > 0) {
    throw new LocalMiniDramaSafeStartError(
      `LocalMiniDrama safe start blocked: ${count} resumable supplier task(s) are pending. Resolve them explicitly before retrying.`,
    );
  }
}

function preflightResumableTasks(options, config, Database) {
  const databasePath = resolveDatabasePath(
    options.backendRoot,
    config.database,
  );
  if (!fs.existsSync(databasePath)) {
    return 0;
  }

  let database;
  try {
    database = new Database(databasePath, {
      readonly: true,
      fileMustExist: true,
    });
    assertNoResumableTasksInDatabase(database);
    return 0;
  } catch (error) {
    if (error instanceof LocalMiniDramaSafeStartError) {
      throw error;
    }
    throw new LocalMiniDramaSafeStartError(
      "LocalMiniDrama resumable task preflight could not be completed safely.",
    );
  } finally {
    if (database?.open) {
      database.close();
    }
  }
}

async function launch(argv = process.argv.slice(2)) {
  const options = parseLaunchArgs(argv);
  const host = resolveBindHost(options);
  const configModulePath = path.join(
    options.backendRoot,
    "src",
    "config",
    "index.js",
  );
  const databaseModulePath = path.join(
    options.backendRoot,
    "node_modules",
    "better-sqlite3",
  );

  process.chdir(options.backendRoot);
  const configModule = require(configModulePath);
  const originalLoadConfig = configModule.loadConfig;
  if (typeof originalLoadConfig !== "function") {
    throw new LocalMiniDramaSafeStartError(
      "LocalMiniDrama config loader is unavailable.",
    );
  }

  const baseConfig = originalLoadConfig();
  const Database = require(databaseModulePath);
  preflightResumableTasks(options, baseConfig, Database);

  const runtimeVersion = JSON.parse(fs.readFileSync(path.join(options.backendRoot, "package.json"), "utf8")).version;
  configModule.loadConfig = () => {
    const config = applySafeRuntimeConfig(originalLoadConfig(), options);
    return { ...config, app: { ...config.app, version: runtimeVersion } };
  };

  // Never inherit the donor's process-wide insecure TLS setting. The AIstory
  // launcher has no insecure-TLS mode because the donor runtime can call real
  // suppliers; a future fake mode must isolate outbound networking first.
  enforceTlsVerification();

  const videoServicePath = path.join(
    options.backendRoot,
    "src",
    "services",
    "videoService.js",
  );
  const videoService = require(videoServicePath);
  installSafeResumeGuard(videoService);

  const appModule = require(
    path.join(options.backendRoot, "src", "app.js"),
  );
  const dbModule = require(
    path.join(options.backendRoot, "src", "db", "index.js"),
  );
  const logger = require(
    path.join(options.backendRoot, "src", "logger.js"),
  );
  const { app, db, config } = appModule.createApp();
  const agentPath = path.join(options.backendRoot, "src", "mastra", "index.mjs");
  if (fs.existsSync(agentPath)) {
    const { initAgent, isAgentReady } = await import(pathToFileURL(agentPath).href);
    await initAgent({ db, log: logger, config,
      dataDir: path.dirname(resolveDatabasePath(options.backendRoot, config.database)) });
    if (!isAgentReady()) {
      dbModule.closeDb();
      throw new LocalMiniDramaSafeStartError("LocalMiniDrama 1.2.9 assistant initialization failed.");
    }
  }
  // Recheck after migrations/app initialization and immediately before the
  // listener exists. The patched donor hook cannot schedule provider polling.
  assertNoResumableTasksInDatabase(db);
  const server = app.listen(options.port, host, () => {
    logger.info("AIstory safe LocalMiniDrama server ready", {
      host,
      port: options.port,
      tlsVerification: true,
    });
  });

  const shutdown = () => {
    server.close(() => {
      dbModule.closeDb();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000).unref();
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return server;
}

if (require.main === module) {
  launch().catch((error) => {
    const safeMessage =
      error instanceof LocalMiniDramaSafeStartError
        ? error.message
        : "LocalMiniDrama safe start failed before listening.";
    console.error(`[safe-start] ${safeMessage}`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_PORT,
  LAN_HOST,
  LOOPBACK_HOST,
  LocalMiniDramaSafeStartError,
  applySafeRuntimeConfig,
  assertNoResumableTasksInDatabase,
  countResumableTasksInDatabase,
  enforceTlsVerification,
  installSafeResumeGuard,
  launch,
  parseLaunchArgs,
  preflightResumableTasks,
  resolveBindHost,
  resolveDatabasePath,
};
