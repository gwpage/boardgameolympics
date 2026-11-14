"""tests/server.py: static file server for the headless test runner (ADR-001).

Python standard library only. tests/run.sh starts it; you don't need to run it
yourself. For manual runs in a normal browser, `python3 -m http.server` is enough.

What it does beyond `python3 -m http.server`:
  * POST /__test-report__ : the test page (opened as /tests/?report) posts its
    JSON results here, and they are written to --report-file for run.sh.
  * Writes the port it is listening on to --port-file. That doubles as the
    "server is ready" signal, and lets the OS pick a free port (--port 0).
  * Sends Cache-Control: no-store, so a stale cached module can never hide
    the change under test.

Why results are POSTed instead of read with Chrome's --dump-dom: --dump-dom
only waits for async tests when combined with --virtual-time-budget, and
virtual time fast-forwards timers while work runs off the main thread (for
example image decoding). Tests then "time out" at random. Posting the report
lets the run use real time.
"""

import argparse
import functools
import http.server
import os
import sys

REPORT_PATH = "/__test-report__"
# A full report is a few hundred KB at most; anything bigger is a bug or abuse.
MAX_REPORT_BYTES = 5 * 1024 * 1024
HTTP_NO_CONTENT = 204
HTTP_NOT_FOUND = 404
HTTP_LENGTH_REQUIRED = 411
HTTP_PAYLOAD_TOO_LARGE = 413


class TestServerHandler(http.server.SimpleHTTPRequestHandler):
    """Serves files from the repo root and accepts the test report POST."""

    def __init__(self, *args, report_file, **kwargs):
        self.report_file = report_file
        super().__init__(*args, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_POST(self):
        if self.path != REPORT_PATH:
            self.send_error(HTTP_NOT_FOUND)
            return
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            self.send_error(HTTP_LENGTH_REQUIRED)
            return
        if length < 0 or length > MAX_REPORT_BYTES:
            self.send_error(HTTP_PAYLOAD_TOO_LARGE)
            return

        body = self.rfile.read(length)
        # Write then rename, so run.sh never reads a half-written report.
        partial = self.report_file + ".partial"
        with open(partial, "wb") as report:
            report.write(body)
        os.replace(partial, self.report_file)

        self.send_response(HTTP_NO_CONTENT)
        self.end_headers()


def parse_args(argv):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--directory", required=True, help="directory to serve (the repo root)")
    parser.add_argument("--bind", default="127.0.0.1", help="address to listen on (default: localhost only)")
    parser.add_argument("--port", type=int, default=0, help="port to listen on; 0 lets the OS choose")
    parser.add_argument("--port-file", required=True, help="file to write the chosen port to once listening")
    parser.add_argument("--report-file", required=True, help="file to write the posted test report to")
    return parser.parse_args(argv)


def main(argv):
    args = parse_args(argv)
    handler = functools.partial(
        TestServerHandler,
        directory=os.path.abspath(args.directory),
        report_file=os.path.abspath(args.report_file),
    )
    # The constructor binds and listens, so connections made from here on queue up
    # until serve_forever() starts handling them. It's safe to announce the port now.
    with http.server.ThreadingHTTPServer((args.bind, args.port), handler) as server:
        port = server.server_address[1]
        partial = args.port_file + ".partial"
        with open(partial, "w", encoding="utf-8") as port_file:
            port_file.write(str(port))
        os.replace(partial, args.port_file)  # atomic: run.sh never sees an empty file
        server.serve_forever()


if __name__ == "__main__":
    main(sys.argv[1:])
