"""Run with `sentry exec` once. No secrets on stdout; keep the output private."""
import json
import os
import secrets
from pathlib import Path

from django.db import transaction
from sentry import options
from sentry.models.apitoken import ApiToken
from sentry.models.organization import Organization
from sentry.models.organizationmember import OrganizationMember
from sentry.models.project import Project
from sentry.models.projectkey import ProjectKey
from sentry.models.team import Team
from sentry.sentry_apps.models.servicehook import ServiceHook
from sentry.users.models.user import User

output = Path('/data/leader-dev-bootstrap.json')
if output.exists():
    print('Dev project already bootstrapped; credentials left unchanged')
else:
    password = secrets.token_urlsafe(32)
    with transaction.atomic(using='default'):
        user, created = User.objects.get_or_create(
            email='dev-admin@leader-product.ru',
            defaults={'username': 'dev-admin@leader-product.ru', 'is_superuser': True, 'is_staff': True, 'is_active': True},
        )
        if created:
            user.set_password(password)
            user.save()
        else:
            password = None  # Never reset an existing administrator's password.
        organization, _ = Organization.objects.get_or_create(slug='leaderproduct-dev', defaults={'name': 'LeaderProduct Dev'})
        OrganizationMember.objects.get_or_create(organization=organization, user_id=user.id, defaults={'role': 'owner'})
        team, _ = Team.objects.get_or_create(organization=organization, slug='development', defaults={'name': 'Development'})
        project, _ = Project.objects.get_or_create(organization=organization, slug='leader-app-dev', defaults={'name': 'LeaderProduct APP Dev', 'platform': 'react-native'})
        project.teams.add(team)
        key = ProjectKey.objects.filter(project=project).first() or ProjectKey.objects.create(project=project)
        token = ApiToken.objects.create(user=user, name='Dev local symbol upload', scope_list=['project:releases', 'project:read', 'event:read', 'org:read'], expires_at=None, refresh_token=None)
        read_token = ApiToken.objects.create(user=user, name='Dev crash reconciliation', scope_list=['event:read', 'project:read'], expires_at=None, refresh_token=None)
        hook, _ = ServiceHook.objects.get_or_create(
            project_id=project.id, url='https://dev.leader-product.ru/integrations/sentry/events',
            defaults={'organization_id': organization.id, 'actor_id': user.id, 'events': ['event.created']},
        )
        if not hook.servicehookproject_set.filter(project_id=project.id).exists():
            hook.add_project(project)
        options.set('system.url-prefix', 'http://localhost:19000')
        options.set('auth.allow-registration', False)
        project.update_option('sentry:storeCrashReports', False)
        project.update_option('sentry:scrubData', True)
        project.update_option('sentry:scrubIPAddresses', True)
        result = {
            'organization': organization.slug, 'project': project.slug, 'projectId': project.id,
            'dsn': f'https://{key.public_key}@dev.leader-product.ru/sentry/{project.id}',
            'sentryUrl': 'http://127.0.0.1:19000',
            'adminEmail': user.email, 'adminPassword': password,
            'authToken': token.plaintext_token, 'webhookSecret': hook.secret,
            'readToken': read_token.plaintext_token,
        }
        # Create with restrictive mode from the start; docker cp goes to a locked directory.
        with os.fdopen(os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as stream:
            json.dump(result, stream)
    print('Dev Sentry project and hook configured; credentials saved privately')

bridge_output = Path('/data/leader-dev-bridge.json')
if not bridge_output.exists():
    saved = json.loads(output.read_text())
    bridge = {key: saved[key] for key in ('organization', 'project', 'readToken', 'webhookSecret')}
    with os.fdopen(os.open(bridge_output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as stream:
        json.dump(bridge, stream)
