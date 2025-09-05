from pathlib import Path
import pandas as pd
from fuzzer_run import FuzzerRun
from dataset_cache import DatasetCache

def generate(root_path: Path, cache: DatasetCache, commit: str = None):
  results = []
  generated_data = pd.DataFrame()
  if commit:
    commit_dirs = [root_path / commit]
  else:
    commit_dirs = root_path.iterdir()
  for commit_dir in commit_dirs:
    if not commit_dir.is_dir():
      continue
    commit_name = commit_dir.name
    for vuln_dir in commit_dir.iterdir():
      if not vuln_dir.is_dir():
        continue
      vulnerability = vuln_dir.name
      results.append(generate_one(commit_name, vulnerability, vuln_dir))
  if results:
    generated_data = pd.concat(results, ignore_index=True)
    cache.store(generated_data)
  return generated_data

def generate_one(commit: str, vulnerability: str, directory: Path) -> pd.DataFrame:
    runs_data = []
    for attempt_dir in directory.iterdir():
      run = FuzzerRun(attempt_dir)
      stats_df = extract_stats(commit, vulnerability, run)
      runs_data.append(stats_df)

    return pd.concat(runs_data, ignore_index=True)

def extract_stats(
    commit: str, 
    vulnerability: str, 
    run: FuzzerRun,
) -> pd.DataFrame:
    run_data = pd.DataFrame({
        "run.id": [run.id()],
        "run.params.commit": [commit],
        "run.params.vulnerability": [vulnerability],
        "run.start_time": [run.start_time()],
        "run.end_time": [run.end_time()],
        "run.timed_out": [run.duration().total_seconds() >= 24 * 3600],
    })

    client_events, global_events = run.stats()
    events_after_found = global_events[global_events["objective_size"] > 0]

    if events_after_found.empty:
        run_data["ttf.seconds"] = [pd.NA]
        run_data["ttf.nb_exec"] = [pd.NA]
        run_data["ttf.corpus_size"] = [pd.NA]
    else:
        run_start_event = global_events.iloc[0]
        run_found_event = events_after_found.iloc[0]

        start_time = run_start_event["time.secs_since_epoch"]
        found_time = run_found_event["time.secs_since_epoch"]

        run_data["ttf.seconds"] = [found_time - start_time]
        run_data["ttf.nb_exec"] = [run_found_event["total_execs"]]
        run_data["ttf.corpus_size"] = [run_found_event["corpus_size"]]

    return run_data
