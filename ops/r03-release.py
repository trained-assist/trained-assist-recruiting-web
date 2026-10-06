#!/usr/bin/env python3
"""Immutable Recruiting artifact and disabled RU stage promotion. No public activation."""

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import socket
import stat
import subprocess
import sys
import tarfile
import tempfile

REPO = "trained-assist/trained-assist-recruiting-web"
RELEASES = Path("/opt/trained-assist-recruiting-web/releases")
UNIT = Path("/etc/systemd/system/trained-recruiting-r03-stage.service")
STATE = Path("/var/lib/trained-assist-recruiting-release-cd")
STAGE = Path("/var/lib/trained-recruiting-r03-stage")
SHA = re.compile(r"[0-9a-f]{40}\Z")
DIGEST = re.compile(r"[0-9a-f]{64}\Z")


def fail(reason):
    raise RuntimeError(reason)


def run(*args, input_bytes=None):
    return subprocess.run(args, input=input_bytes, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, check=True).stdout.decode().strip()


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def checked_manifest(archive, manifest_path, approved_digest):
    if not DIGEST.fullmatch(approved_digest):
        fail("invalid_approved_digest")
    manifest = json.loads(Path(manifest_path).read_text())
    if set(manifest) != {"schemaVersion", "repository", "sourceSha", "archiveSha256"} or \
            manifest["schemaVersion"] != 1 or manifest["repository"] != REPO or \
            not SHA.fullmatch(manifest["sourceSha"]) or \
            manifest["archiveSha256"] != approved_digest or sha256(archive) != approved_digest:
        fail("artifact_manifest_mismatch")
    embedded_sha = run("git", "get-tar-commit-id", input_bytes=Path(archive).read_bytes())
    if embedded_sha != manifest["sourceSha"]:
        fail("git_archive_commit_mismatch")
    required = {"source/package-lock.json", "source/package.json",
                "source/src/r03-private-web-runtime.js",
                "source/infra/systemd/trained-recruiting-r03-stage.service"}
    names = set()
    total_size = 0
    with tarfile.open(archive) as tar:
        for member in tar:
            name = PurePosixPath(member.name)
            if name.is_absolute() or ".." in name.parts or name.parts[0] != "source" or \
                    member.name.rstrip("/") != name.as_posix() or \
                    not (member.isfile() or member.isdir()):
                fail("unsafe_archive_member")
            if name.as_posix() in names:
                fail("duplicate_archive_member")
            names.add(name.as_posix())
            total_size += member.size
            if total_size > 128 * 1024 * 1024:
                fail("release_archive_too_large")
    if not required <= names:
        fail("incomplete_release_archive")
    return manifest


def package(args):
    source = Path(args.source).resolve()
    revision = run("git", "-C", str(source), "rev-parse", "HEAD")
    if not SHA.fullmatch(revision) or args.source_sha != revision:
        fail("source_revision_mismatch")
    archive = Path(args.archive).resolve()
    archive.parent.mkdir(parents=True, exist_ok=True)
    with open(archive, "wb") as output:
        subprocess.run(["git", "-C", str(source), "archive", "--format=tar",
                        "--prefix=source/", revision], stdout=output, check=True)
    manifest = {"schemaVersion": 1, "repository": REPO, "sourceSha": revision,
                "archiveSha256": sha256(archive)}
    Path(args.manifest).write_text(json.dumps(manifest, sort_keys=True, indent=2) + "\n")
    checked_manifest(archive, args.manifest, manifest["archiveSha256"])
    print(json.dumps(manifest, sort_keys=True))


