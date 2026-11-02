import importlib.util
from pathlib import Path
import unittest

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
    def test_wrong_mode_rejected(self):
        env = self.env('dev'); env['NODE_ENV'] = 'production'
        with self.assertRaises(RuntimeError): release.validate_target('dev', env)

if __name__ == '__main__': unittest.main()
