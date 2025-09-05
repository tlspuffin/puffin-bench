import pandas as pd
from pathlib import Path

class DatasetCache:
  def __init__(self, cache_file: Path) -> None:
    self._cache_file = cache_file
    self._params = ["commit", "vulnerability"]

  def empty_dataframe(self) -> pd.DataFrame:
    return pd.DataFrame(columns=[
      "run.id",
      "run.params.commit",
      "run.params.vulnerability",
      "run.start_time",
      "run.end_time",
      "run.timed_out",
      "ttf.seconds",
      "ttf.nb_exec",
      "ttf.corpus_size"
    ])

  def fetch_all(self) -> pd.DataFrame:
    if not self.cache_file().exists():
      return self.empty_dataframe()

    return pd.read_csv(self.cache_file())

  def store(self, data: pd.DataFrame) -> None:
    cached = self.fetch_all()
    cached = pd.concat([data, cached], ignore_index=True)

    self.cache_file().parent.mkdir(parents=True, exist_ok=True)
    cached.to_csv(self.cache_file(), index=False)

  def cache_file(self) -> Path:
    return self._cache_file