def host_gate(args):
    if os.geteuid() != 0 or socket.gethostname() != args.expected_hostname or \
            not DIGEST.fullmatch(args.expected_machine_id_sha256) or \
            hashlib.sha256(Path("/etc/machine-id").read_bytes()).hexdigest() != args.expected_machine_id_sha256:
        fail("host_identity_mismatch")
    enabled = subprocess.run(["systemctl", "is-enabled", UNIT.name], capture_output=True, text=True)
    active = subprocess.run(["systemctl", "is-active", UNIT.name], capture_output=True, text=True)
    if enabled.stdout.strip() != "disabled" or active.stdout.strip() != "inactive":
        fail("stage_unit_must_be_disabled_and_inactive")
    for name in ("trained-recruiting-hh-minute.timer", "trained-recruiting-hh-score.timer"):
        result = subprocess.run(["systemctl", "is-active", name], capture_output=True, text=True)
        if result.stdout.strip() == "active":
            fail("recruiting_timer_active")
    if RELEASES.is_symlink() or not RELEASES.is_dir() or UNIT.is_symlink() or \
            STAGE.is_symlink() or not STAGE.is_dir() or \
            not (STAGE / "config.json").is_file() or \
            not (STAGE / "receipt.json").is_file():
        fail("private_stage_missing")
    for path in (STAGE / "config.json", STAGE / "receipt.json", STAGE / "secrets"):
        if path.is_symlink():
            fail("private_stage_symlink")
    for name in ("legacy_page_secret", "hh_encryption_key", "hh_client_id",
                 "hh_client_secret", "hh_user_agent", "ladder_token"):
        if (STAGE / "secrets" / name).is_symlink() or \
                not (STAGE / "secrets" / name).is_file():
            fail("private_stage_credential_missing")
    with socket.socket() as sock:
        try:
            sock.bind(("127.0.0.1", 18083))
        except OSError:
            fail("stage_loopback_port_busy")
    return hashlib.sha256(run("nginx", "-T").encode()).hexdigest()


def extract(archive, destination):
    with tarfile.open(archive) as tar:
        for member in tar:
            relative = PurePosixPath(member.name).relative_to("source")
            if str(relative) == ".":
                continue
            target = destination.joinpath(*relative.parts)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with tar.extractfile(member) as source, open(target, "wb") as output:
                    shutil.copyfileobj(source, output)
                target.chmod(0o755 if member.mode & 0o111 else 0o644)


def write_private(path, content):
    temporary = path.with_name(path.name + ".new")
    temporary.write_bytes(content)
    temporary.chmod(0o600)
    os.replace(temporary, path)


def make_release_readable(release):
    root = release.resolve(strict=True)
    for directory, subdirectories, files in os.walk(root, followlinks=False):
        Path(directory).chmod(0o755)
        for name in subdirectories + files:
            path = Path(directory) / name
            mode = path.lstat().st_mode
            if stat.S_ISLNK(mode):
                if not path.resolve(strict=True).is_relative_to(root):
                    fail("release_dependency_symlink_escapes_root")
            elif stat.S_ISDIR(mode):
                path.chmod(0o755)
            elif stat.S_ISREG(mode):
                path.chmod(0o755 if mode & 0o111 else 0o644)
            else:
                fail("release_dependency_special_file")


