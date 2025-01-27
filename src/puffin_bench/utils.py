import json
import os
import time
from collections.abc import Generator
from contextlib import contextmanager
from pathlib import Path
from typing import Protocol

import psutil
from filelock import FileLock

CORES_FILE = Path("/tmp/puffin-fuzzer.cores")
CORES_LOCK = FileLock(CORES_FILE.with_suffix(CORES_FILE.suffix + ".lock"))


class Cores:
    def __init__(self, cores: dict[str, int], max_cores: int) -> None:
        self.cores = cores
        self.max_cores = max_cores

    def get(self, nb_cores: int = 1) -> list[str] | None:
        """
        Attempt to reserve some cores for fuzzing.

        Parameters
        ----------
        nb_cores: int, default 1
            The number of cores that should be reserved.

        Returns
        -------
        list[int] or None
            If enough cores are available, returns the list of ids for the
            reserved cores, otherwise returns None.
        """
        if nb_cores < 0 or len(self.free()) < nb_cores:
            return None

        reserved_cores = self.free()[:nb_cores]
        for core in reserved_cores:
            self.cores[core] = os.getpid()

        return reserved_cores

    def release(self, cores: list[str]) -> None:
        """
        Release the given cores, making them available for successive calls to `get`.
        """
        for i in cores:
            if i in self.cores:
                del self.cores[i]

    def busy(self) -> dict[str, int]:
        """
        Return the busy cores as a dictionary of core_id -> process_id.
        """
        return {i: pid for i, pid in self.cores.items() if psutil.pid_exists(pid)}

    def free(self) -> list[str]:
        """
        Return the list of free cores.
        """
        return [str(i) for i in range(self.max_cores) if str(i) not in self.busy()]


@contextmanager
def fuzzing_cores() -> Generator[Cores]:
    with CORES_LOCK:
        try:
            cores_json = CORES_FILE.read_text()
        except FileNotFoundError:
            cores_json = "{}"

        cores = Cores(json.loads(cores_json), max_cores=40)

        yield cores

        CORES_FILE.write_text(json.dumps(cores.busy()))


@contextmanager
def get_cores(nb_cores: int = 1) -> Generator[list[str]]:
    # reserver the requested number of cores
    while True:
        with fuzzing_cores() as cores:
            reserved_cores = cores.get(nb_cores)
            if reserved_cores is not None:
                break

            # Not enough cores are available. Sleep for a bit before retry.
            time.sleep(5)
            continue

    yield reserved_cores

    # make the cores available for other processes
    with fuzzing_cores() as cores:
        cores.release(reserved_cores)


def get_free_port() -> int:
    import contextlib
    import socket

    with contextlib.closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as s:
        s.bind(("", 0))
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        return s.getsockname()[1]


class ProcessResult(Protocol):
    is_success: bool

    def stdout(self) -> str: ...

    def stderr(self) -> str: ...
