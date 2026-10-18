# =============================================================================
#  down.ps1 - guaranteed clean teardown of the Web Linux Desktop stack (Windows).
#
#  `docker compose down` on its own can fail with
#
#      ! Network webdesktop_sessions Resource is still in use
#
#  because session containers are created through the Docker API and are not
#  compose services: compose never stops them, and a running one holds an
#  endpoint on the internal `sessions` network.
#
#  The manager handles the normal case by stopping its containers on SIGTERM.
#  This script is the escape hatch for the rest: it stops the manager, sweeps up
#  whatever is left, and only then calls `compose down`.
#
#  Usage:
#    .\scripts\down.ps1                # stop everything, keep home volumes
#    .\scripts\down.ps1 -SessionData   # also delete per-session home volumes
#    .\scripts\down.ps1 -Volumes       # stop everything and delete all volumes
# =============================================================================
[CmdletBinding()]
param(
    [switch]$Volumes,
    [switch]$SessionData
)

$ErrorActionPreference = 'Continue'
Push-Location (Join-Path $PSScriptRoot '..')

function Say($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }

Say 'stopping the manager'
docker compose stop manager 2>$null | Out-Null

Say 'removing leftover session containers'
# NOTE: no @splatting here. docker returns one line per id, and splatting a
# single string makes PowerShell unroll it into single characters, which turns
# one id into a dozen "No such container" errors.
$leftovers = @(docker ps -aq --filter 'label=webdesktop.session' | Where-Object { $_ })
if ($leftovers.Count -gt 0) {
    docker rm -f $leftovers
} else {
    Write-Host 'none'
}

if ($SessionData) {
    Say 'removing session home volumes'
    # By label, and by name pattern for volumes created before labels existed.
    $vols = @(
        docker volume ls -q --filter 'label=webdesktop.session'
        docker volume ls -q --filter 'name=wd-home-'
    ) | Where-Object { $_ } | Sort-Object -Unique
    if ($vols.Count -gt 0) { docker volume rm -f $vols } else { Write-Host 'none' }
}

if ($Volumes) {
    Say 'docker compose down --volumes'
    docker compose down --volumes --remove-orphans
} else {
    Say 'docker compose down'
    docker compose down --remove-orphans
}

Say 'leftovers'
docker ps -a --filter 'label=webdesktop.session' --format 'container {{.Names}} ({{.Status}})'
docker volume ls --filter 'name=wd-home-' --format 'volume   {{.Name}}'
docker network ls --filter 'name=webdesktop_' --format 'network  {{.Name}}'
Write-Host 'done' -ForegroundColor Green

Pop-Location