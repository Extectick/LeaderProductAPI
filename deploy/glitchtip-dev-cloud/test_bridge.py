import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock
from bridge import Bridge, project_event


class BridgeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.b = Bridge({'project': 'leader-app-dev', 'organization': 'dev'}, str(Path(self.tmp.name) / 'state.db'))
        self.addCleanup(self.b.db.close)
        self.b.read_level = Mock(return_value='fatal')
        self.event = {'eventId': 'a' * 32, 'dateCreated': '2026-09-21T01:00:00Z', 'tags': [{'key': 'environment', 'value': 'development'}]}

    def test_projection_removes_sensitive_structures(self):
        event = {**self.event, 'user': {'id': '1', 'email': 'private'}, 'request': {'body': 'private'}, 'entries': ['private'], 'contexts': {'device': {'model': 'Test', 'serial': 'private'}}}
        result = project_event(event, 'leader-app-dev')
        self.assertNotIn('private', json.dumps(result))
        self.assertEqual(result['event']['eventID'], 'a' * 32)

    def test_other_environment_not_forwarded(self):
        self.assertIsNone(project_event({**self.event, 'environment': 'production'}, 'leader-app-dev'))

    def test_no_ack_or_cursor_advance_on_failure(self):
        self.b.read_page = Mock(return_value=([self.event], ''))
        self.b.send = Mock(side_effect=OSError('offline'))
        with self.assertRaises(OSError):
            self.b.scan()
        self.assertEqual(self.b.db.execute('SELECT COUNT(*) FROM acknowledged').fetchone()[0], 0)
        self.assertIsNone(self.b.db.execute('SELECT * FROM state').fetchone())

    def test_repeated_event_sent_once(self):
        self.b.send = Mock()
        self.b.deliver([self.event, self.event])
        self.b.send.assert_called_once()
        self.assertEqual(self.b.send.call_args[0][0]['event']['level'], 'fatal')

    def test_cursor_rejects_other_host_and_endpoint(self):
        for url in ('https://evil.invalid' + self.b.prefix, '/api/0/users/', '//evil.invalid' + self.b.prefix):
            with self.assertRaises(ValueError):
                self.b.validate_path(url)

    def test_pagination(self):
        link = f'<http://web:8000{self.b.first}&cursor=abc>; rel="next"; results="true"'
        self.assertEqual(self.b.following(link), self.b.first + '&cursor=abc')
        self.assertIsNone(self.b.following(link.replace('true', 'false')))


if __name__ == '__main__':
    unittest.main()
