import argparse
import http.server
import os
import socketserver
from pathlib import Path


class NoCacheHtmlHandler(http.server.SimpleHTTPRequestHandler):
	# Ensure correct MIME for webmanifest and JS
	extensions_map = {
		**http.server.SimpleHTTPRequestHandler.extensions_map,
		".webmanifest": "application/manifest+json",
		".js": "text/javascript; charset=utf-8",
	}

	def end_headers(self):
		if self.path.endswith(".html"):
			self.send_header("Cache-Control", "no-store")
		super().end_headers()


def main() -> int:
	parser = argparse.ArgumentParser(description="Serve WhisperNet web app via Python")
	parser.add_argument("--port", type=int, default=5174)
	args = parser.parse_args()

	root = Path(__file__).resolve().parents[1] / "public"
	os.chdir(str(root))
	handler = NoCacheHtmlHandler
	with socketserver.ThreadingTCPServer(("", args.port), handler) as httpd:
		print(f"Serving WhisperNet at http://localhost:{args.port}")
		print(f"Root: {root}")
		try:
			httpd.serve_forever()
		except KeyboardInterrupt:
			pass
		finally:
			httpd.server_close()
	return 0


if __name__ == "__main__":
	raise SystemExit(main())


