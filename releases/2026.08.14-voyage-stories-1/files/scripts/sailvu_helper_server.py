"""
SAILVu local helper server.

Why this exists
----------------
The app (index.html) is a plain file:// page with no build step and no
server -- by design (see HANDOFF.md). But a browser page can NEVER launch
an external program on its own; that is a hard browser security boundary,
not a SAILVu limitation. The in-page "Refresh data" button used to only
re-load the data/*.js files the pipeline had *already* written on disk --
it could not trigger the pipeline itself. Getting fresh data meant a
two-step manual dance: double-click run_pipeline.bat, wait, THEN click
"Refresh data" in the app.

This script adds the smallest possible bridge: a plain-stdlib HTTP server
that listens on 127.0.0.1 only (never reachable from the network) and
exposes two endpoints the page can call with fetch():

  GET  /health         -> {"status": "ok"}   used to detect the helper is
                          running at all, before trying to run anything.
  POST /run-pipeline    -> runs fetch_model_data.py synchronously, in this
                          same folder, and returns its result as JSON.
                          Optional JSON body {"windHourly": true} passes
                          --wind-hourly through to the subprocess (see
                          fetch_model_data.py's parse_args()) -- 2026-08-04,
                          the owner's "let the user opt into the dense
                          wind fetch, with a warning" request.
  GET  /progress        -> reads fetch_model_data.py's own
                          PIPELINE_PROGRESS_FILE (a small JSON file the
                          pipeline writes to as it runs) and returns it
                          verbatim. 2026-08-04, added alongside
                          --wind-hourly above: /run-pipeline is still one
                          blocking call with no progress of its own (see
                          run_pipeline() below) -- this is a SEPARATE
                          endpoint the page polls WHILE that call is in
                          flight, reading the pipeline's own progress
                          file rather than this server tracking progress
                          itself (the pipeline runs as a child
                          subprocess, not in this server's process, so
                          this server has no visibility into it beyond
                          that shared file). Returns {"stage": "idle"} if
                          the file doesn't exist yet (e.g. pipeline never
                          run this session).
  POST /check-marine-statement -> 2026-08-06, later session, owner's
                          request: a fast, single-page live check of the
                          real EC "Marine Weather Statement" text
                          (fetch_marine_weather_statement() in
                          fetch_model_data.py, imported and called
                          in-process here -- NOT a subprocess like
                          /run-pipeline, since this is one HTTP GET, not
                          the whole multi-track pipeline) so the page can
                          flag its on-disk data/marine_weather_statement.js
                          snapshot as stale without the owner having to
                          run the full "Refresh data" pipeline just to
                          check. Returns fetch_marine_weather_statement()'s
                          own {ok, issued, text, url} (or {ok: False,
                          error, url}) verbatim -- no file written, this
                          never touches data/marine_weather_statement.js on
                          disk, purely a read-only check.

Start this with start_sailvu.bat (which starts this server AND opens
index.html) -- not by double-clicking this .py file directly, and not by
running it with pythonw with no console, since the console window is the
only "is this still running" indicator a non-developer has.

CORS note: index.html is loaded via file://, so the browser sends
"Origin: null" on its fetch() calls. This server answers every response
(including the OPTIONS preflight) with "Access-Control-Allow-Origin: *" so
that request is allowed. This is safe here because the server binds to
127.0.0.1 only -- nothing outside this machine can reach it -- and it
exposes only two fixed actions (re-run the pipeline script already sitting
next to it, or re-fetch one specific hardcoded EC page -- see
/check-marine-statement above, added 2026-08-06 -- neither accepts an
arbitrary URL/command from the caller), not an open command channel.

Future note (per 2026-08-02 conversation with the owner): his son's boat
already runs a Raspberry Pi server/network for OpenCPN, AIS, and vessel
monitoring. SAILVu is being kept as a separate app for now, with an
eventual merge anticipated -- if/when that happens, this helper server is
the piece that would need to move from "listen on 127.0.0.1 only" to
"listen on the boat's own network", which is a real security posture
change (see the CORS note above) and should be revisited deliberately then,
not assumed safe by default.
"""

import csv
import io
import json
import os
import subprocess
import threading
import sys
import time
import uuid
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOST = "127.0.0.1"
PORT = 8765  # must match HELPER_BASE in app.js
HELPER_API_VERSION = 8  # v8: automatic voyage-report archives

