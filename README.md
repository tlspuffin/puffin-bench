# puffin-bench

A performance testbench for the puffin fuzzer

### setup

```sh
nix-shell -p uv
uv run ipython kernel install --name "puffin-bench" --user
git clone https://github.com/tlspuffin/tlspuffin puffin
```

### running benchmark

```sh
uv run benchmark
```