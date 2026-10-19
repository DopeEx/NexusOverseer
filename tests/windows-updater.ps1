$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repo = Split-Path -Parent $PSScriptRoot
. (Join-Path $repo 'tools\windows-updater\updater.ps1') -Library
$sandbox = Join-Path ([IO.Path]::GetTempPath()) ("Nexus test ' space & !" + [char]0xFC + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($sandbox) | Out-Null

function Assert($Condition, [string]$Message) {
    if (!$Condition) { throw "ASSERT: $Message" }
}

function Assert-Throws([scriptblock]$Action, [string]$Pattern) {
    try { & $Action } catch {
        Assert ($_.Exception.Message -match $Pattern) "Wrong error: $($_.Exception.Message)"
        return
    }
    throw "Expected failure: $Pattern"
}

function New-Fixture([string]$Name) {
    $folder = Join-Path $sandbox $Name
    [IO.Directory]::CreateDirectory((Join-Path $folder 'addon')) | Out-Null
    [IO.Directory]::CreateDirectory((Join-Path $folder '.update')) | Out-Null
    foreach ($file in (Read-Json (Join-Path $repo 'tools\windows-updater\addon-files.json'))) {
        $to = Get-SafePath (Join-Path $folder 'addon') $file
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($to)) | Out-Null
        Copy-Item -LiteralPath (Join-Path (Join-Path $repo 'nexus-addon') $file) -Destination $to
    }
    foreach ($file in @('updater.ps1', 'Update-Nexus.bat', 'Installation.txt')) {
        Copy-Item -LiteralPath (Join-Path (Join-Path $repo 'tools\windows-updater') $file) -Destination $folder
    }
    $manifest = Read-Json (Join-Path $folder 'addon\manifest.json')
    $manifest.version = '2.1.0'
    Write-Json (Join-Path $folder 'addon\manifest.json') $manifest
    $updaterCode = Get-Content -LiteralPath (Join-Path $folder 'updater.ps1') -Raw
    $updaterCode = $updaterCode -replace "(?m)^\`$script:UpdaterVersion = '\d+\.\d+\.\d+'", "`$script:UpdaterVersion = '1.0.0'"
    Set-Content -LiteralPath (Join-Path $folder 'updater.ps1') -Value $updaterCode -Encoding UTF8
    Set-PackageMetadata $folder
    return $folder
}