SCRIPT_DIR = Path(__file__).parent.resolve()
PIPELINE_SCRIPT = SCRIPT_DIR / "fetch_model_data.py"

# 2026-08-06, later session: /check-marine-statement imports this directly
# (in-process, not a subprocess like run_pipeline() below -- this is one
# fast HTTP GET, not a multi-minute multi-track pipeline run) rather than
# shelling out. sys.path insert needed since this server can be started
# from a different cwd than SCRIPT_DIR (see start_sailvu.bat) -- without
# it, a plain `import fetch_model_data` would fail depending on how this
# script was launched.
sys.path.insert(0, str(SCRIPT_DIR))
from fetch_model_data import fetch_marine_weather_statement  # noqa: E402
from sailvu_updates import APP_ROOT, channel_status, check_update, create_feedback_bundle, feedback_file, install_update, rollback_update, stage_local_update  # noqa: E402
# Must match PIPELINE_PROGRESS_FILE in fetch_model_data.py exactly -- this
# server only ever READS this file (the pipeline subprocess is the sole
# writer), so there's deliberately no shared import between the two, just
# the same relative path computed the same way (both files live directly
# in SCRIPT_DIR).
PIPELINE_PROGRESS_FILE = SCRIPT_DIR / "cache" / "pipeline_progress.json"
HELPER_LOCK_FILE = SCRIPT_DIR / "cache" / "sailvu_helper.lock"
REPORTS_DIR = APP_ROOT.parent / "SAILVu Reports"


def archive_voyage_report(payload):
    """Atomically replace one day's self-contained captain/reporting ZIP."""
    day = str(payload.get("day", ""))
    if len(day) != 10 or day[4] != "-" or day[7] != "-" or not day.replace("-", "").isdigit():
        raise ValueError("day must be YYYY-MM-DD")
    records = payload.get("records")
    if not isinstance(records, list) or len(records) > 10000:
        raise ValueError("records must be a list of at most 10,000 items")
    diagnostics = payload.get("diagnostics") if isinstance(payload.get("diagnostics"), dict) else {}
    fields = ["voyageId", "samplingMode", "time", "receivedAt", "source", "lat", "lon", "sog", "cog", "headingMagnetic", "stw", "apparentWindSpeed", "apparentWindAngle", "depthBelowTransducer", "waterTemperatureC"]
    csv_buffer = io.StringIO(newline="")
    writer = csv.DictWriter(csv_buffer, fieldnames=fields, extrasaction="ignore", lineterminator="\r\n")
    writer.writeheader()
    writer.writerows(record for record in records if isinstance(record, dict))
    points = [record for record in records if isinstance(record, dict) and isinstance(record.get("lat"), (int, float)) and isinstance(record.get("lon"), (int, float))]
    geojson = {"type": "FeatureCollection", "features": [
        {"type": "Feature", "properties": {"name": f"SAILVu vessel track {day}", "records": len(points)}, "geometry": {"type": "LineString", "coordinates": [[p["lon"], p["lat"]] for p in points]}},
        *[{"type": "Feature", "properties": {k: v for k, v in p.items() if k not in {"lat", "lon"}}, "geometry": {"type": "Point", "coordinates": [p["lon"], p["lat"]]}} for p in points],
    ]}
    report = {"schema": "sailvu.daily-report.v1", "day": day, "archivedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "recordCount": len(records), "firstRecordTime": records[0].get("time") if records and isinstance(records[0], dict) else None, "lastRecordTime": records[-1].get("time") if records and isinstance(records[-1], dict) else None, "diagnostics": diagnostics}
    backup = {"schema": "sailvu.voyage-log.v1", "exportedAt": report["archivedAt"], "dayKey": f"sailvu.vessel.track.{day}", "records": records}
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    target = REPORTS_DIR / f"{day}-SAILVu-daily-report.zip"
    temporary = REPORTS_DIR / f".{target.name}.{uuid.uuid4().hex}.tmp"
    try:
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr(f"{day}-summary.json", json.dumps(report, indent=2))
            archive.writestr(f"{day}-voyage-backup.json", json.dumps(backup, indent=2))
            archive.writestr(f"{day}-voyage-log.csv", csv_buffer.getvalue())
            archive.writestr(f"{day}-track.geojson", json.dumps(geojson, indent=2))
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)
    return {"success": True, "filename": target.name, "folder": str(REPORTS_DIR), "records": len(records), "bytes": target.stat().st_size}


