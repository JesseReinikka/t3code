// @effect-diagnostics nodeBuiltinImport:off - executes generated PowerShell against isolated fixtures.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";

import * as HostProcess from "@t3tools/shared/HostProcess";

import type { RemoteT3RunnerOptions } from "./remoteRunner.ts";
import { powerShellCommand } from "./remoteShell.ts";
import { buildWindowsRemoteScript } from "./windowsRemote.ts";

const powershell = HostProcess.Platform.defaultValue() === "win32" ? "powershell.exe" : "pwsh";
const available =
  NodeChildProcess.spawnSync(powershell, ["-NoProfile", "-Command", "exit 0"]).status === 0;
const version = "1.2.3";
const stateKey = "1234567890abcdef";
const runner = { archiveVersion: version, releaseBaseUrl: "https://fixture.invalid/releases" };
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

function runPowerShell(script: string, env: NodeJS.ProcessEnv = {}, keepStdinOpen = false) {
  const command = powerShellCommand(script);
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = NodeChildProcess.spawn(powershell, command.remoteCommandArgs.slice(1), {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
      ...(keepStdinOpen ? { timeout: 10_000 } : {}),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    if (keepStdinOpen) child.stdin.write(command.stdin);
    else child.stdin.end(command.stdin);
  });
}

describe.skipIf(!available)("PowerShell transport", () => {
  it("preserves Unicode, quotes, multiline scripts, and explicit failures", async () => {
    const value = "C:\\Users\\O'Neil ä\\project";
    const result = await runPowerShell(
      `$value = ${quote(value)}\n@{ value = $value } | ConvertTo-Json -Compress`,
    );
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ value });
    const failed = await runPowerShell("throw 'fixture failure'");
    expect(failed.code).toBe(1);
    expect(failed.stderr.trim()).toBe("fixture failure");
  });

  it("executes a large UTF-8 payload without waiting for SSH stdin to close", async () => {
    const value = "O'Neil ä 😀".repeat(4_000);
    const result = await runPowerShell(`Write-Output ${quote(value)}`, {}, true);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(value);
  });
});

