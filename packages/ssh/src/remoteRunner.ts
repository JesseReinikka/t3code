import { cliReleaseDownloadBaseUrl } from "@t3tools/shared/cliRelease";
import { satisfiesSemverRange } from "@t3tools/shared/semver";
import * as Schema from "effect/Schema";

export interface RemoteT3RunnerOptions {
  /** Dev mode: run an existing source entry point through remote Node. */
  readonly nodeScriptPath?: string | null;
  readonly nodeEngineRange?: string | null;
  /** Exact self-contained release version; required unless nodeScriptPath is set. */
  readonly archiveVersion?: string | null;
  readonly releaseBaseUrl?: string | null;
}

export class SshInvalidArchiveVersionError extends Schema.TaggedError<SshInvalidArchiveVersionError>()(
  "SshInvalidArchiveVersionError",
  { archiveVersion: Schema.String },
) {
  override get message(): string {
    return `'${this.archiveVersion}' is not an exact t3 version and cannot name a runtime directory.`;
  }
}

export class SshMissingRunnerError extends Schema.TaggedError<SshMissingRunnerError>()(
  "SshMissingRunnerError",
  {},
) {
  override get message(): string {
    return "A remote t3 runner needs an archive version or a node script path.";
  }
}

// Versions name directories that installers remove and replace. Accept only a
// single exact SemVer segment, never paths, ranges, or shell metacharacters.
const EXACT_ARCHIVE_VERSION =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export function resolveRemoteRunner(input?: RemoteT3RunnerOptions) {
  const nodeScriptPath = input?.nodeScriptPath?.trim() || "";
  const archiveVersion = input?.archiveVersion?.trim() || "";
  if (nodeScriptPath === "" && archiveVersion === "") {
    throw new SshMissingRunnerError();
  }
  if (archiveVersion !== "" && !EXACT_ARCHIVE_VERSION.test(archiveVersion)) {
    throw new SshInvalidArchiveVersionError({ archiveVersion });
  }
  const releaseBaseUrl = cliReleaseDownloadBaseUrl("", input?.releaseBaseUrl ?? undefined).replace(
    /\/v$/u,
    "",
  );
  return { nodeScriptPath, archiveVersion, releaseBaseUrl };
}

const remoteNodeEngineCheckMain = function remoteNodeEngineCheckMain(
  satisfiesRange: typeof satisfiesSemverRange,
) {
  const range = process.argv[2] || "";
  const rawVersion =
    process.versions && process.versions.node ? process.versions.node : process.version;

  if (!satisfiesRange(rawVersion, range)) {
    process.stderr.write(
      "Remote node " + rawVersion + " does not satisfy required range " + range + ".\n",
    );
    process.exit(1);
  }
};

export function buildRemoteNodeEngineCheckScript(): string {
  return `(${remoteNodeEngineCheckMain.toString()})(${satisfiesSemverRange.toString()});`;
}
