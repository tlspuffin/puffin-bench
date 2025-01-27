import http.server
import socketserver
from pathlib import Path

from puffin_bench.bench import Bench, Vulnerability
from puffin_bench.utils import get_free_port

__all__ = ["Bench", "Vulnerability"]


def main() -> None:
    bench = Bench()
    bench.dataset("ttf").generate()
    bench.render_report()

    # start a web server to display the report
    start_webserver(port=get_free_port(), dir=bench._workdir() / "report" / "output")


def start_webserver(port: int, dir: Path):
    def request_handler(directory=None):
        class _RequestHandler(http.server.SimpleHTTPRequestHandler):
            def __init__(self, *args, **kwargs) -> None:
                super().__init__(*args, directory=directory, **kwargs)

        return _RequestHandler

    with socketserver.TCPServer(("", port), request_handler(directory=dir)) as httpd:
        print(f"benchmark report is visible at http://localhost:{port}")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("keyboard interrupt received, exiting...")
