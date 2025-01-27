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
    def __init__(self, bench: Bench) -> None:
        self.bench = bench

    @flow(name="dataset-ttf")
    def generate(self) -> pd.DataFrame:
        data = self.load()

        for vulnerability in self.bench.vulnerabilities():
            for commit in self.bench.commits():
                if not data[
                    (data["run.params.vulnerability"] == vulnerability.vuln_id())
                    & (data["run.params.commit"] == commit)
                ].empty:
                    continue

                results = self._generate_one(commit, vulnerability)
                data = pd.concat([data, results], ignore_index=True)

        # update cache
        self.cache_file().parent.mkdir(parents=True, exist_ok=True)
        data.to_csv(self.cache_file(), index=False)

        return data[data["run.params.commit"].isin(self.bench.commits())]

    def load(self) -> pd.DataFrame:
        if not self.cache_file().exists():
            return pd.DataFrame(columns=["run.params.vulnerability", "run.params.commit"])

        return pd.read_csv(self.cache_file())

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
    def _fuzz(self) -> FuzzerRun:
        # TODO implement `fuzz` task
        return FuzzerRun()

    @task(name="extract-stats")
    def _extract_stats(
        self, commit: str, vulnerability: Vulnerability, run: FuzzerRun
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

    def cache_file(self) -> Path:
        return self.bench._cachedir() / "ttf.csv"


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
