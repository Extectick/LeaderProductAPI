"""Provision only the production diagnostics project; never touch business DBs."""
import json
import os
from pathlib import Path
from django.db import transaction
from apps.users.models import User
from apps.organizations_ext.models import Organization, OrganizationUser, OrganizationOwner
from apps.organizations_ext.constants import OrganizationUserRole
from apps.projects.models import Project, ProjectKey
from apps.api_tokens.models import APIToken

destination = Path('/run/leader-prod')
seed = json.loads(Path('/run/leader-dev-credentials.json').read_text())
assert seed['project'] == 'leader-app-dev'
with transaction.atomic():
    admin = User.objects.get(email=seed['adminEmail'], is_active=True)
    org, _ = Organization.objects.get_or_create(slug='leaderproduct-production', defaults={'name': 'LeaderProduct Production', 'is_active': True})
    member, _ = OrganizationUser.objects.get_or_create(organization=org, user=admin, defaults={'role': OrganizationUserRole.OWNER})
    OrganizationOwner.objects.get_or_create(organization=org, defaults={'organization_user': member})
    project, _ = Project.objects.get_or_create(organization=org, slug='leaderproduct-app-production', defaults={'name': 'LeaderProduct APP production', 'platform': 'react-native'})
    key, _ = ProjectKey.objects.get_or_create(project=project, name='Production mobile ingestion')
    config = {'organization': org.slug, 'project': project.slug, 'projectId': project.id,
              'environment': 'production', 'provider': 'glitchtip', 'sentryUrl': 'http://127.0.0.1:19000',
              'dsn': f'https://{key.public_key.hex}@api.leader-product.ru/sentry/{project.id}'}
    for name, scopes in [('readToken', ['event:read', 'project:read']), ('authToken', ['project:releases', 'project:read', 'org:read'])]:
        token, _ = APIToken.objects.get_or_create(user=admin, label='leader-prod-' + name)
        token.add_permissions(scopes)
        config[name] = token.token
    target = destination / 'credentials.json'
    target.write_text(json.dumps(config))
    os.chmod(target, 0o600)
print(json.dumps({'ready': True, 'project': project.slug, 'projectId': project.id, 'environment': 'production'}))
