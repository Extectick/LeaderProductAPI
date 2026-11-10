"""Safety checks for host-wide unattended image retention. No Docker mutations."""
from datetime import datetime, timedelta, timezone
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("cleanup", Path(__file__).with_name("cleanup.py"))
cleanup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cleanup)
NOW = datetime(2026, 11, 5, tzinfo=timezone.utc)
POLICY = {"minimum_age_days": 7, "keep_per_repository": 3, "protected_references": ["api:rollback"]}


def image(name, age, *tags):
    return {"id": name, "tags": list(tags), "digests": [], "created": (NOW - timedelta(days=age)).isoformat()}


class RetentionSafety(unittest.TestCase):
    def setUp(self):
        self.images = [image("new", 1, "api:new"), image("middle", 10, "api:middle"),
                       image("third", 11, "api:third"), image("old", 30, "api:old")]

    def test_keeps_three_latest_and_recent_images(self):
        items = self.images + [image("recent-dangling", 2)]
        self.assertEqual([i["id"] for i in cleanup.candidates(items, [], POLICY, NOW)], ["old"])

    def test_running_and_stopped_containers_protect_actual_and_moved_tags(self):
        for container in [{"image": "old", "reference": "api:missing"},
                          {"image": "another-image", "reference": "api:old"}]:
            with self.subTest(container=container):
                self.assertEqual(cleanup.candidates(self.images, [container], POLICY, NOW), [])

    def test_named_rollback_is_kept_even_outside_latest_three(self):
        self.images[-1]["tags"].append("api:rollback")
        self.assertEqual(cleanup.candidates(self.images, [], POLICY, NOW), [])

    def test_each_registry_repository_keeps_its_own_latest_images(self):
        other = [image("other-old", 40, "registry:5000/project/api:v1")]
        self.assertEqual([i["id"] for i in cleanup.candidates(self.images + other, [], POLICY, NOW)], ["old"])
        self.assertEqual(cleanup.repository("registry:5000/project/api:v1"), "registry:5000/project/api")

    def test_digest_reference_is_grouped_with_tagged_images_of_the_same_repository(self):
        # Docker 29 containerd stores may return a digest reference in RepoTags.
        self.images[-1]["tags"] = ["api@sha256:0123456789abcdef"]
        self.assertEqual([i["id"] for i in cleanup.candidates(self.images, [], POLICY, NOW)], ["old"])
        self.assertEqual(cleanup.repository("registry:5000/project/api@sha256:1234"), "registry:5000/project/api")

    def test_added_tag_or_new_container_skips_a_previously_planned_deletion(self):
        original = self.images[-1]
        retagged = dict(original, tags=["api:old", "api:new-rollback"])
        with patch.object(cleanup, "image_inventory", return_value=[*self.images[:-1], retagged]), \
             patch.object(cleanup, "docker") as docker, patch.object(cleanup, "log"):
            cleanup.remove_candidate(original, POLICY, NOW)
            docker.assert_not_called()
        with patch.object(cleanup, "image_inventory", return_value=self.images), \
             patch.object(cleanup, "container_inventory", return_value=[{"image": "old", "reference": "api:old"}]), \
             patch.object(cleanup, "docker") as docker, patch.object(cleanup, "log"):
            cleanup.remove_candidate(original, POLICY, NOW)
            docker.assert_not_called()

    def test_deletion_uses_immutable_id_without_force(self):
        result = subprocess.CompletedProcess([], 1, "", "conflict")
        with patch.object(cleanup, "image_inventory", return_value=self.images), \
             patch.object(cleanup, "container_inventory", return_value=[]), \
             patch.object(cleanup, "docker", return_value=result) as docker, patch.object(cleanup, "log") as log:
            cleanup.remove_candidate(self.images[-1], POLICY, NOW)
            docker.assert_called_once_with("image", "rm", "old", allow_failure=True)
            self.assertEqual(log.call_args.args[0], "skip_docker_conflict")

    def test_failed_inventory_aborts_before_image_removal_or_cache_prune(self):
        with patch.object(cleanup, "image_inventory", return_value=self.images), \
             patch.object(cleanup, "container_inventory", side_effect=cleanup.CleanupError("inventory failed")), \
             patch.object(cleanup, "docker") as docker:
            with self.assertRaises(cleanup.CleanupError):
                cleanup.cleanup(POLICY, True)
            docker.assert_not_called()

    def test_dry_run_does_not_remove_images_or_prune_cache(self):
        with patch.object(cleanup, "image_inventory", return_value=self.images), \
             patch.object(cleanup, "container_inventory", return_value=[]), \
             patch.object(cleanup, "docker") as docker, patch.object(cleanup, "log"):
            cleanup.cleanup(POLICY, False)
            docker.assert_not_called()

    def test_unsafe_policy_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "policy.json"
            path.write_text('{"minimum_age_days":0,"keep_per_repository":3,"cache_max_gb":4}')
            with self.assertRaises(cleanup.CleanupError):
                cleanup.load_policy(path)


if __name__ == "__main__":
    unittest.main()
