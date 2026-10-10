param([string]$Directory = 'C:\ProgramData\LeaderProduct\GlitchTipDevCloud')
$ErrorActionPreference = 'Stop'
if (Test-Path -LiteralPath (Join-Path $Directory 'app.env')) { throw 'Already initialized; do not rotate secrets' }
$old = Get-Content -LiteralPath 'C:\ProgramData\LeaderProduct\GlitchTipDev\credentials.json' -Raw | ConvertFrom-Json
if (([Uri]$old.dsn).Host -ne 'dev.leader-product.ru' -or $old.project -ne 'leader-app-dev') { throw 'Dev-only guard failed' }
New-Item -ItemType Directory -Path $Directory -Force | Out-Null
& icacls $Directory /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Cannot protect private directory' }
function New-Secret { [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant() }
$password = New-Secret
$secret = New-Secret
$appEnv = @"
DATABASE_URL=postgres://glitchtip:$password@postgres:5432/glitchtip
SECRET_KEY=$secret
SERVER_ROLE=all_in_one
VALKEY_URL=
GLITCHTIP_DOMAIN=http://127.0.0.1:19002
GLITCHTIP_CHUNK_UPLOAD_USE_RELATIVE_URL=True
ALLOWED_HOSTS=localhost,127.0.0.1,web,dev.leader-product.ru
CSRF_TRUSTED_ORIGINS=http://localhost:19000,http://127.0.0.1:19000,http://127.0.0.1:19002,http://127.0.0.1:19020
ENABLE_USER_REGISTRATION=False
ENABLE_ORGANIZATION_CREATION=False
ENABLE_OPENAPI=False
GLITCHTIP_ENABLE_LOGS=False
GLITCHTIP_ENABLE_UPTIME=False
GLITCHTIP_ENABLE_DUCKDB=False
GLITCHTIP_ENABLE_MCP=False
GLITCHTIP_RETENTION_DAYS=14
GLITCHTIP_FILE_RETENTION_DAYS=60
EMAIL_ENABLED=False
EMAIL_BACKEND=django.core.mail.backends.dummy.EmailBackend
GRANIAN_WORKERS=1
GRANIAN_WORKERS_MAX_RSS=512
DATABASE_POOL_MIN_SIZE=1
DATABASE_POOL_MAX_SIZE=4
VTASKS_INGEST_CONCURRENCY=1
VTASKS_CONCURRENCY=1
"@
[IO.File]::WriteAllText((Join-Path $Directory 'app.env'), $appEnv.Replace("`r`n", "`n"))
[IO.File]::WriteAllText((Join-Path $Directory 'postgres.env'), "POSTGRES_USER=glitchtip`nPOSTGRES_DB=glitchtip`nPOSTGRES_PASSWORD=$password`n")
$seed = @{dsn=$old.dsn; project=$old.project; organization=$old.organization; projectId=$old.projectId; adminEmail=$old.adminEmail; adminPassword=(New-Secret); webhookSecret=$old.webhookSecret}
[IO.File]::WriteAllText((Join-Path $Directory 'seed.json'), ($seed | ConvertTo-Json))
Write-Output 'Private dev cloud configuration created; credentials not printed.'
