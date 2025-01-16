from pathlib import Path

import pandas as pd

from puffin_bench.vulnerability import Vulnerability


class TTFDataset:
    def __init__(
        self,
        cache_file: Path,
        commits: list[str],
        vulnerabilities: list[Vulnerability],
    ) -> None:
        self.cache_file = cache_file
        self.commits = commits
        self.vulnerabilities = vulnerabilities

    def generate(self):
        data = self.load()

        for vulnerability in self.vulnerabilities:
            for commit in self.commits:
                if not data[
                    (data["run.params.vulnerability"] == vulnerability.vuln_id())
                    & (data["run.params.commit"] == commit)
                ].empty:
                    continue

                for _ in range(8):
                    run = self._run(commit, vulnerability)
                    data = pd.concat([data, run.to_frame().T], ignore_index=True)

        # update cache
        self.cache_file.parent.mkdir(parents=True, exist_ok=True)
        data.to_csv(self.cache_file, index=False)

        return data[data["run.params.commit"].isin(self.commits)]

    def load(self) -> pd.DataFrame:
        if not self.cache_file.exists():
            return pd.DataFrame(columns=["run.params.vulnerability", "run.params.commit"])

        return pd.read_csv(self.cache_file)

    def _run(self, commit: str, vulnerability: Vulnerability) -> pd.Series:
        import random
        import uuid

        dummy_ttf = random.randrange(400, 600)
        return pd.Series(
            {
                "run.id": uuid.uuid4(),
                "run.params.commit": commit,
                "run.params.vulnerability": vulnerability.vuln_id(),
                "ttf.seconds": dummy_ttf,
                "ttf.nb_exec": random.randrange(dummy_ttf * 200 - 100, dummy_ttf * 200 + 100),
                "ttf.corpus_size": random.randrange(dummy_ttf * 10 - 100, dummy_ttf * 10 + 100),
            }
        )
