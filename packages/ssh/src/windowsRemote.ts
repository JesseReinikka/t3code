import * as NodeBuffer from "node:buffer";

import {
  DEFAULT_REMOTE_PORT,
  REMOTE_ARCHIVE_CHECKSUMS_SECONDS,
  REMOTE_ARCHIVE_DOWNLOAD_SECONDS,
  REMOTE_ARCHIVE_LOCK_WAIT_SECONDS,
  REMOTE_PORT_SCAN_WINDOW,
  REMOTE_READY_TIMEOUT_MS,
  REMOTE_REUSE_READY_TIMEOUT_MS,
  SSH_READY_PROBE_TIMEOUT_MS,
} from "./remoteLimits.ts";
import {
  buildRemoteNodeEngineCheckScript,
  resolveRemoteRunner,
  type RemoteT3RunnerOptions,
} from "./remoteRunner.ts";

type WindowsRemoteOperation = "launch" | "pair" | "stop" | "logs";

// Launch, stop, and launch cleanup wait this long on the shared launch lock.
const WINDOWS_LOCK_WAIT_SECONDS = 90;
/** Stop may wait out the launch lock before killing the owned process tree. */
export const WINDOWS_STOP_TIMEOUT_MS = (WINDOWS_LOCK_WAIT_SECONDS + 10) * 1000;

const INVOKE_NATIVE = String.raw`
# Windows PowerShell 5.1 turns native stderr into error records when its own
# stderr is redirected, so Stop would abort on any warning. Callers check
# $LASTEXITCODE instead.
function Invoke-Native([string] $FilePath, [string[]] $Arguments) {
  $ErrorActionPreference = 'Continue'
  & $FilePath @Arguments
}

function Invoke-Runner($Runner, [string[]] $Arguments) {
  Invoke-Native $Runner.executable (@($Runner.arguments) + $Arguments)
}
`;

