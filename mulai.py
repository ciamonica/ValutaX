"""Jalankan ValutaX lokal tanpa memasang library Python tambahan."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import hashlib
import json
import urllib.request
import webbrowser

if __name__ == "__main__":
    folder = Path(__file__).resolve().parent
    identity = hashlib.sha256(str(folder).encode()).hexdigest()
    url = "http://localhost:8000/"

    class ValutaXHandler(SimpleHTTPRequestHandler):
        def do_GET(self):
            if self.path == "/__valutax_status__":
                body = json.dumps({"app": "ValutaX", "folderId": identity}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)
                return
            super().do_GET()

    try:
        server = ThreadingHTTPServer(("127.0.0.1", 8000), partial(ValutaXHandler, directory=str(folder)))
    except OSError:
        try:
            with urllib.request.urlopen(url + "__valutax_status__", timeout=1) as response:
                status = json.load(response)
            if status == {"app": "ValutaX", "folderId": identity}:
                print("ValutaX dari folder ini sudah berjalan. Membuka halaman yang sama.", flush=True)
                webbrowser.open(url)
                raise SystemExit(0)
        except (OSError, ValueError):
            pass
        raise SystemExit("Port 8000 dipakai server lain. Tutup server tersebut sebelum menjalankan ValutaX. Port dipertahankan agar sesi/riwayat browser tidak berpindah alamat.")
    print(f"ValutaX berjalan di {url}\nBiarkan jendela ini terbuka. Tekan Ctrl+C untuk berhenti.", flush=True)
    webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
