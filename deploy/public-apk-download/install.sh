#!/bin/sh
set -eu

# Run from the uploaded directory containing index.html, app.js and nginx.conf.
site=/etc/nginx/sites-available/leader-product-api
snippet=/etc/nginx/snippets/leader-apk-download.conf
webroot=/var/www/leader-product-download
backup=/var/backups/leader-apk-download/$(date -u +%Y%m%dT%H%M%SZ)
test "$(readlink -f "$site")" = "$site"
test -f index.html && test -f app.js && test -f nginx.conf
grep -q 'server_name api.leader-product.ru;' "$site"
if [ "$(grep -c 'leader-apk-download.conf' "$site")" -gt 1 ]; then
  echo 'Unexpected duplicate configuration' >&2; exit 1
fi
install -d -m 700 "$backup"
cp -p "$site" "$backup/site.conf"
if [ -f "$snippet" ]; then cp -p "$snippet" "$backup/snippet.conf"; fi
if [ -d "$webroot" ]; then cp -a "$webroot" "$backup/previous-page"; fi
rollback() {
  cp -p "$backup/site.conf" "$site"
  if [ -f "$backup/snippet.conf" ]; then cp -p "$backup/snippet.conf" "$snippet"; fi
  if [ -d "$backup/previous-page" ]; then cp -a "$backup/previous-page/." "$webroot/"; fi
  nginx -t && systemctl reload nginx
}
install -d -m 755 "$webroot" /etc/nginx/snippets
install -m 644 index.html "$webroot/index.html"
install -m 644 app.js "$webroot/app.js"
install -m 644 nginx.conf "$snippet"
if ! grep -q 'leader-apk-download.conf' "$site"; then
  sed -i '0,/server_name api.leader-product.ru;/s@server_name api.leader-product.ru;@server_name api.leader-product.ru;\n    include /etc/nginx/snippets/leader-apk-download.conf;@' "$site"
fi
if ! nginx -t; then rollback; exit 1; fi
if ! systemctl reload nginx; then rollback; exit 1; fi
# reload is graceful: an immediate request can still reach an old worker.
healthy=false
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if curl --fail --silent --resolve api.leader-product.ru:443:127.0.0.1 https://api.leader-product.ru/download >/dev/null; then
    healthy=true; break
  fi
  sleep 1
done
if [ "$healthy" != true ]; then rollback; exit 1; fi
printf 'Permanent APK page installed; backup: %s\n' "$backup"
