import * as NodeBuffer from "node:buffer";

import type { DesktopSshEnvironmentTarget } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { type SshAuthOptions, isSshAuthFailure } from "./auth.ts";
import { runSshCommand, type RunSshCommandOptions } from "./command.ts";
import { SshCommandError } from "./errors.ts";

export type RemoteShell = "posix" | "powershell";

// Only this small loader travels through the SSH server's default shell. The
// payload goes over stdin, avoiding cmd.exe's command-length limit and quoting.
// Windows OpenSSH can leave stdin open after a large payload; read its byte
// count explicitly instead of waiting for EOF.
export function powerShellCommand(script: string) {
  const loader = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$OutputEncoding = [Console]::OutputEncoding
try {
  $stream = [Console]::OpenStandardInput()
  $bytes = New-Object byte[] ${NodeBuffer.Buffer.byteLength(script, "utf8")}
  $offset = 0
  while ($offset -lt $bytes.Length) {
    $read = $stream.Read($bytes, $offset, $bytes.Length - $offset)
    if ($read -eq 0) { throw 'Incomplete PowerShell script received over SSH.' }
    $offset += $read
  }
  & ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString($bytes)))
}
catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
`;
  return {
    remoteCommandArgs: [
      "powershell.exe",
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      NodeBuffer.Buffer.from(loader, "utf16le").toString("base64"),
    ],
    stdin: script,
  };
}

const probeRemoteShell = (target: DesktopSshEnvironmentTarget, input: RunSshCommandOptions) =>
  runSshCommand(target, input).pipe(
    Effect.catchTag("SshCommandError", (error) =>
      error.exitCode === null || error.exitCode === 255 || isSshAuthFailure(error)
        ? Effect.fail(error)
        : Effect.succeed({ stdout: "", stderr: error.stderr }),
    ),
  );

/** Detects the remote shell without running bootstrap code or guessing from local OS. */
export const detectRemoteShell = Effect.fn("ssh/detectRemoteShell")(function* (
  target: DesktopSshEnvironmentTarget,
  auth: SshAuthOptions,
) {
  // WSL can run powershell.exe through interop. Identify its Linux environment
  // first; Git Bash's MINGW/MSYS uname still falls through to native Windows.
  const uname = yield* probeRemoteShell(target, {
    ...auth,
    remoteCommandArgs: ["uname", "-s"],
  });
  if (uname.stdout.split(/\r?\n/u).some((line) => ["Linux", "Darwin"].includes(line.trim()))) {
    return "posix" as const;
  }
  return (yield* isWindowsHost(target, auth)) ? ("powershell" as const) : ("posix" as const);
});

const isWindowsHost = Effect.fn("ssh/isWindowsHost")(function* (
  target: DesktopSshEnvironmentTarget,
  auth: SshAuthOptions,
) {
  const windows = yield* probeRemoteShell(target, {
    ...auth,
    ...powerShellCommand(
      "if ($env:OS -eq 'Windows_NT') { Write-Output 'T3_SSH_WINDOWS' } else { exit 1 }",
    ),
  });
  return windows.stdout.split(/\r?\n/u).some((line) => line.trim() === "T3_SSH_WINDOWS");
});

const POSIX_STARTED = "T3_SSH_POSIX_STARTED\n";

/** Runs the POSIX bootstrap in the first connection; undefined selects a confirmed Windows host. */
export const tryPosixCommand = Effect.fn("ssh/tryPosixCommand")(function* (
  target: DesktopSshEnvironmentTarget,
  input: RunSshCommandOptions & { readonly stdin: string },
) {
  // Check before the bootstrap can create files or processes. Git Bash also
  // has sh, but must take the native Windows path; WSL must stay on POSIX.
  const guard = String.raw`case "$(uname -s)" in
  Linux|Darwin) ;;
  *) printf '%s\n' 'Unsupported remote platform for T3 SSH.' >&2; exit 1 ;;
esac
printf '%s\n' 'T3_SSH_POSIX_STARTED' >&2
`;
  return yield* runSshCommand(target, { ...input, stdin: guard + input.stdin }).pipe(
    Effect.catchTag("SshCommandError", (error) =>
      Effect.gen(function* () {
        // Once the bootstrap started, its failure must never trigger another
        // launch. Keep authentication/transport failures on their existing path.
        if (error.stderr.includes(POSIX_STARTED)) {
          const stderr = error.stderr.replace(POSIX_STARTED, "");
          return yield* new SshCommandError({
            ...error,
            stderr,
            message:
              stderr.trim() ||
              error.stdout?.trim() ||
              `Remote POSIX bootstrap failed (exit ${error.exitCode}).`,
          });
        }
        if (error.exitCode === null || error.exitCode === 255 || isSshAuthFailure(error)) {
          return yield* error;
        }
        if (yield* isWindowsHost(target, input)) return undefined;
        return yield* error;
      }),
    ),
  );
});
