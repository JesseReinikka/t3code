import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { detectRemoteShell } from "./remoteShell.ts";

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
