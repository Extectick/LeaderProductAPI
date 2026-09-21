$ErrorActionPreference = 'Stop'
$taskRoot = 'C:\ProgramData\LeaderProduct\SentryDevTunnel'
$sshExe = 'C:\Windows\System32\OpenSSH\ssh.exe'
while ($true) {
    try {
    & $sshExe -NT -E "$taskRoot\ssh.log" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes `
        -o ExitOnForwardFailure=yes -o ServerAliveInterval=20 -o ServerAliveCountMax=3 `
        -o ConnectTimeout=10 `
        -o "UserKnownHostsFile=$taskRoot\known_hosts" -i "$taskRoot\id_ed25519" `
        -R '127.0.0.1:19001:127.0.0.1:19000' 'leader-sentry-dev-tunnel@155.212.144.191'
    } catch {
        # No credentials in logs; reconnect after network or process failures.
    }
    Start-Sleep -Seconds 15
}