const PROCESS_OWNERSHIP = String.raw`
function Read-Text([string] $Path) {
  if (Test-Path -LiteralPath $Path -PathType Leaf) {
    return [IO.File]::ReadAllText($Path).Trim()
  }
  return ''
}

function Read-Owner([string] $Path = $OwnerFile) {
  $text = Read-Text $Path
  if ($text) { return ($text | ConvertFrom-Json) }
  return $null
}

function Get-OwnedProcess($Owner, [switch] $RequireIdentity) {
  if (-not $Owner) { return $null }
  $process = Get-Process -Id $Owner.pid -ErrorAction SilentlyContinue
  if (-not $process) { return $null }
  # A recycled PID must never authorize stopping an unrelated process. Another
  # user's or SYSTEM's process denies StartTime, which also means not ours.
  try { $startedAt = $process.StartTime.ToUniversalTime().Ticks.ToString() } catch {
    if ($RequireIdentity) { throw 'Cannot verify a pending stop process. Its ownership files were kept.' }
    return $null
  }
  if ($startedAt -eq $Owner.startedAt) { return $process }
  return $null
}

function Get-ProcessTreeOwners($Owner, $Processes, $Seen, [bool] $RequireIdentity) {
  if (-not $Owner) { return }
  $key = [string] $Owner.pid + ':' + $Owner.startedAt
  if ($Seen.ContainsKey($key)) { return }
  # CIM can disprove stale ownership even when the replacement process denies
  # StartTime. It never authorizes a kill; exact identity is still required.
  $recordedTime = [long] $Owner.startedAt
  $snapshot = $Processes | Where-Object { $_.ProcessId -eq $Owner.pid } | Select-Object -First 1
  if ($snapshot.CreationDate -and $snapshot.CreationDate.ToUniversalTime().Ticks -ne ($recordedTime - $recordedTime % 10)) { return }
  $process = Get-OwnedProcess $Owner -RequireIdentity:$RequireIdentity
  if (-not $process) { return }
  $Seen[$key] = $true
  $Owner
  foreach ($child in @($Processes | Where-Object { $_.ParentProcessId -eq $process.Id })) {
    # Reject a stale parent PID before opening an unrelated protected child.
    # Round the parent too: CIM loses the sub-microsecond part of StartTime.
    $snapshotTime = $child.CreationDate.ToUniversalTime().Ticks
    if ($snapshotTime -lt ($recordedTime - $recordedTime % 10)) { continue }
    $childProcess = Get-Process -Id $child.ProcessId -ErrorAction SilentlyContinue
    if (-not $childProcess) { continue }
    try { $startedAt = $childProcess.StartTime.ToUniversalTime().Ticks } catch {
      throw 'Cannot verify a child process before stopping its tree. Its ownership files were kept.'
    }
    # CIM records microseconds; Process.StartTime also includes 100ns ticks.
    if (($startedAt - $startedAt % 10) -ne $snapshotTime) { continue }
    # A child older than its alleged parent belongs to a recycled parent PID.
    if ($startedAt -lt [long] $Owner.startedAt) { continue }
    Get-ProcessTreeOwners @{ pid = $childProcess.Id; startedAt = $startedAt.ToString() } $Processes $Seen $true
  }
}

function Stop-ProcessTrees($Roots) {
  $pendingOwners = @(Read-Owner $StopFile)
  $requireIdentity = Test-Path -LiteralPath $StopFile
  $roots = @($pendingOwners) + @($Roots) | Where-Object { $_ }
  $stopOwners = @()
  if ($roots) {
    $processes = @(Get-CimInstance -ClassName Win32_Process)
    $seen = @{}
    $stopOwners = @($roots | ForEach-Object { Get-ProcessTreeOwners $_ $processes $seen $requireIdentity })
    # Refresh on retries: surviving children can have spawned more descendants.
    [IO.File]::WriteAllText(($StopFile + '.next'), (ConvertTo-Json -InputObject $stopOwners -Compress), $Utf8)
    Move-Item -LiteralPath ($StopFile + '.next') -Destination $StopFile -Force
  }
  foreach ($owner in $stopOwners) {
    $process = Get-OwnedProcess $owner -RequireIdentity
    if ($process -and -not $process.HasExited) {
      # Windows has no SIGTERM; stop the owned tree so provider/terminal
      # children do not outlive a killed server or a cancelled launcher.
      Invoke-Native (Join-Path $env:SystemRoot 'System32/taskkill.exe') @('/PID', $process.Id, '/T', '/F') | Out-Null
      if ($LASTEXITCODE -ne 0 -or -not $process.WaitForExit(2000)) {
        throw 'Remote T3 process tree did not stop. Its ownership files were kept.'
      }
    }
  }
}
`;

// Keep this script compatible with Windows PowerShell 5.1.
const COMMON = String.raw`
$T3Home = Join-Path $HOME '.t3'
$StateDir = Join-Path $T3Home ('ssh-launch/' + $Config.stateKey)
$OwnerFile = Join-Path $StateDir 'owner.json'
$LauncherFile = Join-Path $StateDir 'launcher.json'
$StopFile = Join-Path $StateDir 'stop-pending.json'
$PendingFile = Join-Path $T3Home 'ssh-launch/windows-pending.json'
$PortFile = Join-Path $StateDir 'port'
$LogFile = Join-Path $StateDir 'server.log'
$ErrorLogFile = Join-Path $StateDir 'server.err.log'
$Utf8 = New-Object System.Text.UTF8Encoding $false

${INVOKE_NATIVE}
${PROCESS_OWNERSHIP}

function Stop-OwnedServer {
  $launcher = Read-Owner $LauncherFile
  Stop-ProcessTrees @($launcher, (Read-Owner))
  $pending = Read-Owner $PendingFile
  if ($launcher -and $pending -and $pending.token -eq $launcher.token) {
    Remove-Item -LiteralPath $PendingFile -Force
  }
  Remove-Item -LiteralPath $StopFile, $LauncherFile, $OwnerFile, $PortFile -Force -ErrorAction SilentlyContinue
}

function Read-ServerLogs {
  foreach ($file in @($LogFile, $ErrorLogFile)) {
    if (Test-Path -LiteralPath $file) {
      Get-Content -LiteralPath $file -Encoding UTF8 -Tail 80
    }
  }
}

function Open-Lock([string] $Path, [int] $TimeoutSeconds) {
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ($true) {
    try {
      # Exclusive handles are released on process exit, including crashes.
      # Keep the empty file: deleting it would race the next lock owner.
      return [IO.File]::Open($Path, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    } catch [IO.IOException] {
      if ([DateTime]::UtcNow -ge $deadline) { throw "Timed out waiting for lock $Path." }
      Start-Sleep -Milliseconds 200
    }
  }
}
`;

