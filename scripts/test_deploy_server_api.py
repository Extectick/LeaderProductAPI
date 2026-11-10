import importlib.util
from pathlib import Path
import unittest
import tempfile

spec = importlib.util.spec_from_file_location('release', Path(__file__).with_name('deploy-server-api.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)

class TargetGuardTests(unittest.TestCase):
    def env(self, target):
        return {'DATABASE_URL': 'postgresql://u:p@db/' + ('LeaderAPI_dev' if target == 'dev' else 'LeaderAPI'),
                'DB_ACCEPT_DATA_LOSS': '0', 'NODE_ENV': 'development' if target == 'dev' else 'production'}
    def test_correct_targets(self):
        for target in ['dev', 'prod']:
            self.assertTrue(release.validate_target(target, self.env(target)))
    def test_cross_database_rejected(self):
        for target, wrong in [('dev', 'prod'), ('prod', 'dev')]:
            with self.assertRaises(RuntimeError):
                release.validate_target(target, self.env(wrong))
    def test_data_loss_rejected(self):
        env = self.env('dev'); env['DB_ACCEPT_DATA_LOSS'] = '1'
        with self.assertRaises(RuntimeError): release.validate_target('dev', env)
    def test_bunny_worker_only_deploys_with_dev_binding(self):
        self.assertEqual(release.release_services('dev', True), ['api', 'help-assistant-worker'])
        self.assertEqual(release.release_services('dev', False), ['api'])
        self.assertEqual(release.release_services('prod', True), ['api', 'help-assistant-worker', 'knowledge-worker'])
        self.assertEqual(release.release_services('prod', False), ['api'])

    def test_wrong_mode_rejected(self):
        env = self.env('dev'); env['NODE_ENV'] = 'production'
        with self.assertRaises(RuntimeError): release.validate_target('dev', env)

    def test_t3_binding_overrides_bunny_and_never_applies_to_prod(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            self.assertEqual(release.help_binding_files('dev', root), [])
            for name in ['help-bunny.private.json', 'help-t3.private.json']:
                (root / name).write_text('{}')
            self.assertEqual([p.name for p in release.help_binding_files('dev', root)],
                             ['help-bunny.private.json', 'help-t3.private.json'])
            self.assertEqual(release.help_binding_files('prod', root), [])
            (root / 'help-bunny.private.json').unlink()
            self.assertEqual([p.name for p in release.help_binding_files('dev', root)], ['help-t3.private.json'])
            (root / 'help-openai.private.json').write_text('{}')
            self.assertEqual([p.name for p in release.help_binding_files('dev', root)],
                             ['help-t3.private.json', 'help-openai.private.json'])
            self.assertEqual(release.help_binding_files('prod', root), [])

    def test_prod_overlay_is_explicit_and_separate_from_dev_provider_secrets(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for name in ['help-openai.private.json', 'help-t3.private.json', 'help-production.private.json']:
                (root / name).write_text('{}')
            self.assertEqual([p.name for p in release.help_binding_files('prod', root)], ['help-production.private.json'])
            self.assertEqual([p.name for p in release.help_binding_files('dev', root)], ['help-t3.private.json', 'help-openai.private.json'])

if __name__ == '__main__': unittest.main()
