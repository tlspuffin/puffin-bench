from pathlib import Path
from typing import TYPE_CHECKING

import pandas as pd
from prefect import flow, runtime

from puffin_bench.bench import Bench
from puffin_bench.vulnerability import Vulnerability

if TYPE_CHECKING:
    from puffin_bench.puffin import Puffin, Fuzzer


class TTFDataset:
    def __init__(self, bench: Bench) -> None:
        self.bench = bench

    def generate(self):
        data = self.load()

        for vulnerability in self.bench.vulnerabilities():
            for commit in self.bench.commits():
                if not data[
                    (data["run.params.vulnerability"] == vulnerability.vuln_id())
                    & (data["run.params.commit"] == commit)
                ].empty:
                    continue

                results = self._run(commit, vulnerability)
                data = pd.concat([data, results], ignore_index=True)

        # update cache
        self.cache_file().parent.mkdir(parents=True, exist_ok=True)
        data.to_csv(self.cache_file(), index=False)

        return data[data["run.params.commit"].isin(self.bench.commits())]

    def load(self) -> pd.DataFrame:
        if not self.cache_file().exists():
            return pd.DataFrame(columns=["run.params.vulnerability", "run.params.commit"])

        return pd.read_csv(self.cache_file())

    @flow
    def _run(self, commit: str, vulnerability: Vulnerability) -> pd.DataFrame:
        import random
        import uuid

        from prefect import Task

        from puffin_bench import puffin as pf

        # TODO add configuration to clone from GitHub url or local repository
        puffin: Puffin = Task(fn=pf.clone_repo)(
            commit,
            to_path=self.bench._workdir() / str(runtime.flow_run.get_id()),
            src=self.bench._puffin_bench_dir() / "puffin",
        )

        fuzzer: Fuzzer = Task(fn=vulnerability.build)(puffin)

        data = pd.DataFrame(columns=["run.params.vulnerability", "run.params.commit"])

        for _ in range(10):
            dummy_ttf = random.randrange(400, 600)
            run = pd.DataFrame(
                {
                    "run.id": [str(uuid.uuid4())],
                    "run.params.commit": [commit],
                    "run.params.vulnerability": [vulnerability.vuln_id()],
                    "ttf.seconds": [dummy_ttf],
                    "ttf.nb_exec": [random.randrange(dummy_ttf * 200 - 100, dummy_ttf * 200 + 100)],
                    "ttf.corpus_size": [
                        random.randrange(dummy_ttf * 10 - 100, dummy_ttf * 10 + 100)
                    ],
                }
            )

            data = pd.concat([data, run], ignore_index=True)

        return data

    def cache_file(self) -> Path:
        return self.bench._cachedir() / "ttf.csv"
