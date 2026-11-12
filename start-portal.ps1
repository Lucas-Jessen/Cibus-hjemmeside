# Starter Cibus-portalen og genstarter den automatisk, hvis den stopper (fx efter en uventet fejl).
# Brug:  powershell -NoProfile -ExecutionPolicy Bypass -File start-portal.ps1
# Stop med Ctrl-C (to gange, hvis den lige er ved at genstarte).
Set-Location -Path $PSScriptRoot
$restarts = 0
while ($true) {
    Write-Host ("[{0:HH:mm:ss}] Starter Cibus-portalen (genstart nr. {1})" -f (Get-Date), $restarts)
    & node server.js
    $code = $LASTEXITCODE
    $restarts++
    Write-Host ("[{0:HH:mm:ss}] Portalen stoppede med kode {1}; genstarter om 3 sekunder ..." -f (Get-Date), $code) -ForegroundColor Yellow
    Start-Sleep -Seconds 3
}
