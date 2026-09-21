#!/usr/bin/env bash
set -euo pipefail
# Root provisioning for the dedicated dev tunnel; argument is a PUBLIC key file.
key_file=${1:?public key file required}
account=leader-sentry-dev-tunnel
account_home=/var/lib/leader-sentry-dev-tunnel
grep -Eq '^ssh-ed25519 [A-Za-z0-9+/=]+( .*)?$' "$key_file"
if ! id "$account" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "$account_home" --shell /usr/sbin/nologin "$account"
fi
install -d -m 700 -o "$account" -g "$account" "$account_home/.ssh"
python3 - "$key_file" "$account_home/.ssh/authorized_keys" <<'PY'
import pathlib, sys
key = pathlib.Path(sys.argv[1]).read_text().strip()
target = pathlib.Path(sys.argv[2])
line = 'restrict,port-forwarding,permitlisten="127.0.0.1:19001",command="/bin/false" ' + key
existing = target.read_text().splitlines() if target.exists() else []
if line not in existing:
    target.write_text('\n'.join(existing + [line]) + '\n')
PY
chown "$account:$account" "$account_home/.ssh/authorized_keys"
chmod 600 "$account_home/.ssh/authorized_keys"
install -m 644 "$(dirname "$0")/sshd-sentry-dev.conf" /etc/ssh/sshd_config.d/leader-sentry-dev.conf
sshd -t
systemctl reload ssh
