param([string]$Label = "violations", [string]$DbUser = "postgres")
Set-Location $PSScriptRoot
& "$PSScriptRoot\venv\Scripts\Activate.ps1"
$env:TEST_PG_HOST = "127.0.0.1"
$env:TEST_PG_PORT = "5432"
$env:TEST_PG_USER = $DbUser
$p = Read-Host "Type your LOCAL postgres password, then press Enter"
$env:TEST_PG_PASSWORD = $p
$env:PGPASSWORD = $p
psql -h 127.0.0.1 -U $DbUser -d postgres -c "select 1" | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Host "MALI ANG PASSWORD - ulitin ang script." -ForegroundColor Red; return }
if ($Label) { python manage.py test $Label --settings=core.test_settings_pg }
else        { python manage.py test --settings=core.test_settings_pg }
