# Автоматическая очистка Docker на сервере 126

Исходники: `deploy/docker-cleanup/`. Задание обслуживает Docker хоста
`192.168.30.126`, выполняется пользователем `extectick` через systemd user timer.
Для пользователя включён linger: таймер работает после перезагрузки и без SSH.
Lifecycle T3/Supervisor, Metro и Compose-проекты не меняются.

## Политика

- Ежедневно в **05:30 по часовому поясу сервера**, со случайной задержкой до 15 минут.
  `Persistent=true` запускает пропущенное задание при возвращении user manager.
- Возраст образа берётся из Docker `Created`. Сохраняются все образы моложе
  семи дней, три последних уникальных образа каждого репозитория, образы **всех**
  контейнеров (включая остановленные) и текущие значения их тегов.
- Закреплены rollback-образы `leaderproductapi:t3-dev-20261104-r2` и
  `leaderproductapi:help-questions-onec-grounded-dev-20261105`. Другие обязательные
  версии для отката добавлять в `protected_references` установленной политики.
  Три последних версии — дополнительный запас, а не обещание хранения всех
  исторических релизов из архивных deployment-снимков.
- Удаление по неизменяемому image ID, без `--force`. Перед каждым удалением
  повторно проверяются инвентарь, контейнеры и теги. Образы с несколькими тегами
  или зависимыми образами Docker может оставить; конфликт фиксируется в журнале.
  Общие слои работающих/сохранённых образов остаются в Docker.
- Кеш только стандартного BuildKit builder `default`: `until=168h`, целевой
  размер `4GB`. Активный и свежий кеш не удаляется; 4 ГБ — цель, не жёсткий лимит
  поверх фильтра возраста. Другие builders не затрагиваются.
- Тома, контейнеры, сети, базы, резервные копии и содержимое приложений не
  очищаются. `docker system prune` не используется.
- Очистка берёт существующий `/opt/leader-api-dev/deployment.lock`. Если DEV
  разворачивается или уже идёт очистка, запуск пропускается. При ошибке получения
  полного инвентаря очистка прекращается. Изменения других проектов Docker
  дополнительно защищены отказом от принудительного удаления.

## Установка

На хосте 126 файлы установлены в:

```text
~/.local/lib/leader-docker-cleanup/cleanup.py
~/.config/leader-docker-cleanup/policy.json
~/.config/systemd/user/leader-docker-cleanup.service
~/.config/systemd/user/leader-docker-cleanup.timer
```

При обновлении скопировать соответствующие файлы из `deploy/docker-cleanup/`,
сохраняя локальные дополнения `protected_references`, затем:

```sh
loginctl enable-linger extectick
systemctl --user daemon-reload
systemctl --user enable --now leader-docker-cleanup.timer
```

Проверка без удаления (режим по умолчанию):

```sh
python3 ~/.local/lib/leader-docker-cleanup/cleanup.py --config ~/.config/leader-docker-cleanup/policy.json
```

Запуск штатной очистки и проверка:

```sh
systemctl --user start leader-docker-cleanup.service
systemctl --user list-timers leader-docker-cleanup.timer
journalctl --user -u leader-docker-cleanup.service -n 50 --no-pager
docker system df
```

Для отключения: `systemctl --user disable --now leader-docker-cleanup.timer`.
Это не восстанавливает ранее удалённые неиспользуемые образы. Версии из registry
можно скачать повторно; локальные незакреплённые сборки после удаления потребуют
повторной сборки.

Проверка логики без доступа к Docker:

```sh
python3 -m unittest discover -s deploy/docker-cleanup -p 'test_*.py' -v
```

## Проверка установки 05.11.2026

Таймер включён, активен, linger подтверждён. Первый запуск актуального скрипта
завершился с `Result=success`, `ExecMainStatus=0`: удалён один неиспользуемый
образ API от 13 октября, число уникальных образов изменилось с 52 до 51.
Остальные неиспользуемые сборки пока моложе семи дней либо защищены политикой.
Все 34 контейнера сохранили свои ID/образы, unhealthy-контейнеров нет, оба
закреплённых rollback-образа присутствуют. Десять проверок логики очистки прошли.