// These execute the actual installer and lifecycle script in PowerShell on
// POSIX CI. Only HTTP download and the Windows CIM process-creation boundary
// are replaced. Windows SSH session lifetime still requires a Windows host.
describe.skipIf(!available || HostProcess.Platform.defaultValue() !== "linux")(
  "Windows remote scripts",
  () => {
    let root: string;
    let state: string;
    let versions: string;
    let fixture: string;
    let sourceRunner: RemoteT3RunnerOptions & { nodeScriptPath: string };
    let nodeDirectory: string;
    let env: NodeJS.ProcessEnv;
    let spawnedServerPids: Set<number>;
    let stateKeys: Set<string>;

    const runOperation = async (
      operation: "launch" | "pair" | "stop" | "logs",
      options: RemoteT3RunnerOptions = runner,
      connectionKey = stateKey,
    ) => {
      stateKeys.add(connectionKey);
      let script = buildWindowsRemoteScript(connectionKey, operation, options);
      if (env.T3_FIXTURE_RUNTIME_NEVER) {
        const headerEnd = script.indexOf("\n") + 1;
        script =
          script.slice(0, headerEnd) + "$Config.readyTimeoutMs = 1000\n" + script.slice(headerEnd);
      }
      const result = await runPowerShell(fixture + script, env);
      try {
        const owner = JSON.parse(
          await NodeFSP.readFile(
            NodePath.join(root, ".t3/ssh-launch", connectionKey, "owner.json"),
            "utf8",
          ),
        );
        spawnedServerPids.add(owner.pid);
      } catch {
        /* No managed server was created. */
      }
      return result;
    };

    beforeEach(async () => {
      spawnedServerPids = new Set();
      stateKeys = new Set([stateKey]);
      root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-windows-O'Neil ä-"));
      state = NodePath.join(root, ".t3/ssh-launch", stateKey);
      versions = NodePath.join(root, ".t3/runtime/versions");
      env = {
        HOME: root,
        SystemRoot: root,
        PROCESSOR_ARCHITECTURE: "AMD64",
        PROCESSOR_ARCHITEW6432: "",
      };
      const taskkill = NodePath.join(root, "System32/taskkill.exe");
      await NodeFSP.mkdir(NodePath.dirname(taskkill), { recursive: true });
      await NodeFSP.writeFile(
        taskkill,
        `#!${process.execPath}
const fs = require('node:fs');
let denied = false;
function stop(pid) {
  let children = [];
  try { children = fs.readFileSync('/proc/' + pid + '/task/' + pid + '/children', 'utf8').trim().split(/\\s+/).filter(Boolean).map(Number); } catch {}
  for (const child of children) stop(child);
  if (String(pid) === process.env.T3_FIXTURE_KILL_DENIED_PID || process.env.T3_FIXTURE_KILL_DENIED_ALL) { denied = true; return; }
  try { process.kill(pid); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}
stop(Number(process.argv[process.argv.indexOf('/PID') + 1]));
if (denied) process.exitCode = 1;
`,
      );
      await NodeFSP.chmod(taskkill, 0o755);
      const stage = NodePath.join(root, `stage/t3-${version}-win32-x64`);
      await NodeFSP.mkdir(stage, { recursive: true });
      const binary = NodePath.join(stage, "t3.exe");
      await NodeFSP.writeFile(
        binary,
        `#!${process.execPath}
const NodeFSP = require('node:fs');
const NodePath = require('node:path');
const http = require('node:http');
const net = require('node:net');
const args = process.argv.slice(2);
const home = NodePath.join(process.env.HOME, '.t3');
NodeFSP.appendFileSync(NodePath.join(process.env.HOME, 'calls'), JSON.stringify(args) + '\\n');
if (args[0] === '--version') { console.log('t3 ${version}'); }
else if (args[0] === 'auth') { console.log(JSON.stringify({credential: 'fixture-token'})); }
else if (args[0] === 'serve') {
  if (process.env.T3_FIXTURE_CHILD) {
    const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'});
    NodeFSP.writeFileSync(NodePath.join(process.env.HOME, 'server-child'), String(child.pid));
  }
  NodeFSP.writeFileSync(NodePath.join(process.env.HOME, 'started-server'), String(process.pid));
  const port = Number(args[args.indexOf('--port') + 1]);
  const server = http.createServer((req, res) => { res.end('ready'); });
  server.listen(port, '127.0.0.1', () => {
    NodeFSP.mkdirSync(NodePath.join(home, 'userdata'), {recursive: true});
    if (!process.env.T3_FIXTURE_RUNTIME_NEVER) setTimeout(() => NodeFSP.writeFileSync(NodePath.join(home, 'userdata/server-runtime.json'), JSON.stringify({pid: process.pid, port})), Number(process.env.T3_FIXTURE_RUNTIME_DELAY || 0));
    console.log('fixture server ready');
  });
}
else if (args[1] === 'runtime-port') {
  try { const runtime = JSON.parse(NodeFSP.readFileSync(args[2], 'utf8')); process.kill(runtime.pid, 0); console.log(runtime.pid + ' ' + runtime.port); }
  catch { process.exitCode = 1; }
}
else if (args[1] === 'pick-port') {
  const server = net.createServer();
  server.listen(0, '127.0.0.1', () => { console.log(server.address().port); server.close(); });
}
else if (args[1] === 'wait-ready') {
  if (process.env.T3_FIXTURE_READINESS_FAILED) process.exit(1);
  const deadline = Date.now() + Number(args[3]);
  function probe() {
    const request = http.get({hostname:'127.0.0.1', port:Number(args[2]), timeout:1000}, res => { res.resume(); });
    request.on('error', () => { if (Date.now() < deadline) probe(); else process.exitCode = 1; });
    request.on('timeout', () => { request.destroy(); });
  }
  probe();
}
else { process.exitCode = 2; }
`,
      );
      await NodeFSP.chmod(binary, 0o755);
      const sourcePath = NodePath.join(root, "checkout O'Neil ä", "bin.cjs");
      await NodeFSP.mkdir(NodePath.dirname(sourcePath), { recursive: true });
      await NodeFSP.copyFile(binary, sourcePath);
      nodeDirectory = NodePath.join(root, "node O'Neil ä");
      await NodeFSP.mkdir(nodeDirectory);
      await NodeFSP.symlink(process.execPath, NodePath.join(nodeDirectory, "node.exe"));
      env.PATH = nodeDirectory + NodePath.delimiter + process.env.PATH;
      sourceRunner = {
        ...runner,
        nodeScriptPath: sourcePath,
        nodeEngineRange: `^${process.versions.node} || >=999.0.0`,
      };

      const zip = NodePath.join(root, `t3-${version}-win32-x64.zip`);
      const packed = await runPowerShell(
        `Compress-Archive -LiteralPath ${quote(stage)} -DestinationPath ${quote(zip)}`,
      );
      expect(packed.code, packed.stderr).toBe(0);
      const digest = NodeCrypto.createHash("sha256")
        .update(await NodeFSP.readFile(zip))
        .digest("hex");
      await NodeFSP.writeFile(
        NodePath.join(root, "SHA256SUMS"),
        `${digest} *${NodePath.basename(zip)}\n`,
      );
      fixture = `
# .NET on Linux approximates StartTime from uptime, with submillisecond drift
# between callers. Use the kernel start tick to model Windows' exact FILETIME.
$processStartTimeFixture = @'
Update-TypeData -TypeName System.Diagnostics.Process -MemberType ScriptProperty -MemberName StartTime -Value { if ($env:T3_FIXTURE_DENIED_PID -eq [string] $this.Id) { throw 'Access is denied' }; [DateTime]::new([long]([IO.File]::ReadAllText('/proc/' + $this.Id + '/stat').Split(' ')[21]) * 100000) } -Force
function Get-CimInstance($ClassName) {
  Get-ChildItem /proc -Directory | Where-Object { $_.Name -match '^\\d+$' } | ForEach-Object {
    try {
      $stat = [IO.File]::ReadAllText((Join-Path $_.FullName 'stat'))
      $fields = $stat.Substring($stat.LastIndexOf(')') + 2).Split(' ')
      $startedAt = [DateTime]::new([long] $fields[19] * 100000).ToUniversalTime().Ticks
      $parentId = if ($env:T3_FIXTURE_STALE_CHILD_PID -eq $_.Name) { [int] $env:T3_FIXTURE_STALE_PARENT_PID } else { [int] $fields[1] }
      $creationDate = if ($env:T3_FIXTURE_MISSING_CREATION_PID -eq $_.Name) { $null } else { [DateTime]::new($startedAt - $startedAt % 10, [DateTimeKind]::Utc) }
      @{ ProcessId = [int] $_.Name; ParentProcessId = $parentId; CreationDate = $creationDate }
    } catch {}
  }
}
'@
Invoke-Expression $processStartTimeFixture
function Invoke-WebRequest($Uri, $OutFile, $TimeoutSec, [switch] $UseBasicParsing) {
  [IO.File]::AppendAllText(${quote(NodePath.join(root, "downloads"))}, "$Uri" + [Environment]::NewLine)
  Copy-Item -LiteralPath (Join-Path ${quote(root)} ([Uri]$Uri).Segments[-1]) -Destination $OutFile
}
function Expand-Archive($LiteralPath, $DestinationPath) {
  Microsoft.PowerShell.Archive\\Expand-Archive -LiteralPath $LiteralPath -DestinationPath $DestinationPath
  Get-ChildItem -LiteralPath $DestinationPath -Recurse -Filter t3.exe | ForEach-Object { & chmod +x $_.FullName }
}
function New-CimInstance { return $null }
function Invoke-CimMethod($ClassName, $MethodName, $Arguments) {
  $launcher = Join-Path $StateDir 'run-server.ps1'
  $content = $processStartTimeFixture + [Environment]::NewLine + [IO.File]::ReadAllText($launcher).Replace(' -WindowStyle Hidden', '')
  if ($env:T3_FIXTURE_OWNER_FAILURE) {
    New-Item -ItemType Directory -Path (Join-Path $StateDir 'owner.json.next'), (Join-Path $StateDir 'launch-error') | Out-Null
  }
  [IO.File]::WriteAllText($launcher, $content)
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes(("& '" + $launcher.Replace("'", "''") + "'")))
  $child = Start-Process -FilePath ${quote(powershell)} -ArgumentList @('-NoProfile', '-NonInteractive', '-EncodedCommand', $encoded) -PassThru -RedirectStandardOutput (Join-Path $StateDir 'launcher.log') -RedirectStandardError (Join-Path $StateDir 'launcher.err.log')
  [IO.File]::WriteAllText(${quote(NodePath.join(root, "created-launcher"))}, [string] $child.Id)
  if ($env:T3_FIXTURE_INTERRUPT) { exit 73 }
  return @{ReturnValue = 0; ProcessId = $child.Id}
}
`;
    });

    afterEach(async () => {
      try {
        for (const key of stateKeys) {
          const stopped = await runOperation("stop", runner, key);
          expect(stopped.code, stopped.stderr).toBe(0);
        }
      } finally {
        for (const pid of spawnedServerPids) {
          if (pid === process.pid) continue;
          try {
            process.kill(pid);
          } catch {
            /* Already stopped by the script. */
          }
        }
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    });

    it("serializes cold installs, verifies the ZIP, and pairs from a quoted home path", async () => {
      const results = await Promise.all([runOperation("pair"), runOperation("pair")]);
      for (const result of results) {
        expect(result.code, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({ credential: "fixture-token" });
      }
      expect(
        await NodeFSP.readFile(NodePath.join(versions, version, ".install-complete"), "utf8"),
      ).toBe(version);
      expect(
        (await NodeFSP.readFile(NodePath.join(root, "downloads"), "utf8")).trim().split("\n"),
      ).toHaveLength(2);
      const calls = (await NodeFSP.readFile(NodePath.join(root, "calls"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(calls.filter((args) => args[0] === "auth")).toEqual([
        ["auth", "pairing", "create", "--base-dir", NodePath.join(root, ".t3"), "--json"],
        ["auth", "pairing", "create", "--base-dir", NodePath.join(root, ".t3"), "--json"],
      ]);
    });

    it.each(["node", "script", "engine"])(
      "rejects a missing or incompatible source-runner prerequisite: %s",
      async (prerequisite) => {
        let options = sourceRunner;
        let diagnostic: string;
        if (prerequisite === "node") {
          await NodeFSP.unlink(NodePath.join(nodeDirectory, "node.exe"));
          diagnostic = "Remote node.exe was not found on the SSH session PATH";
        } else if (prerequisite === "script") {
          options = { ...sourceRunner, nodeScriptPath: NodePath.join(root, "missing.cjs") };
          diagnostic = "Remote Node script does not exist";
        } else {
          options = { ...sourceRunner, nodeEngineRange: ">=999.0.0" };
          diagnostic = "does not satisfy required range >=999.0.0";
        }
        for (const operation of ["launch", "pair"] as const) {
          const failed = await runOperation(operation, options);
          expect(failed.code).toBe(1);
          expect(failed.stderr).toContain(diagnostic);
        }
        await expect(NodeFSP.stat(NodePath.join(root, "calls"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(NodeFSP.stat(NodePath.join(root, "downloads"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      },
    );

    it("starts, pairs, reuses, logs, and stops a source runner with quoted paths without downloading", async () => {
      const launched = await runOperation("launch", sourceRunner);
      expect(launched.code, launched.stderr).toBe(0);
      expect(JSON.parse(launched.stdout).serverKind).toBe("managed");
      const ownerPath = NodePath.join(state, "owner.json");
      const owner = JSON.parse(await NodeFSP.readFile(ownerPath, "utf8"));
      expect(JSON.parse(owner.runner)).toMatchObject({
        executable: NodePath.join(nodeDirectory, "node.exe"),
        arguments: [sourceRunner.nodeScriptPath],
      });
      const paired = await runOperation("pair", sourceRunner);
      expect(paired.code, paired.stderr).toBe(0);
      expect(JSON.parse(paired.stdout)).toEqual({ credential: "fixture-token" });
      // Release configuration is irrelevant when the source runner takes precedence.
      const reused = await runOperation("launch", { ...sourceRunner, archiveVersion: "9.9.9" });
      expect(reused.code, reused.stderr).toBe(0);
      expect(JSON.parse(await NodeFSP.readFile(ownerPath, "utf8")).pid).toBe(owner.pid);
      const logs = await runOperation("logs", sourceRunner);
      expect(logs.code, logs.stderr).toBe(0);
      expect(logs.stdout).toContain("fixture server ready");
      const calls = (await NodeFSP.readFile(NodePath.join(root, "calls"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(calls.filter((args) => args[0] === "auth")).toEqual([
        ["auth", "pairing", "create", "--base-dir", NodePath.join(root, ".t3"), "--json"],
      ]);
      expect(calls.filter((args) => args[0] === "serve")).toHaveLength(1);
      await expect(NodeFSP.stat(NodePath.join(root, "downloads"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(NodeFSP.stat(versions)).rejects.toMatchObject({ code: "ENOENT" });
      // Shutdown must not require the checkout or Node to still exist.
      await NodeFSP.unlink(sourceRunner.nodeScriptPath);
      await NodeFSP.unlink(NodePath.join(nodeDirectory, "node.exe"));
      const stopped = await runOperation("stop", sourceRunner);
      expect(stopped.code, stopped.stderr).toBe(0);
      expect(() => process.kill(owner.pid, 0)).toThrow();
      await expect(NodeFSP.stat(ownerPath)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("replaces managed runners when the script, Node executable, or runner mode changes", async () => {
      const ownerPath = NodePath.join(state, "owner.json");
      let previousPid: number | undefined;
      const launchReplacement = async (options: RemoteT3RunnerOptions) => {
        const result = await runOperation("launch", options);
        expect(result.code, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout).serverKind).toBe("managed");
        const owner = JSON.parse(await NodeFSP.readFile(ownerPath, "utf8"));
        if (previousPid !== undefined) {
          expect(owner.pid).not.toBe(previousPid);
          expect(() => process.kill(previousPid!, 0)).toThrow();
        }
        previousPid = owner.pid;
      };
      await launchReplacement(sourceRunner);
      const nextScript = NodePath.join(root, "next checkout ä.cjs");
      await NodeFSP.copyFile(sourceRunner.nodeScriptPath, nextScript);
      const nextRunner = { ...sourceRunner, nodeScriptPath: nextScript };
      await launchReplacement(nextRunner);
      const nextNodeDirectory = NodePath.join(root, "next node");
      await NodeFSP.mkdir(nextNodeDirectory);
      await NodeFSP.symlink(process.execPath, NodePath.join(nextNodeDirectory, "node.exe"));
      env.PATH = nextNodeDirectory + NodePath.delimiter + process.env.PATH;
      await launchReplacement(nextRunner);
      await launchReplacement(runner);
      await launchReplacement(nextRunner);
    });

    it("cleans an invalid download and retries successfully", async () => {
      const sums = NodePath.join(root, "SHA256SUMS");
      const valid = await NodeFSP.readFile(sums, "utf8");
      await NodeFSP.writeFile(sums, valid.replace(/^[a-f0-9]+/u, "0".repeat(64)));
      const failed = await runOperation("pair");
      expect(failed.code).toBe(1);
      expect(failed.stderr).toContain("Checksum mismatch");
      expect((await NodeFSP.readdir(versions)).filter((name) => !name.endsWith(".lock"))).toEqual(
        [],
      );
      await NodeFSP.writeFile(sums, valid);
      const retried = await runOperation("pair");
      expect(retried.code, retried.stderr).toBe(0);
    });

    it("reuses a managed server, restarts a changed runner, reads logs, and stops the actual PID", async () => {
      const launched = await runOperation("launch");
      expect(launched.code, launched.stderr).toBe(0);
      expect(JSON.parse(launched.stdout).serverKind).toBe("managed");
      const ownerPath = NodePath.join(state, "owner.json");
      const firstOwner = JSON.parse(await NodeFSP.readFile(ownerPath, "utf8"));
      const reused = await runOperation("launch");
      expect(reused.code, reused.stderr).toBe(0);
      expect(JSON.parse(await NodeFSP.readFile(ownerPath, "utf8")).pid).toBe(firstOwner.pid);
      const changed = await runOperation("launch", {
        ...runner,
        releaseBaseUrl: "https://other.invalid/releases",
      });
      expect(changed.code, changed.stderr).toBe(0);
      const nextOwner = JSON.parse(await NodeFSP.readFile(ownerPath, "utf8"));
      expect(nextOwner.pid).not.toBe(firstOwner.pid);
      const logs = await runOperation("logs");
      expect(logs.stdout).toContain("fixture server ready");
      const stopped = await runOperation("stop");
      expect(stopped.code, stopped.stderr).toBe(0);
      await expect(NodeFSP.stat(ownerPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(() => process.kill(nextOwner.pid, 0)).toThrow();
    });

    it.each(["release", "source"])(
      "reuses an external server and never kills it on disconnect (%s)",
      async (mode) => {
        const options =
          mode === "source" ? { nodeScriptPath: sourceRunner.nodeScriptPath } : runner;
        const launched = await runOperation("launch", options);
        expect(launched.code, launched.stderr).toBe(0);
        const ownerPath = NodePath.join(state, "owner.json");
        const owner = await NodeFSP.readFile(ownerPath, "utf8");
        await expect(NodeFSP.stat(NodePath.join(state, "launcher.json"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        await NodeFSP.unlink(ownerPath);
        try {
          const external = await runOperation("launch", options);
          expect(external.code, external.stderr).toBe(0);
          expect(JSON.parse(external.stdout).serverKind).toBe("external");
          expect((await runOperation("stop")).code).toBe(0);
          expect(() => process.kill(JSON.parse(owner).pid, 0)).not.toThrow();
        } finally {
          await NodeFSP.writeFile(ownerPath, owner);
        }
      },
    );

    it("preserves a live managed server when reconnect readiness fails and reuses it on retry", async () => {
      const launched = await runOperation("launch");
      expect(launched.code, launched.stderr).toBe(0);
      const ownerPath = NodePath.join(state, "owner.json");
      const owner = await NodeFSP.readFile(ownerPath, "utf8");
      const pid = JSON.parse(owner).pid;

      env.T3_FIXTURE_READINESS_FAILED = "1";
      const failed = await runOperation("launch");
      expect(failed.code).toBe(1);
      expect(failed.stderr).toContain("the server was left running");
      expect(await NodeFSP.readFile(ownerPath, "utf8")).toBe(owner);
      expect(() => process.kill(pid, 0)).not.toThrow();

      delete env.T3_FIXTURE_READINESS_FAILED;
      const retried = await runOperation("launch");
      expect(retried.code, retried.stderr).toBe(0);
      expect(JSON.parse(retried.stdout)).toEqual(JSON.parse(launched.stdout));
      expect(await NodeFSP.readFile(ownerPath, "utf8")).toBe(owner);
      const calls = (await NodeFSP.readFile(NodePath.join(root, "calls"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(calls.filter((args) => args[0] === "serve")).toHaveLength(1);
    });

    it("serializes concurrent launches for the same SSH connection", async () => {
      const results = await Promise.all([runOperation("launch"), runOperation("launch")]);
      for (const result of results) expect(result.code, result.stderr).toBe(0);
      const launches = results.map((result) => JSON.parse(result.stdout));
      expect(launches[0].remotePort).toBe(launches[1].remotePort);
      expect(launches.map((result) => result.serverKind)).toEqual(["managed", "managed"]);
      const calls = (await NodeFSP.readFile(NodePath.join(root, "calls"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(calls.filter((args) => args[0] === "serve")).toHaveLength(1);
    });

    it("starts only one server when different SSH aliases connect concurrently", async () => {
      env.T3_FIXTURE_RUNTIME_DELAY = "2000";
      const results = await Promise.all([
        runOperation("launch"),
        runOperation("launch", runner, "fedcba0987654321"),
      ]);
      for (const result of results) expect(result.code, result.stderr).toBe(0);
      const launches = results.map((result) => JSON.parse(result.stdout));
      expect(launches[0].remotePort).toBe(launches[1].remotePort);
      expect(launches.map((result) => result.serverKind).sort()).toEqual(["external", "managed"]);
      const calls = (await NodeFSP.readFile(NodePath.join(root, "calls"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(calls.filter((args) => args[0] === "serve")).toHaveLength(1);
    });

    it("cancels an unregistered launcher when the bootstrap exits", async () => {
      env.T3_FIXTURE_INTERRUPT = "1";
      const interrupted = await runOperation("launch");
      expect(interrupted.code).toBe(73);
      delete env.T3_FIXTURE_INTERRUPT;
      const launcherPid = Number(
        await NodeFSP.readFile(NodePath.join(root, "created-launcher"), "utf8"),
      );
      spawnedServerPids.add(launcherPid);
      const joined = await runPowerShell(
        `$p = Get-Process -Id ${launcherPid} -ErrorAction SilentlyContinue; if ($p -and -not $p.WaitForExit(5000)) { throw 'Launcher did not exit' }`,
      );
      expect(joined.code, joined.stderr).toBe(0);
      const calls = (await NodeFSP.readFile(NodePath.join(root, "calls"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(calls.filter((args) => args[0] === "serve")).toHaveLength(0);
      await expect(NodeFSP.stat(NodePath.join(state, "owner.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });

    it("stops the server even when ownership publication and diagnostic writes both fail", async () => {
      env.T3_FIXTURE_OWNER_FAILURE = "1";
      const failed = await runOperation("launch");
      expect(failed.code).toBe(1);
      const serverPid = Number(
        await NodeFSP.readFile(NodePath.join(root, "started-server"), "utf8"),
      );
      spawnedServerPids.add(serverPid);
      expect(() => process.kill(serverPid, 0)).toThrow();
      await expect(NodeFSP.stat(NodePath.join(state, "owner.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });

    it("does not stop a process when the recorded PID has a different start time", async () => {
      await NodeFSP.mkdir(state, { recursive: true });
      await NodeFSP.writeFile(
        NodePath.join(state, "owner.json"),
        JSON.stringify({ pid: process.pid, startedAt: "0" }),
      );
      const stopped = await runOperation("stop");
      expect(stopped.code, stopped.stderr).toBe(0);
      expect(() => process.kill(process.pid, 0)).not.toThrow();
    });

    it("treats a recorded PID whose start time is denied as not owned", async () => {
      await NodeFSP.mkdir(state, { recursive: true });
      await NodeFSP.writeFile(
        NodePath.join(state, "owner.json"),
        JSON.stringify({ pid: process.pid, startedAt: "0" }),
      );
      env.T3_FIXTURE_DENIED_PID = String(process.pid);
      const stopped = await runOperation("stop");
      expect(stopped.code, stopped.stderr).toBe(0);
      expect(() => process.kill(process.pid, 0)).not.toThrow();
    });

    it("ignores an older inaccessible process with a recycled parent PID", async () => {
      const launched = await runOperation("launch");
      expect(launched.code, launched.stderr).toBe(0);
      const owner = JSON.parse(await NodeFSP.readFile(NodePath.join(state, "owner.json"), "utf8"));
      env.T3_FIXTURE_STALE_CHILD_PID = String(process.pid);
      env.T3_FIXTURE_STALE_PARENT_PID = String(owner.pid);
      env.T3_FIXTURE_DENIED_PID = String(process.pid);

      const stopped = await runOperation("stop");

      expect(stopped.code, stopped.stderr).toBe(0);
      expect(() => process.kill(owner.pid, 0)).toThrow();
      expect(() => process.kill(process.pid, 0)).not.toThrow();
    });

    it("discards stale pending ownership when CIM disproves an inaccessible PID's identity", async () => {
      await NodeFSP.mkdir(state, { recursive: true });
      const pending = NodePath.join(state, "stop-pending.json");
      await NodeFSP.writeFile(pending, JSON.stringify([{ pid: process.pid, startedAt: "0" }]));
      env.T3_FIXTURE_DENIED_PID = String(process.pid);

      const stopped = await runOperation("stop");

      expect(stopped.code, stopped.stderr).toBe(0);
      await expect(NodeFSP.stat(pending)).rejects.toMatchObject({ code: "ENOENT" });
      expect(() => process.kill(process.pid, 0)).not.toThrow();
    });

    it.each([false, true])(
      "keeps unverifiable pending cleanup (missing CIM creation time: %s)",
      async (missingCreationTime) => {
        const launched = await runOperation("launch");
        expect(launched.code, launched.stderr).toBe(0);
        const owner = JSON.parse(
          await NodeFSP.readFile(NodePath.join(state, "owner.json"), "utf8"),
        );
        const pending = NodePath.join(state, "stop-pending.json");
        await NodeFSP.writeFile(pending, JSON.stringify([owner]));
        env.T3_FIXTURE_DENIED_PID = String(owner.pid);
        if (missingCreationTime) env.T3_FIXTURE_MISSING_CREATION_PID = String(owner.pid);
        try {
          const stopped = await runOperation("stop");
          expect(stopped.code).toBe(1);
          expect(stopped.stderr).toContain("Cannot verify a pending stop process");
          expect(JSON.parse(await NodeFSP.readFile(pending, "utf8"))).toHaveLength(1);
          expect(() => process.kill(owner.pid, 0)).not.toThrow();
        } finally {
          delete env.T3_FIXTURE_DENIED_PID;
          delete env.T3_FIXTURE_MISSING_CREATION_PID;
        }
      },
    );

    it("retains surviving children after partial taskkill failure and stops them on retry", async () => {
      env.T3_FIXTURE_CHILD = "1";
      const launched = await runOperation("launch");
      expect(launched.code, launched.stderr).toBe(0);
      const childPid = Number(await NodeFSP.readFile(NodePath.join(root, "server-child"), "utf8"));
      spawnedServerPids.add(childPid);
      const owner = JSON.parse(await NodeFSP.readFile(NodePath.join(state, "owner.json"), "utf8"));
      env.T3_FIXTURE_KILL_DENIED_PID = String(childPid);
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          const stopped = await runOperation("stop");
          expect(stopped.code).toBe(1);
          expect(stopped.stderr).toContain("process tree did not stop");
          expect(() => process.kill(childPid, 0)).not.toThrow();
          expect(() => process.kill(owner.pid, 0)).toThrow();
          const pending = JSON.parse(
            await NodeFSP.readFile(NodePath.join(state, "stop-pending.json"), "utf8"),
          );
          expect(pending.some((process: { pid: number }) => process.pid === childPid)).toBe(true);
        }
      } finally {
        delete env.T3_FIXTURE_KILL_DENIED_PID;
      }
      const recovered = await runOperation("stop");
      expect(recovered.code, recovered.stderr).toBe(0);
      expect(() => process.kill(childPid, 0)).toThrow();
      await expect(NodeFSP.stat(NodePath.join(state, "stop-pending.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });

    it("rejects launch and reuse when discovery fails and cleanup cannot stop the server", async () => {
      env.T3_FIXTURE_RUNTIME_NEVER = "1";
      env.T3_FIXTURE_KILL_DENIED_ALL = "1";
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          const launched = await runOperation("launch");
          expect(launched.code).toBe(1);
          expect(launched.stderr).toContain("process tree did not stop");
          const owner = JSON.parse(
            await NodeFSP.readFile(NodePath.join(state, "owner.json"), "utf8"),
          );
          expect(() => process.kill(owner.pid, 0)).not.toThrow();
          expect(await NodeFSP.stat(NodePath.join(state, "stop-pending.json"))).toBeDefined();
        }
      } finally {
        delete env.T3_FIXTURE_RUNTIME_NEVER;
        delete env.T3_FIXTURE_KILL_DENIED_ALL;
      }
    });
  },
);
