import shutil
from collections.abc import Callable
from importlib import resources
from pathlib import Path
from typing import Protocol

import git

import puffin_bench

PUFFIN_GIT_URL: str = "https://github.com/tlspuffin/tlspuffin"


class FuzzerProcess: ...


class FuzzerRun: ...


class Fuzzer(Protocol):
    def run(
        self,
        out_dir: Path,
        nb_cores: int,
        seed: bool,
        stop_on: Callable[[FuzzerProcess], bool],
    ) -> FuzzerRun: ...


class Puffin:
    def __init__(self, repo: Path) -> None:
        self.repo = repo


class PuffinFuzzer(Fuzzer):
    def __init__(self, puffin: Puffin, binary: Path, args: list[str]) -> None:
        self.puffin = puffin
        self.binary = binary
        self.args = args

    def run(
        self,
        out_dir: Path,
        nb_cores: int,
        seed: bool,
        stop_on: Callable[[FuzzerProcess], bool],
    ) -> FuzzerRun:
        # TODO
        raise NotImplementedError(f"{self.__class__!s}.run() is not yet implemented")


def clone_repo(commit: str, to_path: Path, src: str | Path | None = None) -> Puffin:
    if src is None:
        src = PUFFIN_GIT_URL

    shutil.rmtree(to_path, ignore_errors=True)
    to_path.parent.mkdir(parents=True, exist_ok=True)

    repo = git.Repo.clone_from(src, to_path=to_path)
    repo.git.checkout(commit)
    repo.git.submodule("update", "--init", "--recursive")

    nix_shell = Path(to_path) / "shell.nix"
    if not nix_shell.exists():
        nix_shell.write_text(
            resources.files(puffin_bench).joinpath("resources/legacy/shell.nix").read_text()
        )

    return Puffin(to_path)