def acquire_single_instance_lock():
    """Keep the lock handle open for this process's lifetime.

    ThreadingHTTPServer enables address reuse on some Windows/Python builds,
    so binding port 8765 alone did not prevent several helpers from sharing
    it. A locked byte is an explicit single-instance guarantee.
    """
    HELPER_LOCK_FILE.parent.mkdir(parents=True, exist_ok=True)
    handle = open(HELPER_LOCK_FILE, "a+b")
    handle.seek(0)
    if os.name == "nt":
        import msvcrt
        try:
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            handle.close()
            return None
    else:
        import fcntl
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            handle.close()
            return None
    return handle

# Pipeline hits live network endpoints (SalishSeaCast ERDDAP, CHS IWLS,
# MSC Datamart) -- give it a generous ceiling rather than guessing a tight
# one, but don't hang forever if a server stops responding entirely.
# 2026-08-04: NOT bumped for the new --wind-hourly option even though that
# option is genuinely slower (up to ~48 individual Datamart downloads
# instead of ~24) -- 600s was already a "generous ceiling, not a real
# expectation" figure before this, and the owner hasn't hit it in practice
# yet. Revisit if a real --wind-hourly run times out.
PIPELINE_TIMEOUT_S = 600
PIPELINE_PROCESS = None
PIPELINE_PROCESS_LOCK = threading.Lock()


