"""Run once via manage.py shell, against isolated GlitchTip only. No secrets stdout."""
import json
import os
from pathlib import Path
from urllib.parse import urlsplit
from uuid import UUID

from django.db import transaction, connection
from django.core.management.color import no_style
from apps.users.models import User
from apps.organizations_ext.models import Organization, OrganizationUser, OrganizationOwner
from apps.organizations_ext.constants import OrganizationUserRole
from apps.projects.models import Project, ProjectKey
from apps.api_tokens.models import APIToken

directory = Path('/run/leader-private')
seed = json.loads((directory / 'seed.json').read_text())
dsn = urlsplit(seed['dsn'])
assert dsn.hostname == 'dev.leader-product.ru' and seed['project'] == 'leader-app-dev'
assert int(dsn.path.rsplit('/', 1)[-1]) == int(seed['projectId'])
with transaction.atomic():
    admin, created = User.objects.get_or_create(email=seed['adminEmail'], defaults={
        'is_staff': True, 'is_superuser': True, 'is_active': True, 'name': 'Dev diagnostics admin'})
    if created:
        admin.set_password(seed['adminPassword'])
        admin.save()
    org, _ = Organization.objects.get_or_create(slug=seed['organization'], defaults={'name': 'LeaderProduct Dev', 'is_active': True})
    membership, _ = OrganizationUser.objects.get_or_create(organization=org, user=admin, defaults={'role': OrganizationUserRole.OWNER})
    OrganizationOwner.objects.get_or_create(organization=org, defaults={'organization_user': membership})
    project, _ = Project.objects.get_or_create(id=int(seed['projectId']), defaults={
        'organization': org, 'slug': seed['project'], 'name': seed['project'], 'platform': 'react-native'})
    assert project.organization_id == org.id and project.slug == seed['project']
    ProjectKey.objects.get_or_create(project=project, public_key=UUID(dsn.username), defaults={'name': 'Existing dev APK ingestion'})
    for statement in connection.ops.sequence_reset_sql(no_style(), [Project]):
        with connection.cursor() as cursor:
            cursor.execute(statement)
    tokens = {}
    for name, scopes in [('readToken', ['event:read', 'project:read']), ('authToken', ['project:releases', 'project:read', 'org:read'])]:
        token, _ = APIToken.objects.get_or_create(user=admin, label='leader-dev-' + name)
        token.add_permissions(scopes)
        tokens[name] = token.token
    cfg = {**seed, **tokens, 'sentryUrl': 'http://127.0.0.1:19000', 'provider': 'glitchtip'}
    for name, content in [('credentials.json', cfg), ('bridge.json', {k: cfg[k] for k in ('organization', 'project', 'readToken', 'webhookSecret')})]:
        target = directory / name
        target.write_text(json.dumps(content))
        os.chmod(target, 0o600)
print('GlitchTip dev project ready; original APK ingestion identity preserved.')
