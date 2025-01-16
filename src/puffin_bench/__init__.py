from puffin_bench.bench import Bench, Vulnerability

__all__ = ["Bench", "Vulnerability"]


def main() -> None:
    bench = Bench()
    bench.dataset("ttf").generate()
    bench.render_report()