const INSTALL = String.raw`
function Install-Runtime {
  $version = $Config.archiveVersion
  $versions = Join-Path $T3Home 'runtime/versions'
  $runtime = Join-Path $versions $version
  $executable = Join-Path $runtime 't3.exe'
  $marker = Join-Path $runtime '.install-complete'
  if ((Test-Path -LiteralPath $executable) -and (Read-Text $marker) -eq $version) {
    return $executable
  }
  New-Item -ItemType Directory -Force -Path $versions | Out-Null
  $lock = Open-Lock (Join-Path $versions ('.' + $version + '.install.lock')) $Config.installLockSeconds
  $staging = $null
  try {
    if ((Test-Path -LiteralPath $executable) -and (Read-Text $marker) -eq $version) {
      return $executable
    }
    $rawArch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    $arch = switch ($rawArch) {
      'AMD64' { 'x64' }
      'ARM64' { 'arm64' }
      default { throw "Remote Windows architecture $rawArch has no t3 release archive." }
    }
    $stem = "t3-$version-win32-$arch"
    $archive = "$stem.zip"
    $staging = Join-Path $versions ('.staging-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $staging | Out-Null
    $baseUrl = $Config.releaseBaseUrl + '/v' + $version
    $checksums = Join-Path $staging 'SHA256SUMS'
    $zip = Join-Path $staging $archive
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/SHA256SUMS" -OutFile $checksums -TimeoutSec $Config.checksumsSeconds
    Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/$archive" -OutFile $zip -TimeoutSec $Config.downloadSeconds
    $line = Get-Content -LiteralPath $checksums | Where-Object { $_ -match ('\s\*?' + [regex]::Escape($archive) + '$') } | Select-Object -First 1
    if (-not $line) { throw "$archive is not listed in SHA256SUMS." }
    $expected = ($line -split '\s+')[0]
    if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash -ne $expected) {
      throw "Checksum mismatch for $archive."
    }
    Expand-Archive -LiteralPath $zip -DestinationPath $staging
    $unpacked = Join-Path $staging $stem
    Invoke-Native (Join-Path $unpacked 't3.exe') @('--version') | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "The t3 $version executable does not run on this host." }
    [IO.File]::WriteAllText((Join-Path $unpacked '.install-complete'), $version, $Utf8)
    if (Test-Path -LiteralPath $runtime) { Remove-Item -LiteralPath $runtime -Recurse -Force }
    Move-Item -LiteralPath $unpacked -Destination $runtime
    return $executable
  } finally {
    if ($staging -and (Test-Path -LiteralPath $staging)) {
      Remove-Item -LiteralPath $staging -Recurse -Force
    }
    $lock.Dispose()
  }
}
`;

const RESOLVE_RUNNER = String.raw`
function Resolve-Runner {
  if (-not $Config.nodeScriptPath) {
    return @{ executable = Install-Runtime; arguments = @(); key = $Config.runnerKey }
  }
  $node = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $node) { throw 'Remote node.exe was not found on the SSH session PATH.' }
  if (-not (Test-Path -LiteralPath $Config.nodeScriptPath -PathType Leaf)) {
    throw "Remote Node script does not exist: $($Config.nodeScriptPath)"
  }
  $scriptPath = (Get-Item -LiteralPath $Config.nodeScriptPath).FullName
  $version = Invoke-Native $node.Path @('--version')
  if ($LASTEXITCODE -ne 0) { throw "Remote node.exe could not run: $($node.Path)" }
  if ($Config.nodeEngineRange) {
    # Base64 carries the shared JavaScript checker through PS 5.1's native
    # argument quoting without altering its embedded double quotes.
    Invoke-Native $node.Path @('-e', "eval(Buffer.from(process.argv[1],'base64').toString('utf8'))", $Config.nodeEngineCheck, $Config.nodeEngineRange) | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Remote Node $version does not satisfy required range $($Config.nodeEngineRange)." }
  }
  $prefix = @($scriptPath)
  $key = [ordered] @{ executable = $node.Path; arguments = $prefix; nodeEngineRange = $Config.nodeEngineRange } | ConvertTo-Json -Compress
  return @{ executable = $node.Path; arguments = $prefix; key = $key }
}
`;

