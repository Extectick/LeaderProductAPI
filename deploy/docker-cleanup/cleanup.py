#!/usr/bin/env python3
"""Age-based image retention; dry run unless --apply is explicitly supplied."""
import argparse
from collections import defaultdict
from datetime import datetime, timedelta, timezone
import fcntl
import json
from pathlib import Path
import subprocess


class CleanupError(RuntimeError):
    pass


def log(event, **fields):
    print(json.dumps({"event": event, **fields}, ensure_ascii=False), flush=True)


def docker(*args, allow_failure=False, timeout=120):
    result = subprocess.run(
        ["/usr/bin/docker", *args], capture_output=True, text=True, timeout=timeout
    )
    if result.returncode and not allow_failure:
        # Do not log Docker/registry diagnostics or resolved configurations.
        raise CleanupError(f"Docker {args[0]} failed (exit {result.returncode})")
    return result


def timestamp(value):
    # Docker emits RFC3339Nano, datetime supports microseconds.
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def image_inventory():
    ids = sorted(set(docker("image", "ls", "-aq", "--no-trunc").stdout.split()))
    if not ids:
        return []
    fmt = '{"id":{{json .Id}},"tags":{{json .RepoTags}},"digests":{{json .RepoDigests}},"created":{{json .Created}}}'
    result = docker("image", "inspect", "--format", fmt, *ids)
    images = [json.loads(line) for line in result.stdout.splitlines()]
    if len(images) != len(ids):
        raise CleanupError("Incomplete image inventory")
    return images


def container_inventory():
    ids = docker("container", "ls", "-aq", "--no-trunc").stdout.split()
    if not ids:
        return []
    fmt = '{"image":{{json .Image}},"reference":{{json .Config.Image}}}'
    result = docker("container", "inspect", "--format", fmt, *ids)
    containers = [json.loads(line) for line in result.stdout.splitlines()]
    if len(containers) != len(ids):
        raise CleanupError("Incomplete container inventory")
    return containers


def repository(tag):
    # Docker's containerd image store can include digest references in RepoTags.
    tag = tag.split("@", 1)[0]
    # A registry port is not a tag separator.
    return tag.rsplit(":", 1)[0] if ":" in tag.rsplit("/", 1)[-1] else tag


def protected_ids(images, containers, policy):
    by_reference = {}
    for image in images:
        by_reference[image["id"]] = image["id"]
        for ref in (image["tags"] or []) + (image["digests"] or []):
            by_reference[ref] = image["id"]
    protected = {item["image"] for item in containers}
    # Preserve both the actual image and a moved tag used by a container's config.
    refs = policy["protected_references"] + [item["reference"] for item in containers]
    protected.update(by_reference[ref] for ref in refs if ref in by_reference)
    groups = defaultdict(list)
    for image in images:
        for repo in {repository(tag) for tag in image["tags"] or []}:
            groups[repo].append(image)
    for group in groups.values():
        group.sort(key=lambda item: (timestamp(item["created"]), item["id"]), reverse=True)
        protected.update(item["id"] for item in group[:policy["keep_per_repository"]])
    return protected


def candidates(images, containers, policy, now):
    protected = protected_ids(images, containers, policy)
    cutoff = now - timedelta(days=policy["minimum_age_days"])
    # Remove children before parents where the image store retains parent links.
    return sorted(
        (item for item in images if item["id"] not in protected and timestamp(item["created"]) < cutoff),
        key=lambda item: timestamp(item["created"]), reverse=True,
    )


def remove_candidate(original, policy, now):
    # Re-read before every removal: new containers, retags and missing inventories
    # must not turn a previously safe plan into destructive cleanup.
    images = image_inventory()
    current = next((item for item in images if item["id"] == original["id"]), None)
    if not current or set(current["tags"] or []) != set(original["tags"] or []):
        log("skip_changed", image=original["id"])
        return
    eligible = {item["id"] for item in candidates(images, container_inventory(), policy, now)}
    if current["id"] not in eligible:
        log("skip_protected", image=current["id"])
        return
    # Remove by immutable ID, never by a tag that another deployment can move.
    # Never force removal: Docker rejects container/dependent-image conflicts and
    # images with multiple tags. Such images remain for deliberate manual review.
    result = docker("image", "rm", current["id"], allow_failure=True)
    log("remove_image" if result.returncode == 0 else "skip_docker_conflict",
        image=current["id"], references=current["tags"] or [], exit_code=result.returncode)


def load_policy(path):
    policy = json.loads(path.read_text())
    for key in ("minimum_age_days", "keep_per_repository", "cache_max_gb"):
        if type(policy.get(key)) is not int or policy[key] < 1:
            raise CleanupError(f"Invalid policy: {key}")
    refs = policy.get("protected_references")
    if not isinstance(refs, list) or any(
        not isinstance(ref, str) or not ref or ref.startswith("-") or any(c.isspace() for c in ref)
        for ref in refs
    ):
        raise CleanupError("Invalid protected_references")
    lock = policy.get("deployment_lock")
    if not isinstance(lock, str) or not Path(lock).is_absolute():
        raise CleanupError("Invalid deployment_lock")
    return policy


def cleanup(policy, apply):
    now = datetime.now(timezone.utc)
    images = image_inventory()
    containers = container_inventory()
    plan = candidates(images, containers, policy, now)
    log("plan", apply=apply, images=len(images), containers=len(containers), candidates=len(plan))
    for item in plan:
        log("candidate", image=item["id"], references=item["tags"] or [], created=item["created"])
    if not apply:
        log("dry_run_complete", cache_prune=False)
        return
    for item in plan:
        remove_candidate(item, policy, now)
    hours = policy["minimum_age_days"] * 24
    # BuildKit excludes active/in-use cache. The age filter takes precedence over
    # the target size: recent cache is retained even when the target is exceeded.
    docker("buildx", "prune", "--builder", "default", "--force",
           "--filter", f"until={hours}h", "--max-used-space", f'{policy["cache_max_gb"]}GB', timeout=600)
    log("complete", cache_minimum_age_hours=hours, cache_target_gb=policy["cache_max_gb"])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    policy = load_policy(args.config)
    state = Path.home() / ".local/state/leader-docker-cleanup"
    state.mkdir(parents=True, exist_ok=True)
    # The deployment lock is shared with the existing DEV release scripts.
    # Do not create a new lock silently if the configured deployment path is wrong.
    with (state / "cleanup.lock").open("a") as own_lock, Path(policy["deployment_lock"]).open("r+") as deploy_lock:
        try:
            fcntl.flock(own_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.flock(deploy_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            log("skip_busy", reason="cleanup or DEV deployment already running")
            return
        cleanup(policy, args.apply)


if __name__ == "__main__":
    try:
        main()
    except (CleanupError, OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired) as error:
        # Exception details may originate in external tools; keep logs non-secret.
        log("failed", error_type=type(error).__name__)
        raise SystemExit(1)
