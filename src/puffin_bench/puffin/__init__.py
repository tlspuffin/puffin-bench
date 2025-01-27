import json
import os
import shutil
import signal
import subprocess
import time
from collections.abc import Callable, Generator
from contextlib import contextmanager
from dataclasses import dataclass
from importlib import resources
from pathlib import Path
from typing import Protocol

import git
import pandas as pd

import puffin_bench
from puffin_bench.utils import ProcessResult, get_cores, get_free_port

PUFFIN_GIT_URL: str = "https://github.com/tlspuffin/tlspuffin"


class FuzzerProcess:
    def __init__(self, run_dir, port, process) -> None:
        self.run_dir = run_dir
        self.process = process
        self.port = port
        self._start_time = int(time.time())

    def pid(self) -> int:
        return self.process.pid

    def start_time(self) -> int:
        return self._start_time

    def kill(self) -> None:
        for _ in range(5):
            try:
                pg = os.getpgid(self.process.pid)
                os.killpg(pg, signal.SIGINT)
            except ProcessLookupError:
                return

            time.sleep(1)

        pg = os.getpgid(self.process.pid)
        os.killpg(pg, signal.SIGKILL)

    def is_alive(self) -> bool:
        return self.process.poll() is None

    def nb_objectives(self) -> int:
        return sum(1 for _ in (self.run_dir / "objective").glob("*.trace"))


@dataclass
class FuzzerRun(ProcessResult):
    run_dir: Path
    is_success: bool

    def start_time(self) -> pd.Timestamp:
        _, global_events = self.stats()
        return pd.to_datetime(global_events.iloc[0]["time.secs_since_epoch"], unit="s")

    def end_time(self) -> pd.Timestamp:
        _, global_events = self.stats()
        return pd.to_datetime(global_events.iloc[-1]["time.secs_since_epoch"], unit="s")

    def duration(self) -> pd.Timedelta:
        return self.end_time() - self.start_time()

    def stdout(self) -> str:
        stdout_file = self.run_dir / "stdout.log"
        if not stdout_file.exists():
            return ""

        return stdout_file.read_text()

    def stderr(self) -> str:
        stderr_file = self.run_dir / "stderr.log"
        if not stderr_file.exists():
            return ""

        return stderr_file.read_text()

    def stats(self):
        stats_file = self.run_dir / "stats.json"
        if not stats_file.exists():
            return (None, None)

        stats = [
            json.loads(line) for line in stats_file.read_text().replace("}{", "}\n{").splitlines()
        ]

        client_events = pd.json_normalize([s for s in stats if s["type"] == "client"])
        global_events = pd.json_normalize([s for s in stats if s["type"] == "global"])

        client_events.sort_values(by=["time.secs_since_epoch"], ignore_index=True, inplace=True)
        global_events.sort_values(by=["time.secs_since_epoch"], ignore_index=True, inplace=True)

        return (client_events, global_events)


FuzzerTerminationCB = Callable[[FuzzerProcess], bool]


class Fuzzer(Protocol):
    def run(
        self,
        out_dir: Path,
        nb_cores: int,
        seed: bool,
        stop_on: FuzzerTerminationCB,
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
        shutil.rmtree(out_dir, ignore_errors=True)
        out_dir.mkdir(parents=True, exist_ok=True)

        if seed:
            self.seed(out_dir)

            with get_cores(nb_cores) as cores:
                with self.start(run_dir=out_dir, cores=cores) as fuzzer_process:
                    while fuzzer_process.is_alive() and not stop_on(fuzzer_process):
                        time.sleep(1)

                    fuzzer_process.kill()

        return FuzzerRun(is_success=True, run_dir=out_dir)

    def seed(self, out_dir) -> None:
        subprocess.run(
            ["nix-shell", "--run", f"cd {out_dir} && exec {self.binary} seed"],
            cwd=self.puffin.repo,
            check=True,
        )

    @contextmanager
    def start(self, run_dir, cores: list[str], port: int | None = None) -> Generator[FuzzerProcess]:
        args = []

        if port is None:
            port = get_free_port()

        args.append(f"--port={port}")
        args.append(f"--cores={','.join(c for c in cores)}")

        cmd = " ".join([f"{self.binary}", *self.args, *args])

        try:
            with (
                open(run_dir / "stdout.log", "w") as fstdout,
                open(run_dir / "stderr.log", "w") as fstderr,
            ):
                process = FuzzerProcess(
                    run_dir,
                    port,
                    subprocess.Popen(
                        ["nix-shell", "--run", f"cd {run_dir} && exec {cmd}"],
                        cwd=self.puffin.repo,
                        stdout=fstdout,
                        stderr=fstderr,
                        process_group=0,
                    ),
                )

                yield process
        finally:
            process.kill()


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


def objectives_found(nb_found: int) -> FuzzerTerminationCB:
    def _objectives_found(process: FuzzerProcess) -> bool:
        return process.nb_objectives() >= nb_found

    return _objectives_found


def timeout(t: int) -> FuzzerTerminationCB:
    def _timeout(process: FuzzerProcess) -> bool:
        return time.time() - process.start_time() >= t

    return _timeout
