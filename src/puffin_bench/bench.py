from importlib import resources
from pathlib import Path

import tomllib

import puffin_bench
from puffin_bench.datasets import TTFDataset
from puffin_bench.vulnerability import Vulnerability


class Bench:
    # TODO parameterize Bench with configuration files instead of hardcoding paths to default files

    def render_report(self) -> None:
        import subprocess

        report_dir = self._workdir() / "report"
        self._instantiate_template("quarto.yml.in", dst=report_dir / "_quarto.yml")
        self._instantiate_template("quarto.index.qmd", dst=report_dir / "index.qmd")
        self._instantiate_template("quarto.commits.qmd", dst=report_dir / "commits.qmd")

        for commit in self.commits():
            self._instantiate_template(
                "quarto.commit.qmd",
                dst=report_dir / "commit" / f"{commit}.qmd",
                replace={
                    "@COMMIT_FULL@": commit,
                    "@COMMIT_ABBR@": commit[:12],
                },
            )

        subprocess.run(["quarto", "render", "--execute-daemon-restart"], cwd=report_dir, check=True)

    def commits(self) -> list[str]:
        with open(self._puffin_bench_dir() / "bench.default.toml", "rb") as f:
            return tomllib.load(f)["commits"]

    def vulnerabilities(self) -> list[Vulnerability]:
        with open(self._puffin_bench_dir() / "bench.default.toml", "rb") as f:
            return [
                Vulnerability(vuln_id, name=vuln.get("name", None), cve=vuln.get("cve", None))
                for vuln_id, vuln in tomllib.load(f)["vulnerabilities"].items()
            ]

    def dataset(self, name: str):
        if name == "ttf":
            return TTFDataset(
                cache_file=self._cachedir() / "ttf.csv",
                commits=self.commits(),
                vulnerabilities=self.vulnerabilities(),
            )

        raise ValueError(f"Unknown dataset {name}")

    def _workdir(self) -> Path:
        return self._puffin_bench_dir() / ".puffin-bench"

    def _cachedir(self) -> Path:
        return self._workdir() / "cache"

    def _puffin_bench_dir(self) -> Path:
        return Path(__file__).parent.parent.parent

    def _instantiate_template(
        self, template_name: str, dst: Path, replace: dict[str, str] | None = None
    ) -> None:
        if replace is None:
            replace = {}

        text = resources.files(puffin_bench).joinpath(f"templates/{template_name}").read_text()
        for origin, replacement in replace.items():
            text = text.replace(origin, replacement)

        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_text(text)
