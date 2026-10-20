$ErrorActionPreference = 'Stop'

try {
    $root = Split-Path -Parent $PSScriptRoot
    $tool = Join-Path $PSScriptRoot 'galaxy-data.js'
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        throw 'Node.js was not found. Install Node.js 22 or newer, then run this starter again.'
    }
    $nodeVersion = & node --version
    if ($LASTEXITCODE -ne 0) {
        throw 'Could not determine the installed Node.js version.'
    }
    if ($nodeVersion -notmatch '^v(\d+)\.') {
        throw "Unrecognized Node.js version: $nodeVersion"
    }
    if ([int]$Matches[1] -lt 22) {
        throw 'This tool requires Node.js 22 or newer.'
    }

    Write-Host 'Nexus Overseer - Import public galaxy data'
    Write-Host 'Select a public JSON export, not a backup or diagnostic log.'
    Write-Host 'Nothing is uploaded, committed or pushed.'
    Write-Host ''

    Add-Type -AssemblyName System.Windows.Forms
    $picker = New-Object System.Windows.Forms.OpenFileDialog
    $picker.Title = 'Select Nexus Overseer public galaxy export'
    $picker.Filter = 'Public galaxy export (*.json)|*.json'
    $picker.CheckFileExists = $true
    $picker.Multiselect = $false
    $picker.InitialDirectory = [Environment]::GetFolderPath('UserProfile')
    try {
        if ($picker.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) {
            Write-Host 'Cancelled. Nothing was changed.'
            exit 0
        }
        $inputFile = $picker.FileName
    } finally {
        $picker.Dispose()
    }

    Set-Location -LiteralPath $root
    & node $tool guided $inputFile
    if ($LASTEXITCODE -ne 0) {
        throw 'Import was not completed successfully. See the details above. Do not commit until validation passes.'
    }
    exit 0
} catch {
    Write-Host ''
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