const LAUNCH = String.raw`
function Open-LaunchLock {
  $deadline = [DateTime]::UtcNow.AddSeconds($Config.lockWaitSeconds)
  while ($true) {
    $lock = Open-Lock (Join-Path $T3Home 'ssh-launch/windows.lock') $Config.lockWaitSeconds
    $pending = Read-Owner $PendingFile
    if (-not (Get-OwnedProcess $pending)) { return $lock }
    # Let the registered launcher acquire this lock before another bootstrap
    # picks a port. The registration is shared across aliases of this home.
    $lock.Dispose()
    if ([DateTime]::UtcNow -ge $deadline) { throw 'Timed out waiting for the pending Windows SSH launch.' }
    Start-Sleep -Milliseconds 100
  }
}

function Test-Ready([int] $Port, [int] $Timeout) {
  Invoke-Runner $Runner @('__ssh-helper', 'wait-ready', $Port, $Timeout, $Config.readyProbeTimeoutMs) | Out-Null
  return $LASTEXITCODE -eq 0
}

function Start-Server([int] $Port) {
  # WMI creates a launcher outside the SSH session's process tree. Do not use
  # Start-Process directly in that session: its child can die when SSH exits.
  # The launcher records the actual t3 PID; Windows lets the server retain its
  # redirected file handles after the launcher exits.
  $launchConfig = @{
    runner = $Runner; home = $T3Home; state = $StateDir
    port = $Port; token = [Guid]::NewGuid().ToString('N')
    lockWaitSeconds = $Config.lockWaitSeconds; readyTimeoutMs = $Config.readyTimeoutMs
    readyProbeTimeoutMs = $Config.readyProbeTimeoutMs
  } | ConvertTo-Json -Compress
  $encodedConfig = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($launchConfig))
  $launcher = @'
$ErrorActionPreference = 'Stop'
${INVOKE_NATIVE}
${PROCESS_OWNERSHIP}
$config = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('@@LAUNCH_CONFIG@@')) | ConvertFrom-Json
$utf8 = New-Object System.Text.UTF8Encoding $false
$env:T3CODE_NO_BROWSER = '1'
$ownerFile = Join-Path $config.state 'owner.json'
$StopFile = Join-Path $config.state 'stop-pending.json'
$errorFile = Join-Path $config.state 'launch-error'
$server = $null
$ready = $false
$registered = $false
$pendingFile = Join-Path $config.home 'ssh-launch/windows-pending.json'
try {
  # The bootstrap registers this launcher while holding the same lock. If it
  # dies before registration, or stop wins the lock, this launch is cancelled.
  $lockPath = Join-Path $config.home 'ssh-launch/windows.lock'
  $deadline = [DateTime]::UtcNow.AddSeconds($config.lockWaitSeconds)
  $launchLock = $null
  while (-not $launchLock) {
    try { $launchLock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
    catch [IO.IOException] {
      if ([DateTime]::UtcNow -ge $deadline) { throw 'Timed out waiting to start the remote T3 server.' }
      Start-Sleep -Milliseconds 100
    }
  }
  try {
    $permitFile = Join-Path $config.state 'launcher.json'
    if (-not (Test-Path -LiteralPath $permitFile)) { return }
    $permit = [IO.File]::ReadAllText($permitFile) | ConvertFrom-Json
    if ($permit.token -ne $config.token -or $permit.pid -ne $PID) { return }
    if (-not (Test-Path -LiteralPath $pendingFile)) { return }
    $pending = [IO.File]::ReadAllText($pendingFile) | ConvertFrom-Json
    if ($pending.token -ne $config.token) { return }
    $registered = $true
    # The prefix contains only a resolved file path, whose Windows name cannot contain double quotes.
    $prefix = (@($config.runner.arguments) | ForEach-Object { '"' + $_ + '"' }) -join ' '
    $arguments = $prefix + ' serve --host 127.0.0.1 --port ' + $config.port + ' --base-dir "' + $config.home + '"'
    $server = Start-Process -FilePath $config.runner.executable -ArgumentList $arguments -WorkingDirectory $config.home -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $config.state 'server.log') -RedirectStandardError (Join-Path $config.state 'server.err.log')
    $serverOwner = @{
      pid = $server.Id; startedAt = $server.StartTime.ToUniversalTime().Ticks.ToString()
      port = $config.port; runner = $config.runner.key; token = $config.token
    }
    $owner = $serverOwner | ConvertTo-Json -Compress
    [IO.File]::WriteAllText(($ownerFile + '.next'), $owner, $utf8)
    Move-Item -LiteralPath ($ownerFile + '.next') -Destination $ownerFile -Force
    $runtimeDeadline = [DateTime]::UtcNow.AddMilliseconds($config.readyTimeoutMs)
    Invoke-Runner $config.runner @('__ssh-helper', 'wait-ready', $config.port, $config.readyTimeoutMs, $config.readyProbeTimeoutMs) | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Remote T3 server did not become ready.' }
    # HTTP can answer before the discovery record is published. Keep aliases
    # serialized until they can discover this exact server through its home.
    $runtimeFile = Join-Path $config.home 'userdata/server-runtime.json'
    while ($true) {
      $runtime = Invoke-Runner $config.runner @('__ssh-helper', 'runtime-port', $runtimeFile)
      if ($LASTEXITCODE -eq 0 -and $runtime -eq ("$($server.Id) $($config.port)")) { break }
      if ($server.HasExited) { throw 'Remote T3 server exited before publishing its runtime record.' }
      if ([DateTime]::UtcNow -ge $runtimeDeadline) { throw 'Remote T3 server did not publish its runtime record.' }
      Start-Sleep -Milliseconds 100
    }
    $ready = $true
  } finally {
    try {
      if ($registered -and (Test-Path -LiteralPath $pendingFile)) {
        $pending = [IO.File]::ReadAllText($pendingFile) | ConvertFrom-Json
        if ($pending.token -eq $config.token) { Remove-Item -LiteralPath $pendingFile -Force }
      }
      # Stop owns only the server after readiness; the launcher now exits.
      if ($ready) { Remove-Item -LiteralPath $permitFile -Force }
    } catch {
      $ready = $false
      throw
    } finally {
      try {
        if ($server -and -not $ready) { Stop-ProcessTrees @($serverOwner) }
      } finally { $launchLock.Dispose() }
    }
  }
} catch {
  if ($registered) { [IO.File]::WriteAllText($errorFile, $_.Exception.Message, $utf8) }
  exit 1
}
'@
  $launcher = $launcher.Replace('@@LAUNCH_CONFIG@@', $encodedConfig)
  $launcherPath = Join-Path $StateDir 'run-server.ps1'
  [IO.File]::WriteAllText($launcherPath, $launcher, $Utf8)
  $launchError = Join-Path $StateDir 'launch-error'
  Remove-Item -LiteralPath $launchError -Force -ErrorAction SilentlyContinue
  $command = "& ([ScriptBlock]::Create([IO.File]::ReadAllText('" + $launcherPath.Replace("'", "''") + "', [Text.Encoding]::UTF8)))"
  $encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
  $powershell = Join-Path $PSHOME 'powershell.exe'
  $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{
    # CREATE_BREAKAWAY_FROM_JOB | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT
    CreateFlags = [uint32] 150995968
    EnvironmentVariables = [string[]] @(Get-ChildItem Env: | ForEach-Object { $_.Name + '=' + $_.Value })
  }
  $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = '"' + $powershell + '" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ' + $encodedCommand
    CurrentDirectory = $T3Home
    ProcessStartupInformation = $startup
  }
  if ($created.ReturnValue -ne 0) { throw "Could not launch the remote T3 server (WMI error $($created.ReturnValue))." }
  $launcherProcess = Get-Process -Id $created.ProcessId -ErrorAction Stop
  $registration = @{
    pid = $launcherProcess.Id
    startedAt = $launcherProcess.StartTime.ToUniversalTime().Ticks.ToString()
    token = ($launchConfig | ConvertFrom-Json).token
  }
  try {
    [IO.File]::WriteAllText(($LauncherFile + '.next'), ($registration | ConvertTo-Json -Compress), $Utf8)
    Move-Item -LiteralPath ($LauncherFile + '.next') -Destination $LauncherFile -Force
    [IO.File]::WriteAllText(($PendingFile + '.next'), ($registration | ConvertTo-Json -Compress), $Utf8)
    Move-Item -LiteralPath ($PendingFile + '.next') -Destination $PendingFile -Force
  } catch {
    Invoke-Native (Join-Path $env:SystemRoot 'System32/taskkill.exe') @('/PID', $launcherProcess.Id, '/T', '/F') | Out-Null
    throw
  }
  return $registration
}

function Wait-Server($Launch) {
  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  while ($true) {
    $owner = Read-Owner
    if ($owner -and $owner.token -eq $Launch.token) { return }
    $errorText = Read-Text (Join-Path $StateDir 'launch-error')
    if ($errorText) { throw $errorText }
    if (-not (Get-OwnedProcess $Launch)) { throw 'Remote T3 launcher exited before recording its server PID.' }
    if ([DateTime]::UtcNow -ge $deadline) { throw 'Remote T3 launcher did not record its server PID within 20 seconds.' }
    Start-Sleep -Milliseconds 100
  }
}

New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
$Runner = Resolve-Runner
# Serialize across aliases/clients sharing the default server home, including
# disconnects, so a second launch observes the first server's runtime record.
$launchLock = Open-LaunchLock
try {
  $owner = Read-Owner
  $ownedProcess = Get-OwnedProcess $owner
  $runtimeFile = Join-Path $T3Home 'userdata/server-runtime.json'
  $runtime = Invoke-Runner $Runner @('__ssh-helper', 'runtime-port', $runtimeFile)
  if ($LASTEXITCODE -eq 0 -and $runtime -match '^(\d+) (\d+)$') {
    $runtimePid = [int] $Matches[1]
    $runtimePort = [int] $Matches[2]
    if ((-not $ownedProcess -or $ownedProcess.Id -ne $runtimePid) -and (Test-Ready $runtimePort $Config.reuseReadyTimeoutMs)) {
      Stop-OwnedServer
      @{ remotePort = $runtimePort; serverKind = 'external' } | ConvertTo-Json -Compress
      return
    }
  }
  if ($ownedProcess -and -not (Test-Path -LiteralPath $StopFile) -and -not (Test-Path -LiteralPath $LauncherFile) -and $owner.runner -eq $Runner.key -and (Test-Ready $owner.port $Config.reuseReadyTimeoutMs)) {
    @{ remotePort = [int] $owner.port; serverKind = 'managed' } | ConvertTo-Json -Compress
    return
  }
  Stop-OwnedServer
  $portText = Invoke-Runner $Runner @('__ssh-helper', 'pick-port', $PortFile, $Config.defaultPort, $Config.portScanWindow)
  if ($LASTEXITCODE -ne 0) { throw 'Failed to find an available port on the remote host.' }
  $remotePort = [int] $portText
  [IO.File]::WriteAllText($PortFile, $portText, $Utf8)
  $launch = Start-Server $remotePort
} finally {
  $launchLock.Dispose()
}
try {
  Wait-Server $launch
  if (-not (Test-Ready $remotePort $Config.readyTimeoutMs)) {
    throw "Remote T3 server did not become ready on 127.0.0.1:$remotePort."
  }
  $readyLock = Open-Lock (Join-Path $T3Home 'ssh-launch/windows.lock') $Config.lockWaitSeconds
  try {
    $current = Read-Owner
    if (-not $current -or $current.token -ne $launch.token -or -not (Get-OwnedProcess $current)) {
      throw 'Remote T3 launch was stopped or replaced before it became ready.'
    }
    if ((Test-Path -LiteralPath $LauncherFile) -or (Test-Path -LiteralPath $StopFile)) {
      throw 'Remote T3 launcher did not complete readiness and cleanup.'
    }
    @{ remotePort = $remotePort; serverKind = 'managed' } | ConvertTo-Json -Compress
  } finally { $readyLock.Dispose() }
} catch {
  $failure = $_
  $lock = Open-Lock (Join-Path $T3Home 'ssh-launch/windows.lock') $Config.lockWaitSeconds
  try {
    $current = Read-Owner
    if (-not $current) { $current = Read-Owner $LauncherFile }
    # Another client may have stopped/replaced this launch while we waited.
    if ($current -and $current.token -eq $launch.token) {
      try { Read-ServerLogs | ForEach-Object { [Console]::Error.WriteLine($_) } }
      finally { Stop-OwnedServer }
    }
  } finally { $lock.Dispose() }
  throw $failure
}
`;

