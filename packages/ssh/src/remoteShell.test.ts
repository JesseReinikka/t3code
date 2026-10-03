import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import { detectRemoteShell, tryPosixCommand } from "./remoteShell.ts";

const target = { alias: "remote", hostname: "remote", username: null, port: null };

describe("remote shell detection", () => {
  it.effect.each([
    {
      native: "MINGW64_NT-10.0",
      output: "profile noise\r\nT3_SSH_WINDOWS\r\n",
      code: 0,
      expected: "powershell",
    },
    { native: "Linux", output: "T3_SSH_WINDOWS", code: 0, expected: "posix" },
    { native: "Darwin", output: "", code: 127, expected: "posix" },
    { native: "", output: "", code: 127, expected: "posix" },
  ] as const)("selects $expected from the remote probe", ({ native, output, code, expected }) => {
    const commands: ReadonlyArray<string>[] = [];
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        const args = command._tag === "StandardCommand" ? command.args : [];
        commands.push(args);
        const windows = args.includes("powershell.exe");
        const stdout = Stream.make(
          new TextEncoder().encode(args.includes("uname") ? native : output),
        );
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(123),
          stdout,
          stderr: Stream.empty,
          all: stdout,
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(windows ? code : 0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        });
      }),
    );
    return Effect.gen(function* () {
      assert.equal(yield* detectRemoteShell(target, { batchMode: "yes" }), expected);
      assert.equal(commands.length, expected === "posix" && native ? 1 : 2);
      assert.isTrue(commands.every((args) => args.includes("BatchMode=yes")));
    }).pipe(
      Effect.provide(
        Layer.merge(
          NodeServices.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
      ),
    );
  });

  it.effect.each([
    { code: 255, message: "Connection refused" },
    { code: 255, message: "Permission denied (publickey,password)." },
    { code: 1, message: "Authentication failed" },
  ])("preserves $message without trying another shell", ({ code, message }) => {
    let calls = 0;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.sync(() => {
        calls += 1;
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(123),
          stdout: Stream.empty,
          stderr: Stream.make(new TextEncoder().encode(message)),
          all: Stream.empty,
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        });
      }),
    );
    return Effect.gen(function* () {
      const result = yield* Effect.result(detectRemoteShell(target, {}));
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) assert.include(result.failure.message, message);
      assert.equal(calls, 1);
    }).pipe(
      Effect.provide(
        Layer.merge(
          NodeServices.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
      ),
    );
  });
});

// Execute the POSIX guard and payload; replace only the SSH transport and uname
// result. Windows command-not-found replies are modeled separately below.
describe.skipIf(HostProcessPlatform.defaultValue() === "win32")(
  "combined POSIX detection and bootstrap",
  () => {
    it.effect.each([
      { platform: "Linux", failure: false },
      { platform: "Darwin", failure: false },
      { platform: "Linux", failure: "stderr" },
      { platform: "Linux", failure: "stdout" },
      { platform: "Linux", failure: "silent" },
      { platform: "MINGW64_NT-10.0", failure: false },
      { platform: "missing-sh", failure: false },
    ])("runs safely on $platform (bootstrap failure: $failure)", ({ platform, failure }) =>
      Effect.gen(function* () {
        const realSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const commands: ReadonlyArray<string>[] = [];
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            if (command._tag !== "StandardCommand") throw new Error("Expected SSH command");
            commands.push(command.args);
            if (command.args.includes("powershell.exe")) {
              return yield* realSpawner.spawn(
                ChildProcess.make("/bin/sh", ["-c", "printf T3_SSH_WINDOWS"]),
              );
            }
            const stdin = command.options.stdin;
            if (
              typeof stdin !== "object" ||
              stdin === null ||
              !("stream" in stdin) ||
              !Stream.isStream(stdin.stream)
            ) {
              throw new Error("Expected bootstrap input");
            }
            if (platform === "missing-sh") {
              return yield* realSpawner.spawn(
                ChildProcess.make("/bin/sh", ["-c", "exit 127"], { stdin }),
              );
            }
            const script = yield* stdin.stream.pipe(Stream.decodeText(), Stream.mkString);
            return yield* realSpawner.spawn(
              ChildProcess.make("/bin/sh", ["-s"], {
                stdin: Stream.make(
                  new TextEncoder().encode(`uname() { printf '%s\\n' '${platform}'; }\n` + script),
                ),
              }),
            );
          }),
        );
        const result = yield* Effect.result(
          tryPosixCommand(target, {
            remoteCommandArgs: ["sh", "-l", "-s"],
            stdin:
              failure === "stderr"
                ? "echo 'fixture bootstrap failure' >&2; exit 127"
                : failure === "stdout"
                  ? "echo 'fixture stdout failure'; exit 1"
                  : failure === "silent"
                    ? "exit 1"
                    : "echo payload-executed\n" + "# large bootstrap payload\n".repeat(10_000),
          }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)),
        );
        if (failure) {
          assert.isTrue(Result.isFailure(result));
          if (Result.isFailure(result)) {
            assert.equal(result.failure._tag, "SshCommandError");
            assert.equal(
              result.failure.message,
              failure === "stderr"
                ? "fixture bootstrap failure"
                : failure === "stdout"
                  ? "fixture stdout failure"
                  : "Remote POSIX bootstrap failed (exit 1).",
            );
          }
          assert.equal(commands.length, 1);
        } else {
          assert.isTrue(Result.isSuccess(result));
          if (Result.isSuccess(result)) {
            if (platform.startsWith("MINGW") || platform === "missing-sh") {
              assert.isUndefined(result.success);
              assert.equal(commands.length, 2);
            } else {
              assert.equal(result.success?.stdout.trim(), "payload-executed");
              assert.equal(commands.length, 1);
            }
          }
        }
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  },
);

// A bootstrap that never started may select Windows; an auth/transport failure
// or an unconfirmed platform must retain the original error instead.
describe("POSIX bootstrap fallback", () => {
  it.effect.each([
    { code: 127, message: "sh: command not found", windows: true, probes: 1 },
    { code: 1, message: "sh is not recognized", windows: true, probes: 1 },
    { code: 127, message: "sh: command not found", windows: false, probes: 1 },
    { code: 255, message: "Connection refused", windows: true, probes: 0 },
    { code: 1, message: "Authentication failed", windows: true, probes: 0 },
  ])("handles $message (Windows: $windows)", ({ code, message, windows, probes }) => {
    let calls = 0;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.sync(() => {
        const isProbe = calls++ > 0;
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(123),
          stdout: Stream.make(new TextEncoder().encode(isProbe && windows ? "T3_SSH_WINDOWS" : "")),
          stderr: Stream.make(new TextEncoder().encode(isProbe ? "" : message)),
          all: Stream.empty,
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(isProbe ? 0 : code)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        });
      }),
    );
    return Effect.gen(function* () {
      const result = yield* Effect.result(
        tryPosixCommand(target, { stdin: "echo payload", remoteCommandArgs: ["sh", "-s"] }),
      );
      assert.equal(calls, probes + 1);
      if (windows && probes > 0) {
        assert.isTrue(Result.isSuccess(result));
        if (Result.isSuccess(result)) assert.isUndefined(result.success);
      } else {
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) assert.equal(result.failure.message, message);
      }
    }).pipe(
      Effect.provide(
        Layer.merge(
          NodeServices.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
      ),
    );
  });
});
