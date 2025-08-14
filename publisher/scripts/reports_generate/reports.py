from __future__ import annotations
import subprocess
from dataset_cache import DatasetCache
from pathlib import Path
import os

def instantiate_template(
    template_name: str, 
    dst: Path, 
    replace: dict[str, str] | None = None,
    templatesdir: Path = Path(__file__).parent / "templates"
) -> None:
  if replace is None:
    replace = {}

  template_path = templatesdir / template_name
  text = template_path.read_text()
  for origin, replacement in replace.items():
    text = text.replace(origin, replacement)

  dst.parent.mkdir(parents=True, exist_ok=True)
  dst.write_text(text)

def render_reports(outdir: Path, cache_csv: Path) -> None:
  cache = DatasetCache(cache_csv)
  all_commits = cache.fetch_all()["run.params.commit"].unique()

  report_dir = outdir / "report"
  report_dir.mkdir(parents=True, exist_ok=True)

  instantiate_template("quarto.yml.in", dst=report_dir / "_quarto.yml")
  instantiate_template("quarto.index.qmd", dst=report_dir / "index.qmd", replace={ "@CSV_PATH@": str(cache_csv.resolve()) })
  instantiate_template("quarto.commits.qmd", dst=report_dir / "commits.qmd")

  for commit in all_commits:
    instantiate_template(
      "quarto.commit.qmd",
      dst=report_dir / "commit" / f"{commit}.qmd",
      replace={
        "@COMMIT_FULL@": commit,
        "@COMMIT_ABBR@": commit[:12],
        "@CSV_PATH@": str(cache_csv.resolve()),
      }
    )

  project_root = Path(__file__).parent.resolve()
  env = os.environ.copy()
  env["PYTHONPATH"] = str(project_root)
  subprocess.run(["quarto", "render", "--execute-daemon-restart"], cwd=report_dir, env=env, check=True)
