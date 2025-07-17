import json
from pathlib import Path
import pandas as pd

_stats_path = Path("outdata/3f648f016c84884d6470fc906735bb8c5da7891b/HEAP/3/stats.json")
raw_lines = _stats_path.read_text().replace("}{", "}\n{").splitlines()
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

print(client_events, global_events)

events_after_found = global_events[global_events["objective_size"] > 0]
print(events_after_found)