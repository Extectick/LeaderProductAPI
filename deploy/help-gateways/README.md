# Private Help gateway executor

The host user service runs `executor.py` with system OpenSSH, not inside the API
image. Operator-managed keys/known_hosts live in the service user's private
`~/.local/share/leader-help-gateways/` (directory0700, files0600). Never commit
keys, place them in Docker layers, APP configuration or model context.

The socket directory `/opt/leader-api-dev/gateway-runtime` is owner1001/group10001,
mode2750. The daemon creates `control.sock` mode0660, inheriting that group. API
and worker receive a read-only bind mount of this directory at
`/run/leader-help-gateways`. There is no public listener or arbitrary shell API.

Only POST `/diagnose` with exact gateway/kind enum values is accepted. Fixed
read commands run through pinned host keys and key-only SSH. Omsk uses stable
Prostor95.80.103.205 first, then the observed Dom.ru91.144.170.136 if connection
fails. A changed PPPaddress requires an operator update/identity verification;
the model cannot supply a new address. Gateways and their own services are never
restarted by this executor. Unavailable privileged counters remain unavailable;
no sudo password is stored or sent. WireGuard handshake read uses `sudo -n` only.

Install the user unit under `~/.config/systemd/user/`, with linger enabled for
the service account. Existing T3, Metro, VPN and Supervisor managers are unrelated
and must not be changed. Only an operator provisions credentials; source files
here contain no credential values.

Checks: `python3 -m unittest discover -s deploy/help-gateways -p 'test_*.py'`,
API `help.gateway-tools.unit.test.ts` and normal Help adapter regression suites.
Root workspace `docs/infrastructure/gateways.md` records topology and live proof.

## Read-only network discovery (2026-11-10)

Install **both `executor.py` and `discovery.py` in the same service directory**.
Only restart the existing user `leader-help-gateways.service`; gateway services,
T3, Metro and VPN are unrelated. The Python helper is sent through the existing
pinned SSH session, executed from stdin and does not install anything on gateways.

New `app_gateway_diagnostics` kinds:

- `dhcp`: whitelisted ISC/Kea lease and reservation fields, never whole configs.
- `devices`: DHCP plus local IPv4 neighbour cache.
- `printers`: bounded TCP discovery of 631/9100/515 and IPP
  Get-Printer-Attributes for model/name/location. No print jobs, credentials,
  settings writes, HTTP redirects or user-provided addresses/ports.
- `smb`: six fixed effective Samba guest/signing/protocol/share settings.

Discovery requires an allowlisted office /24 to also exist on an UP interface:
NSK `192.168.30.0/24`, `192.168.20.0/24`; Omsk `192.168.0.0/24`. A routed/VPN/WAN
address cannot expand this scope. Printer discovery uses at most32 workers,
250ms TCP connects, 18s scan budget, 700ms IPP reads and256 returned candidates.
It reports attempted/completed counts, `scanComplete` and row truncation.
The API allows65s for two30s SSH attempts (Omsk fallback). Existing diagnostic
requests allow45s for the two21s attempts.

DHCP/neighbour lists can be stale and omit static devices. An open printing port
is only a candidate; IPP attributes are untrusted device claims. USB/offline or
firewalled printers may be absent. Missing permissions, inaccessible sources,
oversized files or unsupported Kea JSON formats yield unavailable, not an empty
authoritative inventory. ISC includes are not traversed. Host configuration is
not proof of a Windows client's policies or a user's effective share permissions.
Live observations remain IT/admin-only with before/after/final ACL revalidation.