def run_pipeline(wind_hourly=False, cellular=False, marine_zones=None, download_plan=None):
    """Runs fetch_model_data.py as a subprocess (not an in-process import --
    keeps this server's own process state untouched between runs, and
    matches exactly what a double-clicked run_pipeline.bat does, PLUS the
    optional --wind-hourly flag run_pipeline.bat's plain invocation
    doesn't pass -- see this function's caller in do_POST() for where that
    comes from). Returns a dict ready to json.dumps() straight into the
    HTTP response."""
    started = time.time()
    cmd = [sys.executable, str(PIPELINE_SCRIPT)]
    if cellular:
        cmd.append("--cellular")
        for zone in marine_zones or []:
            cmd.extend(["--marine-zone", str(zone)])
    elif download_plan and download_plan.get("mode") in {"navigation", "voyage", "full"}:
        cmd.extend(["--regional-plan", json.dumps(download_plan, separators=(",", ":"))])
    elif wind_hourly:
        cmd.append("--wind-hourly")
    global PIPELINE_PROCESS
    try:
        proc = subprocess.Popen(
            cmd,
            cwd=str(SCRIPT_DIR),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        with PIPELINE_PROCESS_LOCK:
            PIPELINE_PROCESS = proc
        stdout, stderr = proc.communicate(timeout=PIPELINE_TIMEOUT_S)
        duration = time.time() - started
        output = stdout + (("\n" + stderr) if stderr else "")
        failed_lines = [
            line.strip() for line in output.splitlines()
            if line.strip().startswith("[FAILED]") or line.strip().startswith("FAILED:")
        ]
        if proc.returncode != 0 and not failed_lines:
            nonempty = [line.strip() for line in output.splitlines() if line.strip()]
            if nonempty:
                failed_lines = [nonempty[-1]]
        summary_line = next(
            (line for line in reversed(output.splitlines()) if line.startswith("Summary:")),
            None,
        )
        metrics_line = next(
            (line for line in reversed(output.splitlines()) if line.startswith("MetricsJSON:")),
            None,
        )
        metrics = None
        if metrics_line:
            try:
                metrics = json.loads(metrics_line[len("MetricsJSON:"):])
            except json.JSONDecodeError:
                pass
        diagnostics = {
            "completed_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "success": proc.returncode == 0,
            "returncode": proc.returncode,
            "duration_s": round(duration, 1),
            "summary": summary_line,
            "failed_lines": failed_lines,
            "metrics": metrics,
            "output": output[-50000:],
        }
        try:
            cache_dir = SCRIPT_DIR / "cache"
            cache_dir.mkdir(parents=True, exist_ok=True)
            (cache_dir / "last_pipeline_result.json").write_text(
                json.dumps(diagnostics, indent=2), encoding="utf-8"
            )
        except OSError:
            pass
        return {
            "success": proc.returncode == 0,
            "returncode": proc.returncode,
            "duration_s": round(duration, 1),
            "summary": summary_line,
            "metrics": metrics,
            "failedLines": failed_lines,
            "output": output[-8000:],  # cap so a runaway log can't bloat the response
        }
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.communicate()
        return {
            "success": False,
            "returncode": None,
            "duration_s": round(time.time() - started, 1),
            "summary": f"Timed out after {PIPELINE_TIMEOUT_S}s.",
            "output": "",
        }
    except Exception as e:
        return {
            "success": False,
            "returncode": None,
            "duration_s": round(time.time() - started, 1),
            "summary": f"{type(e).__name__}: {e}",
            "output": "",
        }
    finally:
        with PIPELINE_PROCESS_LOCK:
            PIPELINE_PROCESS = None


def stop_pipeline():
    """Stop the active download without stopping the SailVu helper."""
    with PIPELINE_PROCESS_LOCK:
        proc = PIPELINE_PROCESS
    if proc is None or proc.poll() is not None:
        return {"stopped": False, "message": "No download is running."}
    proc.terminate()
    return {"stopped": True, "message": "Download stop requested."}
class Handler(BaseHTTPRequestHandler):
    def _cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self._cors_headers()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, path):
        body = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "application/zip")
        self.send_header("Content-Disposition", f'attachment; filename="{path.name}"')
        self._cors_headers()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors_headers()
        self.end_headers()

    def do_GET(self):
        if self.path == "/health":
            self._send_json(200, {
                "status": "ok",
                "apiVersion": HELPER_API_VERSION,
                "capabilities": ["cellular", "marine-zone-selection", "regional-plan", "staged-promotion", "automatic-fallback-ladder", "differential-updates", "feedback-bundles", "automatic-voyage-reports"],
                "updates": channel_status(),
            })
        elif self.path == "/progress":
            # 2026-08-04: best-effort read -- a missing/unreadable/mid-write
            # file is a normal state (pipeline hasn't run yet this session,
            # or this poll landed in the split-second between
            # atomic_write_text()'s temp-write and its rename -- rare, but
            # os.replace() being atomic doesn't make a concurrent READ
            # atomic too), not an error worth a 500 for what's just a
            # progress indicator.
            try:
                text = PIPELINE_PROGRESS_FILE.read_text()
                self._send_json(200, json.loads(text))
            except Exception:
                self._send_json(200, {"stage": "idle"})
        elif self.path == "/check-update":
            try: self._send_json(200, check_update())
            except Exception as e: self._send_json(500, {"error": f"{type(e).__name__}: {e}"})
        elif self.path.startswith("/download-feedback?"):
            try:
                from urllib.parse import parse_qs, urlsplit
                name = parse_qs(urlsplit(self.path).query).get("name", [""])[0]
                self._send_file(feedback_file(name))
            except Exception as e: self._send_json(404, {"error": f"{type(e).__name__}: {e}"})
        else:
            self._send_json(404, {"error": "not found"})

    def do_POST(self):
        if self.path == "/stop-pipeline":
            self._send_json(200, stop_pipeline())
        elif self.path == "/run-pipeline":
            # 2026-08-04: optional JSON body {"windHourly": true} -- see
            # module docstring's /run-pipeline entry. Malformed/missing
            # body is NOT an error here, just means "use the default"
            # (thinned wind fetch) -- the existing plain `fetch(url, {
            # method: "POST" })` call app.js already made before this
            # feature existed sends no body at all, and should keep
            # working exactly as before.
            wind_hourly = False
            cellular = False
            marine_zones = []
            download_plan = None
            try:
                length = int(self.headers.get("Content-Length", 0))
                if length:
                    body = json.loads(self.rfile.read(length))
                    wind_hourly = bool(body.get("windHourly"))
                    cellular = body.get("refreshMode") == "cellular"
                    marine_zones = body.get("marineZones") or []
                    download_plan = body.get("downloadPlan")
            except Exception:
                pass
            print(f"\n[{time.strftime('%H:%M:%S')}] Pipeline run requested"
                  f"{' (Cellular: EC marine XML only)' if cellular else ' (full hourly wind)' if wind_hourly else ''}...")
            result = run_pipeline(
                wind_hourly=wind_hourly,
                cellular=cellular,
                marine_zones=marine_zones,
                download_plan=download_plan,
            )
            status = "OK" if result["success"] else "FAILED"
            print(f"[{time.strftime('%H:%M:%S')}] Pipeline run {status} ({result['duration_s']}s).")
            if result.get("failedLines"):
                print("Partial item diagnostics:" if result["success"] else "Failed track diagnostics:")
                for line in result["failedLines"]:
                    print(f"  {line}")
            if result.get("summary"):
                print(f"  {result['summary']}")
            self._send_json(200 if result["success"] else 500, result)
        elif self.path == "/check-marine-statement":
            # 2026-08-06, later session -- see module docstring's own entry
            # for this endpoint. In-process call (fast, one HTTP GET), not
            # a subprocess -- but still wrapped in try/except: this handler
            # must never crash the whole server over one flaky external
            # fetch, same defensive stance every other endpoint here takes.
            try:
                result = fetch_marine_weather_statement()
            except Exception as e:
                result = {"ok": False, "error": f"{type(e).__name__}: {e}"}
            print(f"[{time.strftime('%H:%M:%S')}] Marine statement live check: "
                  f"{'OK' if result.get('ok') else 'FAILED'}"
                  f"{' - ' + result.get('issued', 'no statement') if result.get('ok') else ' - ' + str(result.get('error'))}")
            self._send_json(200 if result.get("ok") else 500, result)
        elif self.path == "/install-update":
            try: self._send_json(200, install_update())
            except Exception as e: self._send_json(500, {"error": f"{type(e).__name__}: {e}"})
        elif self.path == "/stage-local-update":
            try:
                length = int(self.headers.get("Content-Length", 0))
                if length <= 0 or length > 100 * 1024 * 1024: raise ValueError("patch package must be 1 byte to 100 MB")
                self._send_json(200, stage_local_update(self.rfile.read(length)))
            except Exception as e: self._send_json(500, {"error": f"{type(e).__name__}: {e}"})
        elif self.path == "/rollback-update":
            try: self._send_json(200, rollback_update())
            except Exception as e: self._send_json(500, {"error": f"{type(e).__name__}: {e}"})
        elif self.path == "/create-feedback":
            try:
                length = int(self.headers.get("Content-Length", 0))
                if length > 8 * 1024 * 1024: raise ValueError("feedback request exceeds 8 MB")
                body = json.loads(self.rfile.read(length)) if length else {}
                self._send_json(200, create_feedback_bundle(body))
            except Exception as e: self._send_json(500, {"error": f"{type(e).__name__}: {e}"})
        elif self.path == "/archive-voyage":
            try:
                length = int(self.headers.get("Content-Length", 0))
                if length <= 0 or length > 16 * 1024 * 1024: raise ValueError("voyage report request must be 1 byte to 16 MB")
                self._send_json(200, archive_voyage_report(json.loads(self.rfile.read(length))))
            except Exception as e: self._send_json(500, {"error": f"{type(e).__name__}: {e}"})
        else:
            self._send_json(404, {"error": "not found"})

    def log_message(self, fmt, *args):
        # Quiet the default per-request access log line -- run_pipeline()
        # above already prints the events that matter.
        pass


def main():
    if not PIPELINE_SCRIPT.exists():
        print(f"ERROR: expected {PIPELINE_SCRIPT} next to this script -- not found.")
        sys.exit(1)
    instance_lock = acquire_single_instance_lock()
    if instance_lock is None:
        print("Another SAILVu helper server is already running.")
        print("Close its console window, then start SAILVu again.")
        sys.exit(2)
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print("SAILVu local helper server")
    print(f"Listening on http://{HOST}:{PORT} (this machine only, not reachable over the network)")
    print(f"Pipeline script: {PIPELINE_SCRIPT}")
    print('Leave this window open while using the app\'s "Refresh data" button.')
    print("Close this window (or Ctrl+C) to stop the helper.\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping helper server.")


if __name__ == "__main__":
    main()
