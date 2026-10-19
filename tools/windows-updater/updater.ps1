param([switch]$Library)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:UpdaterVersion = '1.0.0'
$script:LauncherProtocol = 1
$script:Api = 'https://api.github.com/repos/DopeEx/NexusOverseer'
$script:Root = $PSScriptRoot
$script:Log = $null

function Write-Status([string]$Message) {
    Write-Host $Message
    if ($script:Log) {
        Add-Content -LiteralPath $script:Log -Value "$(Get-Date -Format o) $Message" -Encoding UTF8
    }
}

function Read-Json([string]$Path) {
    $value = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
    return $value
}

function Write-Json([string]$Path, $Value) {
    $Value | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $Path -Encoding UTF8
}

function Get-SafePath([string]$Base, [string]$Relative) {
    if ([string]::IsNullOrWhiteSpace($Relative) -or
        $Relative -match '(^[\\/]|[<>:"|?*\x00-\x1f]|(^|[\\/])\.\.?([\\/]|$)|[ .]([\\/]|$))' -or
        $Relative -match '(^|[\\/])(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(\.|[\\/]|$)') {
        throw "Ungueltiger Paketpfad: $Relative"
    }
    $basePath = [IO.Path]::GetFullPath($Base).TrimEnd('\') + '\'
    $path = [IO.Path]::GetFullPath((Join-Path $Base $Relative))
    if (!$path.StartsWith($basePath, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Pfad ausserhalb des Pakets: $Relative"
    }
    return $path
}

function Get-Response([string]$Url, [string]$OutFile = '') {
    $uri = [uri]$Url
    if ($uri.Scheme -ne 'https' -or $uri.Host -notin @('api.github.com', 'github.com', 'codeload.github.com')) {
        throw "Nicht erlaubte Downloadadresse: $Url"
    }
    $arguments = @{
        Uri = $Url
        Headers = @{ 'User-Agent' = "NexusOverseer-Updater/$script:UpdaterVersion"; 'Accept' = 'application/vnd.github+json' }
        UseBasicParsing = $true
        TimeoutSec = 120
    }
    if ($OutFile) {
        Invoke-WebRequest @arguments -OutFile $OutFile | Out-Null
    } else {
        return (Invoke-WebRequest @arguments).Content | ConvertFrom-Json
    }
}

function Expand-SafeArchive([string]$Zip, [string]$Destination) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($Zip)
    try {
        if ($archive.Entries.Count -gt 10000) { throw 'ZIP enthaelt zu viele Dateien.' }
        [long]$total = 0
        $seen = @{}
        foreach ($entry in $archive.Entries) {
            $relative = $entry.FullName.TrimEnd('/', '\')
            if (!$relative) { throw 'Leerer ZIP-Pfad.' }
            $target = Get-SafePath $Destination $relative
            if ($seen.ContainsKey($target)) { throw "Doppelter ZIP-Pfad: $relative" }
            $seen[$target] = $true
            $total += $entry.Length
            if ($total -gt 250MB) { throw 'Entpacktes ZIP ist groesser als 250 MB.' }
        }
        foreach ($entry in $archive.Entries) {
            $target = Get-SafePath $Destination $entry.FullName.TrimEnd('/', '\')
            if ($entry.FullName.EndsWith('/') -or $entry.FullName.EndsWith('\')) {
                [IO.Directory]::CreateDirectory($target) | Out-Null
            } else {
                [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
                [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $false)
            }
        }
    } finally { $archive.Dispose() }
}

function Test-Addon([string]$Folder) {
    $manifest = Read-Json (Join-Path $Folder 'manifest.json')
    if ($manifest.name -ne 'Nexus Overseer' -or $manifest.manifest_version -ne 3 -or
        $manifest.version -notmatch '^\d+(\.\d+){1,3}$') {
        throw 'Kein gueltiges Nexus-Overseer-Paket.'
    }
    $required = @('dashboard.html', 'background.js', $manifest.background.service_worker)
    foreach ($content in $manifest.content_scripts) {
        foreach ($property in @('js', 'css')) {
            if ($content.PSObject.Properties.Name -contains $property) { $required += $content.$property }
        }
    }
    $required += @($manifest.icons.PSObject.Properties | ForEach-Object { $_.Value })
    foreach ($group in $manifest.web_accessible_resources) { $required += $group.resources }
    foreach ($file in $required) {
        if (!(Test-Path -LiteralPath (Get-SafePath $Folder $file) -PathType Leaf)) {
            throw "Unvollstaendiges Add-on: $file fehlt."
        }
    }
    return $manifest.version
}

function Test-ManualPackage([string]$Folder) {
    $metadata = Read-Json (Join-Path $Folder 'manual-package.json')
    if ($metadata.format -ne 1 -or $metadata.launcherProtocol -ne $script:LauncherProtocol) {
        throw 'Dieses Paket benoetigt einen neueren Starter. Bitte das manuelle ZIP neu entpacken.'
    }
    if ($metadata.updaterVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'Ungueltige Updater-Version.' }
    $listed = @{}
    foreach ($file in $metadata.files.PSObject.Properties) {
        $path = Get-SafePath $Folder $file.Name
        if ($file.Value -notmatch '^[a-fA-F0-9]{64}$' -or
            !(Test-Path -LiteralPath $path -PathType Leaf) -or
            (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $file.Value) {
            throw "Paketpruefung fehlgeschlagen: $($file.Name)"
        }
        $listed[$path] = $true
    }
    foreach ($required in @('updater.ps1', 'Update-Nexus.bat', 'Installation.txt', 'addon\manifest.json')) {
        if (!$listed.ContainsKey((Get-SafePath $Folder $required))) { throw "Pruefsumme fehlt: $required" }
    }
    foreach ($file in Get-ChildItem -LiteralPath (Join-Path $Folder 'addon') -Recurse -File) {
        if (!$listed.ContainsKey($file.FullName)) { throw "Nicht gepruefte Add-on-Datei: $($file.Name)" }
    }
    $tokens = $null
    $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $Folder 'updater.ps1'), [ref]$tokens, [ref]$errors) | Out-Null
    if ($errors.Count) { throw 'Heruntergeladenes Updater-Skript hat Syntaxfehler.' }
    $code = Get-Content -LiteralPath (Join-Path $Folder 'updater.ps1') -Raw
    if ($code -notmatch "(?m)^\`$script:UpdaterVersion = '(\d+\.\d+\.\d+)'") {
        throw 'Versionsangabe im Updater-Skript fehlt.'
    }
    if ($Matches[1] -ne $metadata.updaterVersion) { throw 'Updater-Version und Paketversion stimmen nicht ueberein.' }
    $version = Test-Addon (Join-Path $Folder 'addon')
    if ($version -ne $metadata.addonVersion) { throw 'Paketversion und Add-on-Version stimmen nicht ueberein.' }
    return $metadata
}

function Get-StablePackage([string]$Work) {
    Write-Status 'Suche neueste stabile Veroeffentlichung ...'
    $release = Get-Response "$script:Api/releases/latest"
    if ($release.draft -or $release.prerelease) { throw 'GitHub lieferte kein stabiles Release.' }
    $assets = @($release.assets | Where-Object { $_.name -match '^nexus-overseer-[0-9.]+-windows-manual\.zip$' })
    if ($assets.Count -ne 1) {
        throw "Release $($release.tag_name) hat kein eindeutiges Windows-Manual-Paket. Bitte den Autor informieren."
    }
    $zip = Join-Path $Work 'release.zip'
    Get-Response $assets[0].browser_download_url $zip
    # GitHub's asset digest is an extra transport-integrity check when available.
    if ($assets[0].PSObject.Properties.Name -contains 'digest' -and $assets[0].digest) {
        if ($assets[0].digest -notmatch '^sha256:([a-fA-F0-9]{64})$') { throw 'Unbekannte Release-Pruefsumme.' }
        if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash -ne $Matches[1]) {
            throw 'Die Release-ZIP stimmt nicht mit der GitHub-Pruefsumme ueberein.'
        }
    }
    $folder = Join-Path $Work 'release'
    Expand-SafeArchive $zip $folder
    $metadata = Test-ManualPackage $folder
    if ($release.tag_name -ne "v$($metadata.addonVersion)" -and $release.tag_name -ne $metadata.addonVersion) {
        throw 'Release-Tag und Paketversion stimmen nicht ueberein.'
    }
    return @{ Folder = $folder; Metadata = $metadata; Tag = $release.tag_name }
}

function Get-MasterAddon([string]$Work) {
    $commit = Get-Response "$script:Api/commits/master"
    if ($commit.sha -notmatch '^[a-fA-F0-9]{40}$') { throw 'GitHub lieferte keinen gueltigen Commit.' }
    $zip = Join-Path $Work 'master.zip'
    Get-Response "https://github.com/DopeEx/NexusOverseer/archive/$($commit.sha).zip" $zip
    $unpacked = Join-Path $Work 'master'
    Expand-SafeArchive $zip $unpacked
    $roots = @(Get-ChildItem -LiteralPath $unpacked -Directory)
    if ($roots.Count -ne 1) { throw 'Unerwartete Struktur des Quellarchivs.' }
    $source = Join-Path $roots[0].FullName 'nexus-addon'
    $files = @(Read-Json (Join-Path $roots[0].FullName 'tools\windows-updater\addon-files.json'))
    if (!$files.Count) { throw 'Leere Distributionsliste im Entwicklungsstand.' }
    $stage = Join-Path $Work 'master-addon'
    foreach ($file in $files) {
        if ($file -isnot [string]) { throw 'Ungueltige Distributionsliste.' }
        $from = Get-SafePath $source $file
        $to = Get-SafePath $stage $file
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($to)) | Out-Null
        Copy-Item -LiteralPath $from -Destination $to
    }
    $version = Test-Addon $stage
    return @{ Folder = $stage; Version = $version; Commit = $commit.sha }
}

function Restore-Addon([string]$Root) {
    $pending = Join-Path $Root '.update\addon.pending.json'
    if (!(Test-Path -LiteralPath $pending)) { return }
    $transaction = Read-Json $pending
    if ($transaction.backup -notmatch '^\.update\\backups\\[a-f0-9]{32}\\addon$' -or
        $transaction.hadTarget -isnot [bool]) { throw 'Ungueltiges Wiederherstellungsprotokoll.' }
    $backup = Get-SafePath $Root $transaction.backup
    $target = Join-Path $Root 'addon'
    if (Test-Path -LiteralPath $backup -PathType Container) {
        if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
        [IO.Directory]::Move($backup, $target)
    } elseif (!$transaction.hadTarget) {
        if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
    } elseif (!(Test-Path -LiteralPath $target -PathType Container)) {
        throw 'Weder bisheriger Add-on-Ordner noch Backup gefunden. Manuelle Wiederherstellung erforderlich.'
    }
    Remove-Item -LiteralPath $pending
    Write-Status 'Unterbrochenes Add-on-Update zurueckgesetzt.'
}

function Install-Addon([string]$Root, [string]$Stage, $State) {
    $version = Test-Addon $Stage
    $id = [guid]::NewGuid().ToString('N')
    $relative = ".update\backups\$id\addon"
    $backup = Get-SafePath $Root $relative
    $target = Join-Path $Root 'addon'
    $pending = Join-Path $Root '.update\addon.pending.json'
    Write-Json (Join-Path $Stage '.nexus-install.json') $State
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($backup)) | Out-Null
    if (Test-Path -LiteralPath $pending) { throw 'Zuerst das unterbrochene Update wiederherstellen.' }
    # Publish the journal before either rename; recovery always restores the old folder.
    $journal = "$pending.new"
    Write-Json $journal @{ backup = $relative; hadTarget = (Test-Path -LiteralPath $target) }
    Move-Item -LiteralPath $journal -Destination $pending
    try {
        if (Test-Path -LiteralPath $target) { [IO.Directory]::Move($target, $backup) }
        [IO.Directory]::Move($Stage, $target)
        Remove-Item -LiteralPath $pending
    } catch {
        $failure = $_
        Restore-Addon $Root
        throw $failure
    }
    Write-Status "Add-on $version installiert. Datei-Backup: $backup"
}

function Install-Updater([string]$Root, [string]$Source) {
    $target = Join-Path $Root 'updater.ps1'
    $previous = Join-Path $Root '.update\updater.previous.ps1'
    $next = Join-Path $Root '.update\updater.next.ps1'
    $pending = Join-Path $Root '.update\updater.pending'
    Copy-Item -LiteralPath $Source -Destination $next -Force
    Copy-Item -LiteralPath $target -Destination $previous -Force
    Set-Content -LiteralPath $pending -Value 'protocol-1' -Encoding ASCII
    try {
        [IO.File]::Replace($next, $target, $previous)
        Remove-Item -LiteralPath $pending
    } catch {
        $failure = $_
        Copy-Item -LiteralPath $previous -Destination $target -Force
        Remove-Item -LiteralPath $pending
        throw $failure
    }
    Write-Status 'Updater aktualisiert. Die neue Fassung wird beim naechsten Start verwendet.'
}

function Confirm-Action([string]$Message) {
    return (Read-Host "$Message [j/N]") -match '^(j|ja|y|yes)$'
}

function Invoke-Updater {
    $update = Join-Path $script:Root '.update'
    [IO.Directory]::CreateDirectory($update) | Out-Null
    # Exclusive handle prevents overlapping updates, including from a second double-click.
    $lock = [IO.File]::Open((Join-Path $update 'updater.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
    $work = $null
    try {
        $script:Log = Join-Path $update 'updater.log'
        Write-Status "`nNexus Overseer Updater $script:UpdaterVersion"
        Restore-Addon $script:Root
        $installed = Test-Addon (Join-Path $script:Root 'addon')
        Write-Status "Installiertes Add-on: $installed"
        $statePath = Join-Path $script:Root 'addon\.nexus-install.json'
        if (Test-Path -LiteralPath $statePath) {
            $state = Read-Json $statePath
            Write-Status "Letzte Quelle: $($state.channel), Stand: $($state.revision), Datum: $($state.installedAt)"
        }
        Write-Host "`n[1] Neueste stabile Veroeffentlichung (Standard)"
        Write-Host '[2] Entwicklungsstand master (ungeprueft)'
        Write-Host '[0] Abbrechen'
        $choice = Read-Host 'Auswahl [1]'
        if ($choice -eq '0') { Write-Status 'Abgebrochen. Keine Aenderung.'; return }
        if ($choice -notin @('', '1', '2')) { throw 'Ungueltige Auswahl. Bitte erneut starten.' }
        if ($choice -eq '2') {
            if (!(Confirm-Action 'master kann Fehler und inkompatible Datenaenderungen enthalten. Fortfahren?')) {
                Write-Status 'Abgebrochen. Keine Aenderung.'; return
            }
        }
        $work = Join-Path $update ("work-" + [guid]::NewGuid().ToString('N'))
        [IO.Directory]::CreateDirectory($work) | Out-Null
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        $ProgressPreference = 'SilentlyContinue'
        # A failed stable lookup never silently changes the selected channel.
        $stable = $null
        if ($choice -eq '2') {
            $master = Get-MasterAddon $work
            $stage = $master.Folder
            $revision = $master.Commit
            $channel = 'master'
            $version = $master.Version
        } else {
            $stable = Get-StablePackage $work
            $stage = Join-Path $stable.Folder 'addon'
            $revision = $stable.Tag
            $channel = 'release'
            $version = $stable.Metadata.addonVersion
        }
        Write-Status "Ziel: $channel / $version / $revision"
        Write-Host 'Vor Kanalwechseln oder Downgrades: Daten im Dashboard unter Options > Data exportieren.'
        Write-Host 'Datei-Backups sichern NICHT die Daten im Browserspeicher.'
        if (!(Confirm-Action 'Add-on-Dateien jetzt austauschen?')) {
            Write-Status 'Abgebrochen. Keine Aenderung.'; return
        }
        Install-Addon $script:Root $stage @{
            channel = $channel; revision = $revision; version = $version; installedAt = (Get-Date -Format o)
        }
        Write-Status 'Jetzt unter chrome://extensions (bzw. edge://extensions) auf Neu laden klicken und Spielseiten neu laden.'
        # Updater code is taken ONLY from a validated stable package, never from master.
        if (!$stable) { $stable = Get-StablePackage $work }
        if ([version]$stable.Metadata.updaterVersion -gt [version]$script:UpdaterVersion) {
            Write-Status "Stabiler Updater verfuegbar: $($stable.Metadata.updaterVersion)"
            if (Confirm-Action 'Auch den Updater aktualisieren?') {
                Install-Updater $script:Root (Join-Path $stable.Folder 'updater.ps1')
            } else { Write-Status 'Updater unveraendert gelassen.' }
        } else { Write-Status 'Updater ist aktuell; keine Selbstaktualisierung erforderlich.' }
    } catch {
        Write-Status "FEHLER: $($_.Exception.Message)"
        Write-Status 'Falls das Add-on bereits installiert wurde, bleibt dieses Update bestehen. Abschlussmeldungen oben beachten.'
        throw
    } finally {
        if ($work -and (Test-Path -LiteralPath $work)) { Remove-Item -LiteralPath $work -Recurse -Force }
        $lock.Dispose()
    }
}

if (!$Library) {
    try { Invoke-Updater } catch {
        Write-Host "Update fehlgeschlagen: $($_.Exception.Message)" -ForegroundColor Red
        Write-Host 'Protokoll (sofern beschreibbar): .update\updater.log'
        exit 1
    }
}
