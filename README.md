# puffin-bench

A performance testbench for the puffin fuzzer

### setup

```sh
nix-shell -p uv
uv run ipython kernel install --name "puffin-bench" --user
git clone https://github.com/tlspuffin/tlspuffin puffin
```

### setup: running the self-hosted `prefect` server (Docker)

Adapt the `scripts/prefect-server/.env` as necessary.

Starting the server:
```sh
./scripts/prefect-server/start
```

Stopping the server:
```sh
./scripts/prefect-server/stop
```

### running benchmark

```sh
uv run benchmark
```