function Set-PackageMetadata([string]$Folder, [string]$UpdaterVersion = '1.0.0') {
    $hashes = @{}
    foreach ($file in Get-ChildItem -LiteralPath $Folder -Recurse -File) {
        $relative = $file.FullName.Substring($Folder.Length + 1).Replace('\', '/')
        if ($relative -eq 'manual-package.json' -or $relative.StartsWith('.update/')) { continue }
        $hashes[$relative] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    Write-Json (Join-Path $Folder 'manual-package.json') @{
        format = 1; launcherProtocol = 1; updaterVersion = $UpdaterVersion
        addonVersion = '2.1.0'; files = $hashes
    }
}

function New-Pending([string]$Root, [bool]$HadTarget = $true) {
    $relative = '.update\backups\' + [guid]::NewGuid().ToString('N') + '\addon'
    $backup = Join-Path $Root $relative
    [IO.Directory]::CreateDirectory((Split-Path -Parent $backup)) | Out-Null
    Write-Json (Join-Path $Root '.update\addon.pending.json') @{ backup = $relative; hadTarget = $HadTarget }
    return $backup
}

try {
    # Keep network fixtures independent of the real version shipped by the repo.
    $script:UpdaterVersion = '1.0.0'
    $fixture = New-Fixture 'package'
    Assert ((Test-ManualPackage $fixture).addonVersion -eq '2.1.0') 'Valid manual package'
    Add-Content -LiteralPath (Join-Path $fixture 'addon\background.js') -Value 'tampered'
    Assert-Throws { Test-ManualPackage $fixture } 'Paketpruefung'
    Copy-Item -LiteralPath (Join-Path $repo 'nexus-addon\background.js') -Destination (Join-Path $fixture 'addon\background.js') -Force
    Set-Content -LiteralPath (Join-Path $fixture 'addon\unlisted.js') -Value 'not hashed'
    Assert-Throws { Test-ManualPackage $fixture } 'Nicht gepruefte'
    Remove-Item -LiteralPath (Join-Path $fixture 'addon\unlisted.js')
    $metadata = Read-Json (Join-Path $fixture 'manual-package.json')
    $metadata.launcherProtocol = 2
    Write-Json (Join-Path $fixture 'manual-package.json') $metadata
    Assert-Throws { Test-ManualPackage $fixture } 'Starter'
    Set-PackageMetadata $fixture '9.0.0'
    Assert-Throws { Test-ManualPackage $fixture } 'Updater-Version und Paketversion'
    Set-PackageMetadata $fixture
    Write-Host 'PASS package integrity, unlisted files, protocol and version checks'

    foreach ($invalid in @('..\escape', 'C:\outside', '\absolute', 'a\..\escape', 'a:stream', 'foo.\bar', 'CON.txt', '*.js')) {
        Assert-Throws { Get-SafePath $sandbox $invalid } 'Paketpfad|ausserhalb'
    }
    Assert-Throws { Get-Response 'http://github.com/unsafe' } 'Downloadadresse'
    Assert-Throws { Get-Response 'https://example.com/unsafe' } 'Downloadadresse'
    $evil = Join-Path $sandbox 'evil.zip'
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::Open($evil, 'Create')
    try { $archive.CreateEntry('../escape.txt') | Out-Null } finally { $archive.Dispose() }
    Assert-Throws { Expand-SafeArchive $evil (Join-Path $sandbox 'evil-out') } 'Paketpfad'
    Assert (!(Test-Path -LiteralPath (Join-Path $sandbox 'escape.txt'))) 'Zip traversal blocked before extraction'
    Write-Host 'PASS paths, HTTPS host restrictions and ZIP traversal'

    $installed = New-Fixture 'installed'
    $stage = New-Fixture 'stage'
    $oldHash = (Get-FileHash -LiteralPath (Join-Path $installed 'addon\background.js')).Hash
    Set-Content -LiteralPath (Join-Path $stage 'addon\new.txt') -Value 'new'
    Install-Addon $installed (Join-Path $stage 'addon') @{ channel = 'master'; revision = ('a' * 40); installedAt = 'test' }
    Assert (Test-Path -LiteralPath (Join-Path $installed 'addon\new.txt')) 'New addon installed'
    $backups = @(Get-ChildItem -LiteralPath (Join-Path $installed '.update\backups') -Filter background.js -Recurse -File)
    Assert ($backups.Count -eq 1) 'Exactly one backup'
    Assert ((Get-FileHash -LiteralPath $backups[0].FullName).Hash -eq $oldHash) 'Backup preserves previous content'
    Assert (!(Test-Path -LiteralPath (Join-Path $installed '.update\addon.pending.json'))) 'Journal committed'
    Assert ((Read-Json (Join-Path $installed 'addon\.nexus-install.json')).channel -eq 'master') 'Channel recorded'

    $recovery = New-Fixture 'recovery'
    $backup = New-Pending $recovery
    Restore-Addon $recovery
    Assert (Test-Path -LiteralPath (Join-Path $recovery 'addon\manifest.json')) 'Recovery before first move'
    $backup = New-Pending $recovery
    Move-Item -LiteralPath (Join-Path $recovery 'addon') -Destination $backup
    Restore-Addon $recovery
    Assert (Test-Path -LiteralPath (Join-Path $recovery 'addon\manifest.json')) 'Recovery between moves'
    $backup = New-Pending $recovery
    Move-Item -LiteralPath (Join-Path $recovery 'addon') -Destination $backup
    [IO.Directory]::CreateDirectory((Join-Path $recovery 'addon')) | Out-Null
    Set-Content -LiteralPath (Join-Path $recovery 'addon\partial.txt') -Value 'partial'
    Restore-Addon $recovery
    Assert (!(Test-Path -LiteralPath (Join-Path $recovery 'addon\partial.txt'))) 'Partial folder removed'
    Assert (Test-Path -LiteralPath (Join-Path $recovery 'addon\manifest.json')) 'Old folder restored'

    $locked = New-Fixture 'locked'
    $stage = New-Fixture 'locked-stage'
    $handle = [IO.File]::Open((Join-Path $locked 'addon\manifest.json'), 'Open', 'Read', 'None')
    try {
        Assert-Throws { Install-Addon $locked (Join-Path $stage 'addon') @{} } '.'
    } finally { $handle.Dispose() }
    Assert (Test-Path -LiteralPath (Join-Path $locked 'addon\manifest.json')) 'Locked target retained'
    $failedStage = New-Fixture 'failed-stage'
    $handle = [IO.File]::Open((Join-Path $failedStage 'addon\manifest.json'), 'Open', 'Read', 'None')
    try {
        Assert-Throws { Install-Addon $locked (Join-Path $failedStage 'addon') @{} } '.'
    } finally { $handle.Dispose() }
    Assert (Test-Path -LiteralPath (Join-Path $locked 'addon\manifest.json')) 'Old folder restored after failed second rename'
    Assert (!(Test-Path -LiteralPath (Join-Path $locked '.update\addon.pending.json'))) 'Failed second rename recovered completely'
    Write-Host 'PASS addon install, backup, interruption phases and locked target'

    $self = New-Fixture 'self'
    $newUpdater = Join-Path $sandbox 'new-updater.ps1'
    Set-Content -LiteralPath $newUpdater -Value "'new updater fixture'"
    Install-Updater $self $newUpdater
    Assert ((Get-Content -LiteralPath (Join-Path $self 'updater.ps1') -Raw) -match 'new updater fixture') 'Updater replaced'
    Assert (Test-Path -LiteralPath (Join-Path $self '.update\updater.previous.ps1')) 'Previous updater retained'
    # Run the actual starter with a recovery fixture; it must recover before executing.
    Set-Content -LiteralPath (Join-Path $self '.update\updater.previous.ps1') -Value "Write-Host 'RECOVERY_EXECUTED'; exit 0"
    Set-Content -LiteralPath (Join-Path $self '.update\updater.pending') -Value 'protocol-1'
    Set-Content -LiteralPath (Join-Path $self 'updater.ps1') -Value "throw 'BROKEN_UPDATER_EXECUTED'"
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $env:ComSpec
    $start.Arguments = '/d /c ""' + (Join-Path $self 'Update-Nexus.bat') + '""'
    $start.UseShellExecute = $false
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = [Diagnostics.Process]::Start($start)
    $process.StandardInput.WriteLine(' ')
    $process.StandardInput.Close()
    $output = $process.StandardOutput.ReadToEnd()
    $errors = $process.StandardError.ReadToEnd()
    Assert ($process.WaitForExit(15000)) 'Starter completes'
    Assert ($process.ExitCode -eq 0) "Starter recovery exit: $output $errors"
    Assert ($output -match 'RECOVERY_EXECUTED') "Starter executed previous updater: $output"
    Assert ($output -match 'Press any key') 'Starter keeps result visible'
    Assert (!(Test-Path -LiteralPath (Join-Path $self '.update\updater.pending'))) 'Self journal recovered'
    $process.Dispose()
    Write-Host 'PASS self-update and actual double-click starter recovery with special path characters'

    # Exercise network selection offline using real ZIPs and an injected HTTP boundary.
    $releaseZip = Join-Path $sandbox 'stable.zip'
    [IO.Compression.ZipFile]::CreateFromDirectory($fixture, $releaseZip)
    $script:Requested = [Collections.Generic.List[string]]::new()
    $originalResponse = ${function:Get-Response}
    function Get-Response([string]$Url, [string]$OutFile = '') {
        $script:Requested.Add($Url)
        if ($Url -like '*/releases/latest') {
            return @{
                draft = $false; prerelease = $false; tag_name = 'v2.1.0'
                assets = @(@{
                    name = 'nexus-overseer-2.1.0-windows-manual.zip'
                    browser_download_url = 'https://github.com/fixture.zip'
                    digest = 'sha256:' + (Get-FileHash -LiteralPath $releaseZip -Algorithm SHA256).Hash
                })
            }
        }
        if ($Url -eq 'https://github.com/fixture.zip') { Copy-Item -LiteralPath $releaseZip -Destination $OutFile; return }
        if ($Url -like '*/commits/master') { return @{ sha = ('b' * 40) } }
        if ($Url -like '*/archive/*.zip') { Copy-Item -LiteralPath $masterZip -Destination $OutFile; return }
        throw "Unexpected HTTP request: $Url"
    }
    $stableWork = Join-Path $sandbox 'stable-work'
    [IO.Directory]::CreateDirectory($stableWork) | Out-Null
    Assert ((Get-StablePackage $stableWork).Tag -eq 'v2.1.0') 'Stable release selected and validated'
    $masterRepo = Join-Path $sandbox 'master-repo\repo-commit'
    [IO.Directory]::CreateDirectory((Join-Path $masterRepo 'tools\windows-updater')) | Out-Null
    Copy-Item -LiteralPath (Join-Path $fixture 'addon') -Destination (Join-Path $masterRepo 'nexus-addon') -Recurse
    Copy-Item -LiteralPath (Join-Path $repo 'tools\windows-updater\addon-files.json') -Destination (Join-Path $masterRepo 'tools\windows-updater')
    Set-Content -LiteralPath (Join-Path $masterRepo 'tools\windows-updater\updater.ps1') -Value "throw 'MASTER_UPDATER_MUST_NOT_EXECUTE'"
    $masterZip = Join-Path $sandbox 'master.zip'
    [IO.Compression.ZipFile]::CreateFromDirectory((Split-Path -Parent $masterRepo), $masterZip)
    $masterWork = Join-Path $sandbox 'master-work'
    [IO.Directory]::CreateDirectory($masterWork) | Out-Null
    $master = Get-MasterAddon $masterWork
    Assert ($master.Commit -eq ('b' * 40)) 'Exact commit retained'
    Assert ($script:Requested.Contains("https://github.com/DopeEx/NexusOverseer/archive/$('b' * 40).zip")) 'Commit-addressed download'
    Assert (!(Test-Path -LiteralPath (Join-Path $master.Folder 'updater.ps1'))) 'No updater from master'
    Write-Host 'PASS stable release verification and commit-pinned master without master updater'

    # Full menu flows, using the same offline network boundary.
    $originalRoot = $script:Root
    $script:Root = New-Fixture 'interactive'
    $script:Answers = [Collections.Generic.Queue[string]]::new()
    function Read-Host([string]$Prompt) {
        if (!$script:Answers.Count) { throw "Unexpected prompt: $Prompt" }
        return $script:Answers.Dequeue()
    }
    $script:Answers.Enqueue('')
    $script:Answers.Enqueue('j')
    Invoke-Updater
    Assert ((Read-Json (Join-Path $script:Root 'addon\.nexus-install.json')).channel -eq 'release') 'Default is release'
    $script:Answers.Enqueue('2')
    $script:Answers.Enqueue('j')
    $script:Answers.Enqueue('j')
    Invoke-Updater
    Assert ((Read-Json (Join-Path $script:Root 'addon\.nexus-install.json')).channel -eq 'master') 'Explicit master installed'
    $script:Answers.Enqueue('')
    $script:Answers.Enqueue('j')
    Invoke-Updater
    Assert ((Read-Json (Join-Path $script:Root 'addon\.nexus-install.json')).channel -eq 'release') 'Default returns from master to release'
    $updatedCode = (Get-Content -LiteralPath (Join-Path $fixture 'updater.ps1') -Raw).Replace(
        "`$script:UpdaterVersion = '1.0.0'", "`$script:UpdaterVersion = '1.1.0'"
    )
    Set-Content -LiteralPath (Join-Path $fixture 'updater.ps1') -Value $updatedCode -Encoding UTF8
    Set-PackageMetadata $fixture '1.1.0'
    Remove-Item -LiteralPath $releaseZip
    [IO.Compression.ZipFile]::CreateFromDirectory($fixture, $releaseZip)
    $oldUpdaterHash = (Get-FileHash -LiteralPath (Join-Path $script:Root 'updater.ps1')).Hash
    $script:Answers.Enqueue('1')
    $script:Answers.Enqueue('j')
    $script:Answers.Enqueue('n')
    Invoke-Updater
    Assert ((Get-FileHash -LiteralPath (Join-Path $script:Root 'updater.ps1')).Hash -eq $oldUpdaterHash) 'Self-update requires separate consent'
    $handle = [IO.File]::Open((Join-Path $script:Root 'updater.ps1'), 'Open', 'Read', 'None')
    try {
        $script:Answers.Enqueue('1')
        $script:Answers.Enqueue('j')
        $script:Answers.Enqueue('j')
        Invoke-Updater
    } finally { $handle.Dispose() }
    Assert ((Get-FileHash -LiteralPath (Join-Path $script:Root 'updater.ps1')).Hash -eq $oldUpdaterHash) 'Failed self-update retains existing updater'
    Assert ((Read-Json (Join-Path $script:Root 'addon\.nexus-install.json')).channel -eq 'release') 'Failed self-update does not undo completed addon update'
    Assert ((Get-Content -LiteralPath (Join-Path $script:Root '.update\updater.log') -Raw) -match 'WARNUNG: Updater-Pruefung oder Selbstupdate fehlgeschlagen') 'Failed self-update explicitly warned'
    $script:Answers.Enqueue('1')
    $script:Answers.Enqueue('j')
    $script:Answers.Enqueue('j')
    Invoke-Updater
    Assert ((Get-Content -LiteralPath (Join-Path $script:Root 'updater.ps1') -Raw) -match "UpdaterVersion = '1.1.0'") 'Confirmed stable self-update installed'
    Assert ((Get-FileHash -LiteralPath (Join-Path $script:Root '.update\updater.previous.ps1')).Hash -eq $oldUpdaterHash) 'Stable self-update preserves original'
    $requestCount = $script:Requested.Count
    $script:Answers.Enqueue('0')
    Invoke-Updater
    Assert ($script:Requested.Count -eq $requestCount) 'Cancellation makes no download'
    $script:Answers.Enqueue('1')
    $script:Answers.Enqueue('n')
    Invoke-Updater
    Assert ((Read-Json (Join-Path $script:Root 'addon\.nexus-install.json')).channel -eq 'release') 'Decline leaves addon untouched'
    $stableResponse = ${function:Get-Response}
    function Get-Response([string]$Url, [string]$OutFile = '') {
        if ($Url -like '*/releases/latest') { throw 'STABLE_CHECK_UNAVAILABLE' }
        return & $stableResponse $Url $OutFile
    }
    $script:Answers.Enqueue('2')
    $script:Answers.Enqueue('j')
    $script:Answers.Enqueue('j')
    Invoke-Updater
    Assert ((Read-Json (Join-Path $script:Root 'addon\.nexus-install.json')).channel -eq 'master') 'Master update survives unavailable stable updater check'
    $log = Get-Content -LiteralPath (Join-Path $script:Root '.update\updater.log') -Raw
    Assert ($log -match 'WARNUNG:.*STABLE_CHECK_UNAVAILABLE') 'Optional updater failure logged as warning'
    Assert ($log -match 'Das Add-on wurde erfolgreich aktualisiert') 'Successful addon update explicitly preserved'
    function Get-Response { throw 'OFFLINE_FIXTURE' }
    $script:Answers.Enqueue('')
    Assert-Throws { Invoke-Updater } 'OFFLINE_FIXTURE'
    Assert ((Get-Content -LiteralPath (Join-Path $script:Root '.update\updater.log') -Raw) -match 'OFFLINE_FIXTURE') 'Failure logged'
    Assert (!(Test-Path -LiteralPath (Join-Path $script:Root '.update\addon.pending.json'))) 'Download failure never begins replacement'
    Set-Item Function:Get-Response $originalResponse
    # A corrupt archive must fail before confirmation or any installed-file change.
    function Get-Response([string]$Url, [string]$OutFile = '') {
        if ($OutFile) { Set-Content -LiteralPath $OutFile -Value 'not a zip'; return }
        return @{
            draft = $false; prerelease = $false; tag_name = 'v2.1.0'
            assets = @(@{ name = 'nexus-overseer-2.1.0-windows-manual.zip'; browser_download_url = 'https://github.com/fixture.zip' })
        }
    }
    $installedHash = (Get-FileHash -LiteralPath (Join-Path $script:Root 'addon\background.js')).Hash
    $script:Answers.Enqueue('1')
    Assert-Throws { Invoke-Updater } '.'
    Assert ((Get-FileHash -LiteralPath (Join-Path $script:Root 'addon\background.js')).Hash -eq $installedHash) 'Corrupt ZIP leaves installation intact'
    Assert (!(Test-Path -LiteralPath (Join-Path $script:Root '.update\addon.pending.json'))) 'Corrupt ZIP starts no transaction'
    $lock = [IO.File]::Open((Join-Path $script:Root '.update\updater.lock'), 'Open', 'ReadWrite', 'None')
    try { Assert-Throws { Invoke-Updater } '.' } finally { $lock.Dispose() }
    Write-Host 'PASS menu defaults, channel switching, self-update consent, cancellation, offline errors and concurrency lock'
    $script:Root = $originalRoot
    Set-Item Function:Get-Response $originalResponse
    Write-Host 'All updater checks passed'
} finally {
    $script:Log = $null
    Remove-Item -LiteralPath $sandbox -Recurse -Force
}
