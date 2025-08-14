import json
from pathlib import Path
import pandas as pd
from datetime import datetime, timedelta
from typing import Tuple

class FuzzerRun:
  def __init__(self, run_dir: Path, prefix: str = ""):
    self._run_dir = run_dir
    self._stats_path = run_dir / (prefix+"stats.json")

    #run_json_path = run_dir / (prefix+"run.json")
    #if not run_json_path.exists():
    #  raise FileNotFoundError(f"Missing {prefix}run.json in {run_dir}")

    #run_data = json.loads(run_json_path.read_text())
    self._start = None  #datetime.fromtimestamp(run_data["start"] / 1000)
    self._end = None #datetime.fromtimestamp(run_data["end"] / 1000)
    self._run_id = 0 #run_data["id"]

  def start_time(self) -> datetime:
    return self._start

  def end_time(self) -> datetime:
    return self._end

  def duration(self) -> timedelta:
    return self._end - self._start
  
  def id(self) -> str:
    return self._run_id

  def stats(self) -> Tuple[pd.DataFrame, pd.DataFrame]:
    if not self._stats_path.exists():
      return pd.DataFrame(), pd.DataFrame()

    raw_lines = self._stats_path.read_text().replace("}{", "}\n{").splitlines()
    last_line = raw_lines[-1].strip()
    if last_line.count("{") != last_line.count("}"):
        raw_lines = raw_lines[:-1]
    stats = [
      #json.loads(line) for line in self._stats_path.read_text().replace("}{", "}\n{").splitlines()
      json.loads(line) for line in raw_lines
    ]

    client_events = pd.json_normalize([s for s in stats if s["type"] == "client"])
    global_events = pd.json_normalize([s for s in stats if s["type"] == "global"])

    client_events.sort_values(by=["time.secs_since_epoch"], ignore_index=True, inplace=True)
    global_events.sort_values(by=["time.secs_since_epoch"], ignore_index=True, inplace=True)

    ts = pd.to_datetime(
      global_events["time.secs_since_epoch"] * 1_000_000_000 + global_events["time.nanos_since_epoch"],
      unit="ns", utc=True)
    self._start = ts.min()
    self._end = ts.max()

    return (client_events, global_events)
