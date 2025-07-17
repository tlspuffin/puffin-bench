from pathlib import Path

import pandas as pd
import plotly.express as px
import plotly.io as pio
import plotly.graph_objects as go

from dataset_cache import DatasetCache

cache = DatasetCache(Path("data.csv"))

ttf_data = cache.fetch_all()

commit_order = (
    ttf_data["run.params.commit"]
    .drop_duplicates()
    .sort_values()
    .tolist()
)

ttf_data = ttf_data.groupby(["run.params.commit", "run.params.vulnerability"]).agg(
    {
        "ttf.seconds": ["mean"],
        "ttf.nb_exec": ["mean"],
        "ttf.corpus_size": ["mean"],
    }
)

ttf_data.columns = [".".join(col) for col in ttf_data.columns]

ttf_data = ttf_data.sort_values(
    by=["run.params.commit"], key=lambda c: c.map(commit_order.index)
).reset_index()

def lineplot(y) -> None:
  labels = {
    "run.params.commit": "commit",
    "run.params.vulnerability": "vulnerability",
    "ttf.seconds.mean": "mean TTF (seconds)",
    "ttf.nb_exec.mean": "mean TTF (nb executions)",
    "ttf.corpus_size.mean": "mean TTF (corpus size)",
  }

  fig = px.line(
    ttf_data,
    x="run.params.commit",
    y=y,
    color="run.params.vulnerability",
    markers=True,
  )

  fig.update_yaxes(title="Time to Find (in seconds)")
  fig.update_xaxes(title=None, showticklabels=False)
  #fig.show()
  fig.write_html(y+".html")
  print(y+".html")

lineplot("ttf.seconds.mean")
lineplot("ttf.nb_exec.mean")
lineplot("ttf.corpus_size.mean")


commit="3f648f016c84884d6470fc906735bb8c5da7891b"
cache = DatasetCache(Path("data.csv"))
ttf_data = cache.fetch_all()
ttf_commit_data = ttf_data[ttf_data["run.params.commit"] == commit]
vulnerabilities = sorted(ttf_commit_data["run.params.vulnerability"].unique())

def boxplots(y) -> None:
  labels = {
    "run.params.commit": "commit",
    "run.params.vulnerability": "vulnerability",
    "ttf.seconds": "seconds)",
    "ttf.nb_exec": "number of executions)",
    "ttf.corpus_size": "corpus size",
  }

  fig = px.box(
    ttf_commit_data,
    x="run.params.commit",
    y=y,
    points="all",
    facet_col="run.params.vulnerability",
    facet_col_wrap=1,
    facet_row_spacing=0.01,
    height=600 * len(vulnerabilities),
    labels=labels,
    boxmode="overlay",
  )
  fig.update_yaxes(title=None, visible=True, showticklabels=True)
  fig.update_xaxes(title=None, visible=False, showticklabels=False)
  #fig.show()
  fig.write_html(y+"-box.html")
  print(y+"-box.html")

boxplots("ttf.seconds")
boxplots("ttf.nb_exec")
boxplots("ttf.corpus_size")