def install(args):
    manifest = checked_manifest(args.archive, args.manifest, args.approved_sha256)
    nginx_before = host_gate(args)
    source_sha = manifest["sourceSha"]
    release = RELEASES / source_sha
    if release.exists():
        fail("release_already_exists")
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    STATE.chmod(0o700)
    receipt_path = STATE / (source_sha + ".json")
    backup_path = STATE / (source_sha + ".previous.service")
    if receipt_path.exists() or backup_path.exists():
        fail("release_receipt_already_exists")
    previous = UNIT.read_bytes()
    template = None
    with tempfile.TemporaryDirectory(prefix=".r03-release-", dir=RELEASES) as temporary:
        candidate = Path(temporary)
        extract(args.archive, candidate)
        template = (candidate / "infra/systemd/trained-recruiting-r03-stage.service").read_text()
        if template.count("@RELEASE_SHA@") != 2:
            fail("unexpected_unit_template")
        run("npm", "ci", "--omit=dev", "--no-audit", "--no-fund", "--prefix", str(candidate))
        run("npm", "rebuild", "better-sqlite3", "--prefix", str(candidate))
        make_release_readable(candidate)
        candidate.rename(release)
    rendered = template.replace("@RELEASE_SHA@", source_sha).encode()
    # Verify the exact file before replacing the installed unit.
    verify_path = STATE / (source_sha + ".candidate.service")
    write_private(verify_path, rendered)
    try:
        run("systemd-analyze", "verify", str(verify_path))
        write_private(backup_path, previous)
        receipt = {"schemaVersion": 1, "sourceSha": source_sha,
                   "archiveSha256": args.approved_sha256, "previousUnitSha256": hashlib.sha256(previous).hexdigest(),
                   "newUnitSha256": hashlib.sha256(rendered).hexdigest(), "nginxSha256": nginx_before,
                   "status": "prepared"}
        write_private(receipt_path, (json.dumps(receipt, sort_keys=True, indent=2) + "\n").encode())
        write_private(UNIT, rendered)
        run("systemctl", "daemon-reload")
        if host_gate(args) != nginx_before or sha256(UNIT) != receipt["newUnitSha256"]:
            fail("post_install_guard_failed")
        receipt["status"] = "disabled_staged"
        write_private(receipt_path, (json.dumps(receipt, sort_keys=True, indent=2) + "\n").encode())
        print(json.dumps({"sourceSha": source_sha, "status": receipt["status"]}))
    except Exception:
        if backup_path.exists():
            write_private(UNIT, previous)
            run("systemctl", "daemon-reload")
        elif release.exists() and UNIT.read_bytes() == previous:
            shutil.rmtree(release)
        raise
    finally:
        verify_path.unlink(missing_ok=True)


def rollback(args):
    host_gate(args)
    if not SHA.fullmatch(args.source_sha):
        fail("invalid_source_sha")
    receipt_path = STATE / (args.source_sha + ".json")
    backup_path = STATE / (args.source_sha + ".previous.service")
    receipt = json.loads(receipt_path.read_text())
    if receipt["status"] != "disabled_staged" or receipt["sourceSha"] != args.source_sha or \
            sha256(UNIT) != receipt["newUnitSha256"] or \
            sha256(backup_path) != receipt["previousUnitSha256"]:
        fail("rollback_receipt_mismatch")
    if host_gate(args) != receipt["nginxSha256"]:
        fail("nginx_changed_since_staging")
    write_private(UNIT, backup_path.read_bytes())
    run("systemctl", "daemon-reload")
    if host_gate(args) != receipt["nginxSha256"]:
        fail("rollback_postcondition_failed")
    receipt["status"] = "rolled_back"
    write_private(receipt_path, (json.dumps(receipt, sort_keys=True, indent=2) + "\n").encode())
    print(json.dumps({"sourceSha": args.source_sha, "status": "rolled_back"}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    build = sub.add_parser("package")
    build.add_argument("--source", required=True)
    build.add_argument("--source-sha", required=True)
    build.add_argument("--archive", required=True)
    build.add_argument("--manifest", required=True)
    verify = sub.add_parser("verify")
    verify.add_argument("--archive", required=True)
    verify.add_argument("--manifest", required=True)
    verify.add_argument("--approved-sha256", required=True)
    stage = sub.add_parser("stage")
    stage.add_argument("--archive", required=True)
    stage.add_argument("--manifest", required=True)
    stage.add_argument("--approved-sha256", required=True)
    undo = sub.add_parser("rollback")
    undo.add_argument("--source-sha", required=True)
    for command in (stage, undo):
        command.add_argument("--expected-hostname", required=True)
        command.add_argument("--expected-machine-id-sha256", required=True)
    args = parser.parse_args()
    try:
        if args.command == "package":
            package(args)
        elif args.command == "verify":
            manifest = checked_manifest(args.archive, args.manifest, args.approved_sha256)
            print(json.dumps({"sourceSha": manifest["sourceSha"], "status": "verified"}))
        elif args.command == "stage":
            install(args)
        else:
            rollback(args)
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError, RuntimeError) as error:
        print(f"release_error:{type(error).__name__}:{error if isinstance(error, RuntimeError) else 'operation_failed'}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