const STOP = String.raw`
if (Test-Path -LiteralPath $StateDir) {
  $lock = Open-Lock (Join-Path $T3Home 'ssh-launch/windows.lock') $Config.lockWaitSeconds
  try { Stop-OwnedServer } finally { $lock.Dispose() }
}
Write-Output '{"stopped":true}'
`;

/** Builds a Windows operation with all configuration carried as data over stdin. */
export function buildWindowsRemoteScript(
  stateKey: string,
  operation: WindowsRemoteOperation,
  runnerOptions?: RemoteT3RunnerOptions,
) {
  const runner =
    operation === "launch" || operation === "pair" ? resolveRemoteRunner(runnerOptions) : undefined;
  const config = NodeBuffer.Buffer.from(
    JSON.stringify({
      stateKey,
      ...runner,
      ...(runner?.nodeScriptPath
        ? {
            nodeEngineRange: runnerOptions?.nodeEngineRange?.trim() || "",
            nodeEngineCheck: NodeBuffer.Buffer.from(
              buildRemoteNodeEngineCheckScript(),
              "utf8",
            ).toString("base64"),
          }
        : {}),
      runnerKey: runner && JSON.stringify(runner),
      defaultPort: DEFAULT_REMOTE_PORT,
      portScanWindow: REMOTE_PORT_SCAN_WINDOW,
      readyTimeoutMs: REMOTE_READY_TIMEOUT_MS,
      reuseReadyTimeoutMs: REMOTE_REUSE_READY_TIMEOUT_MS,
      readyProbeTimeoutMs: SSH_READY_PROBE_TIMEOUT_MS,
      checksumsSeconds: REMOTE_ARCHIVE_CHECKSUMS_SECONDS,
      downloadSeconds: REMOTE_ARCHIVE_DOWNLOAD_SECONDS,
      installLockSeconds: REMOTE_ARCHIVE_LOCK_WAIT_SECONDS,
      lockWaitSeconds: WINDOWS_LOCK_WAIT_SECONDS,
    }),
    "utf8",
  ).toString("base64");
  const header = `$Config = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${config}')) | ConvertFrom-Json\n`;
  switch (operation) {
    case "launch":
      return header + COMMON + INSTALL + RESOLVE_RUNNER + LAUNCH;
    case "pair":
      return (
        header +
        COMMON +
        INSTALL +
        RESOLVE_RUNNER +
        `
$Runner = Resolve-Runner
Invoke-Runner $Runner @('auth', 'pairing', 'create', '--base-dir', $T3Home, '--json')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
`
      );
    case "stop":
      return header + COMMON + STOP;
    case "logs":
      return header + COMMON + "\nRead-ServerLogs\n";
  }
}
