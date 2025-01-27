from itertools import product
from pathlib import Path
from typing import TYPE_CHECKING, Final

import pandas as pd
from prefect import flow, runtime, task
from prefect.artifacts import create_markdown_artifact

from puffin_bench.bench import Bench
from puffin_bench.puffin import Fuzzer, FuzzerRun
from puffin_bench.utils import ProcessResult
from puffin_bench.vulnerability import BuildResult, Vulnerability

if TYPE_CHECKING:
    from puffin_bench.puffin import Puffin


class TTFDataset:
    name: Final[str] = "ttf"
    params: Final[list[str]] = ["commit", "vulnerability"]

    @classmethod
    def columns(cls) -> list[str]:
        return [
            "run.id",
            *[f"run.params.{p}" for p in cls.params],
            "run.start_time",
            "run.end_time",
            "ttf.seconds",
            "ttf.nb_exec",
            "ttf.corpus_size",
        ]

    def __init__(self, bench: Bench) -> None:
        self.bench = bench
        self.cache = DatasetCache(self.bench, self.__class__)

    @flow(name="dataset-ttf")
    def generate(self) -> pd.DataFrame:
        results = []
        for commit, vulnerability in product(self.bench.commits(), self.bench.vulnerabilities()):
            if not self.cache.lookup(commit=commit, vulnerability=vulnerability).empty:
                continue

            results.append(self._generate_one.submit(commit, vulnerability))

        if results:
            generated_data = pd.concat([r.result() for r in results], ignore_index=True)

            # update cache
            self.cache.store(generated_data)

        return self.cache.lookup(
            commit=self.bench.commits(), vulnerability=self.bench.vulnerabilities()
        )

    def load(self) -> pd.DataFrame:
        return self.cache.fetch_all()

    @task(name="ttf", task_run_name="{commit}-{vulnerability._vuln_id}")
    def _generate_one(self, commit: str, vulnerability: Vulnerability) -> pd.DataFrame:
        fuzzer: Fuzzer = self._build(commit, vulnerability)

        runs_data = [
            self._extract_stats.submit(
                commit, vulnerability, self._fuzz.submit(commit, vulnerability, fuzzer)
            )
            for _ in range(10)
        ]

        return pd.concat([d.result() for d in runs_data], ignore_index=True)

    @task(name="build")
    def _build(self, commit: str, vulnerability: Vulnerability) -> Fuzzer:
        from prefect import Task

        from puffin_bench import puffin as pf

        workdir = (self.bench._workdir() / commit / str(vulnerability)).absolute()
        bld_dir = workdir / "build"
        git_dir = bld_dir / "repo"

        # TODO add configuration to clone from GitHub url or local repository
        puffin: Puffin = pf.clone_repo(
            commit,
            to_path=git_dir,
            src=self.bench._puffin_bench_dir() / "puffin",
        )

        build_result: BuildResult = Task(fn=vulnerability.build)(puffin, out_dir=bld_dir)
        create_artifact(build_result, key=str.lower(f"{commit}-{vulnerability!s}-build"))

        if not build_result.is_success:
            raise RuntimeError(f"build step failed for {vulnerability!s} at commit {commit[:12]!s}")

        return build_result.fuzzer

    @task(name="fuzz")
    def _fuzz(
        self,
        commit: str,
        vulnerability: Vulnerability,
        fuzzer: Fuzzer,
    ) -> FuzzerRun:
        # TODO implement `fuzz` task
        return FuzzerRun()

    @task(name="extract-stats")
    def _extract_stats(
        self,
        commit: str,
        vulnerability: Vulnerability,
        run: FuzzerRun,
    ) -> pd.DataFrame:
        # TODO implement `extract_stats` task
        import random

        dummy_ttf = random.randrange(400, 600)
        dummy_start_time = pd.Timestamp.now()
        dummy_end_time = dummy_start_time + pd.Timedelta(seconds=dummy_ttf)
        return pd.DataFrame(
            {
                "run.id": [str(runtime.task_run.get_id())],
                "run.params.commit": [commit],
                "run.params.vulnerability": [vulnerability.vuln_id()],
                "run.start_time": [dummy_start_time],
                "run.end_time": [dummy_end_time],
                "ttf.seconds": [dummy_ttf],
                "ttf.nb_exec": [random.randrange(dummy_ttf * 200 - 100, dummy_ttf * 200 + 100)],
                "ttf.corpus_size": [random.randrange(dummy_ttf * 10 - 100, dummy_ttf * 10 + 100)],
            }
        )

    @classmethod
    def empty_dataframe(cls) -> pd.DataFrame:
        return pd.DataFrame({c: [] for c in cls.columns()})


MD_CMD_REPORT: Final[str] = """
<details><summary>stdout</summary>{stdout}</details>
<details><summary>stderr</summary>{stderr}</details>
"""


def create_artifact(r: ProcessResult, key: str | None = None) -> None:
    create_markdown_artifact(
        key=key,
        markdown=MD_CMD_REPORT.format(
            stdout=r.stdout().replace("\n\n", "\n"),
            stderr=r.stderr().replace("\n\n", "\n"),
        ),
    )


class DatasetCache:
    def __init__(self, bench: Bench, dataset: type[TTFDataset]) -> None:
        self.bench = bench
        self.dataset = dataset

    def fetch_all(self) -> pd.DataFrame:
        if not self.cache_file().exists():
            return self.dataset.empty_dataframe()

        return pd.read_csv(self.cache_file())

    def lookup(self, **kwargs) -> pd.DataFrame:
        def lookup_operator(p):
            if isinstance(p, list):
                return "in"
            else:
                return "=="

        return self.fetch_all().query(
            " & ".join(
                [
                    f"(`run.params.{p}` {lookup_operator(p)} {kwargs[p]!r})"
                    for p in self.dataset.params
                    if p in kwargs
                ]
            )
        )

    def store(self, data: pd.DataFrame) -> None:
        # concat new data to existing cached entries
        cached = self.fetch_all()
        cached = pd.concat([data, cached], ignore_index=True)

        # save to disk
        self.cache_file().parent.mkdir(parents=True, exist_ok=True)
        cached.to_csv(self.cache_file(), index=False)

    def cache_file(self) -> Path:
        return self.bench._cachedir() / f"{self.dataset.name}.csv"
