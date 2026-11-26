#!/usr/bin/env python3
"""Build a local exporter image from an authorized release directory or .tar.gz."""

import argparse
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[2]
PREFIX = {"bitbucket": "bbs", "gitlab": "gl"}


def stage_release(source, context, prefix):
    gemspec = f"{prefix}_exporter.gemspec"
    files = {"Gemfile", "Gemfile.lock", gemspec, "LICENSE"}
    trees = ("exe", "lib")

    if source.is_dir():
        for name in files | set(trees):
            path = source / name
            if path.is_symlink():
                raise ValueError(f"linked build input: {name}")
            if name in trees:
                shutil.copytree(path, context / name, symlinks=True)
            else:
                shutil.copyfile(path, context / name)
        if any(p.is_symlink() for p in context.rglob("*")):
            raise ValueError("linked files are not supported in the build inputs")
    else:
        with tarfile.open(source, "r:gz") as archive:
            members = [(PurePosixPath(m.name), m) for m in archive.getmembers()]
            roots = [p.parent for p, m in members if p.name == gemspec and m.isfile()]
            if len(roots) != 1 or len(roots[0].parts) > 1:
                raise ValueError(f"expected one {gemspec} at the root or in one release folder")
            for path, member in members:
                if path.is_absolute() or ".." in path.parts:
                    raise ValueError("archive contains a path outside its release directory")
                if not path.is_relative_to(roots[0]):
                    continue
                rel = path.relative_to(roots[0])
                if not rel.parts or (rel.as_posix() not in files and rel.parts[0] not in trees):
                    continue
                if member.isdir():
                    continue
                if not member.isfile():
                    raise ValueError(f"expected a regular file: {rel}")
                target = context / rel
                target.parent.mkdir(exist_ok=True, parents=True)
                with archive.extractfile(member) as src, target.open("xb") as dst:
                    shutil.copyfileobj(src, dst)
                target.chmod(0o755 if member.mode & 0o111 else 0o644)
    for name in files | set(trees):
        path = context / name
        if not (path.is_dir() if name in trees else path.is_file()):
            raise ValueError(f"missing release input: {name}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("provider", choices=PREFIX)
    parser.add_argument("source", type=Path, help="local release directory or .tar.gz")
    args = parser.parse_args()
    prefix = PREFIX[args.provider]
    service = f"{args.provider}-exporter"
    with tempfile.TemporaryDirectory(prefix="exporter-build-") as tmp:
        context = Path(tmp) / "release"
        context.mkdir()
        stage_release(args.source.expanduser(), context, prefix)
        # The base Compose file references .env; never load the deployment's credentials.
        (Path(tmp) / ".env").touch()
        command = [
            os.environ.get("EXPORTER_RUNTIME", "docker"), "compose",
            "--project-directory", tmp, "--env-file", os.devnull,
            "-f", str(ROOT / "docker-compose.yml"),
            "-f", str(ROOT / "deploy" / args.provider / f"compose.{service}.yml"),
            "build", service,
        ]
        env = {**os.environ, "PWD": str(ROOT), f"{prefix.upper()}_EXPORTER_BUILD_CONTEXT": str(context)}
        subprocess.run(command, cwd=ROOT, env=env, check=True)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, tarfile.TarError) as error:
        sys.exit(f"exporter build: {error}")
    except subprocess.CalledProcessError as error:
        sys.exit(error.returncode or 1)
