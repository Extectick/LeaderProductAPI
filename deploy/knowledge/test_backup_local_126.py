"""Regression checks for private runtime configuration discovery, without services."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('backup_local', Path(__file__).with_name('backup-local-126.py'))
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


class ApiRecoveryConfiguration(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name in ['compose.yml', 'release-image.json', 'api.env', '.env', 'help-openai.private.json', 'help-t3.private.json']:
            (self.root / name).write_text('private test fixture')
        (self.root / 'secrets').mkdir()
        self.container = {'Config': {'Env': ['NODE_ENV=development', 'DATABASE_URL=postgresql://fixture/LeaderAPI_dev'],
                           'Labels': {'com.docker.compose.project.config_files': str(self.root / 'compose.yml') + ',' + str(self.root / 'help-openai.private.json')}},
                          'Mounts': [{'Type': 'bind', 'Source': str(self.root / 'secrets' / 'root-only-key')}]}

    def inspect(self, containers=None):
        return patch.object(backup, 'run', return_value=json.dumps(containers or [self.container, self.container]))

    def test_captures_current_provider_bindings_without_stat_of_private_children(self):
        original = Path.is_file
        def readable(path):
            if path.parent == self.root / 'secrets':
                raise PermissionError('root-only test fixture')
            return original(path)
        with self.inspect(), patch.object(Path, 'is_file', readable):
            files = backup.api_config_files(self.root)
        self.assertIn('secrets', files)
        self.assertIn('help-openai.private.json', files)
        self.assertIn('help-t3.private.json', files)
        self.assertIn('.env', files)
        self.assertEqual(len(files), len(set(files)))

    def test_rejects_production_database(self):
        self.container['Config']['Env'][1] = 'DATABASE_URL=postgresql://fixture/LeaderAPI_prod'
        with self.inspect(), self.assertRaisesRegex(RuntimeError, 'non-dev'):
            backup.api_config_files(self.root)

    def test_rejects_compose_outside_dev_root(self):
        self.container['Config']['Labels']['com.docker.compose.project.config_files'] = '/other/compose.yml'
        with self.inspect(), self.assertRaisesRegex(RuntimeError, 'Unexpected dev Compose'):
            backup.api_config_files(self.root)


if __name__ == '__main__':
    unittest.main()
