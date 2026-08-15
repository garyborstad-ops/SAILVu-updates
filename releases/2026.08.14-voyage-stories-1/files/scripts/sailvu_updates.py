"""Safe differential updates and sanitized feedback bundles for SAILVu."""
import base64, hashlib, json, os, shutil, urllib.request, uuid, zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

APP_ROOT = Path(__file__).resolve().parents[1]
CONFIG_FILE = APP_ROOT / "update_channel.json"
STATE_DIR = APP_ROOT / ".sailvu_updates"
DEFAULT_MANIFEST_URL = "https://raw.githubusercontent.com/garyborstad-ops/SAILVu-updates/refs/heads/main/stable.json"
MAX_FILE_BYTES = 25 * 1024 * 1024
ALLOWED_FILES = {"app.js", "index.html", "style.css", "vessel_logic.js"}
ALLOWED_DIRS = ("data/", "vendor/", "assets/", "scripts/")

def _safe_relative(value):
    p = PurePosixPath(str(value))
    value = str(p)
    if p.is_absolute() or ".." in p.parts or not value or not (value in ALLOWED_FILES or value.startswith(ALLOWED_DIRS)):
        raise ValueError(f"update path is not allowed: {value}")
    return Path(*p.parts)

def _read_json(path): return json.loads(Path(path).read_text(encoding="utf-8"))
def _config():
    config = _read_json(CONFIG_FILE)
    # A blank value keeps old/offline packages harmless while this updater
    # supplies the official read-only public distribution channel.
    if not config.get("manifestUrl"):
        config["manifestUrl"] = DEFAULT_MANIFEST_URL
    return config
def _download(url, max_bytes=MAX_FILE_BYTES):
    if not str(url).startswith("https://"): raise ValueError("update downloads require HTTPS")
    with urllib.request.urlopen(url, timeout=30) as response:
        data = response.read(max_bytes + 1)
    if len(data) > max_bytes: raise ValueError("update file exceeds size limit")
    return data
def _sha(data): return hashlib.sha256(data).hexdigest().lower()

def _backups():
    root = STATE_DIR / "backups"
    return sorted((p for p in root.iterdir() if p.is_dir() and (p / "backup_state.json").exists()), reverse=True) if root.exists() else []

def channel_status():
    config = _config()
    return {"configured": bool(config.get("manifestUrl")), "channel": config.get("channel", "stable"), "manifestUrl": config.get("manifestUrl", ""), "installedVersion": config.get("installedVersion", "development"), "rollbackAvailable": bool(_backups())}

def check_update():
    config = _config()
    if not config.get("manifestUrl"): return {"available": False, "configured": False, "message": "No public update channel has been configured yet."}
    manifest = json.loads(_download(config["manifestUrl"], 1024 * 1024))
    files = manifest.get("files") or []
    for item in files:
        _safe_relative(item["path"])
        if not str(item.get("url", "")).startswith("https://") or len(item.get("sha256", "")) != 64: raise ValueError("invalid update manifest")
    STATE_DIR.mkdir(exist_ok=True)
    (STATE_DIR / "pending_manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    total = sum(int(item.get("size", 0)) for item in files)
    return {"available": manifest.get("version") != config.get("installedVersion"), "configured": True, "version": manifest.get("version"), "notes": manifest.get("notes", ""), "files": len(files), "bytes": total}

def stage_local_update(package_data):
    """Validate an emailed/USB patch ZIP and stage it for the normal installer."""
    if len(package_data) > 100 * 1024 * 1024: raise ValueError("patch package exceeds 100 MB")
    STATE_DIR.mkdir(exist_ok=True)
    package = STATE_DIR / ("incoming-" + uuid.uuid4().hex + ".zip")
    pending_files = STATE_DIR / "pending_files"
    package.write_bytes(package_data)
    try:
        with zipfile.ZipFile(package) as archive:
            names = set(archive.namelist())
            if "manifest.json" not in names: raise ValueError("patch package has no manifest.json")
            manifest = json.loads(archive.read("manifest.json"))
            files = manifest.get("files") or []
            if not manifest.get("version") or not files: raise ValueError("patch manifest is incomplete")
            if len(files) > 200: raise ValueError("patch package contains too many files")
            shutil.rmtree(pending_files, ignore_errors=True)
            total = 0
            for item in files:
                rel = _safe_relative(item["path"]); member = "files/" + rel.as_posix()
                if member not in names: raise ValueError(f"patch file is missing: {rel.as_posix()}")
                if archive.getinfo(member).file_size > MAX_FILE_BYTES: raise ValueError(f"patch file exceeds size limit: {rel.as_posix()}")
                data = archive.read(member)
                if len(data) > MAX_FILE_BYTES: raise ValueError(f"patch file exceeds size limit: {rel.as_posix()}")
                if len(item.get("sha256", "")) != 64 or _sha(data) != item["sha256"].lower(): raise ValueError(f"checksum failed: {rel.as_posix()}")
                if "size" in item and int(item["size"]) != len(data): raise ValueError(f"size failed: {rel.as_posix()}")
                total += len(data)
                if total > 100 * 1024 * 1024: raise ValueError("expanded patch package exceeds 100 MB")
                target = pending_files / rel; target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(data)
            manifest["source"] = "local-package"
            (STATE_DIR / "pending_manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
            return {"available": True, "configured": True, "version": manifest["version"], "notes": manifest.get("notes", ""), "files": len(files), "bytes": total, "source": "local-package"}
    finally: package.unlink(missing_ok=True)

def install_update():
    manifest = _read_json(STATE_DIR / "pending_manifest.json")
    STATE_DIR.mkdir(exist_ok=True)
    stage = STATE_DIR / "staging" / uuid.uuid4().hex
    stage.mkdir(parents=True)
    downloaded = []
    try:
        for item in manifest.get("files", []):
            rel = _safe_relative(item["path"])
            data = (STATE_DIR / "pending_files" / rel).read_bytes() if manifest.get("source") == "local-package" else _download(item["url"])
            if _sha(data) != item["sha256"].lower(): raise ValueError(f"checksum failed: {rel.as_posix()}")
            target = stage / rel; target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(data); downloaded.append(rel)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"); backup = STATE_DIR / "backups" / stamp
        backup_state = []
        for rel in downloaded:
            current = APP_ROOT / rel
            backup_state.append({"path": rel.as_posix(), "existed": current.exists()})
            if current.exists(): (backup / rel).parent.mkdir(parents=True, exist_ok=True); shutil.copy2(current, backup / rel)
        backup.mkdir(parents=True, exist_ok=True)
        (backup / "backup_state.json").write_text(json.dumps({"previousVersion": _read_json(CONFIG_FILE).get("installedVersion"), "files": backup_state}, indent=2), encoding="utf-8")
        for rel in downloaded:
            target = APP_ROOT / rel; target.parent.mkdir(parents=True, exist_ok=True); os.replace(stage / rel, target)
        config = _read_json(CONFIG_FILE); config["installedVersion"] = manifest.get("version"); CONFIG_FILE.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
        (backup / "manifest.json").parent.mkdir(parents=True, exist_ok=True); (backup / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        return {"success": True, "version": manifest.get("version"), "files": len(downloaded), "backup": stamp}
    finally:
        shutil.rmtree(stage, ignore_errors=True)
        if manifest.get("source") == "local-package": shutil.rmtree(STATE_DIR / "pending_files", ignore_errors=True)

def rollback_update():
    backups = _backups()
    if not backups: raise ValueError("no update backup is available")
    backup = backups[0]; state = _read_json(backup / "backup_state.json")
    for item in state.get("files", []):
        rel = _safe_relative(item["path"]); target = APP_ROOT / rel
        if item.get("existed"):
            source = backup / rel
            if not source.exists(): raise ValueError(f"backup is incomplete: {rel.as_posix()}")
            target.parent.mkdir(parents=True, exist_ok=True); shutil.copy2(source, target)
        elif target.exists():
            target.unlink()
    config = _read_json(CONFIG_FILE); config["installedVersion"] = state.get("previousVersion", "development")
    CONFIG_FILE.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    return {"success": True, "version": config["installedVersion"], "backup": backup.name, "files": len(state.get("files", []))}

def feedback_file(filename):
    name = Path(str(filename)).name
    if name != filename or not name.startswith("SAILVu-feedback-") or not name.endswith(".zip"):
        raise ValueError("invalid feedback filename")
    path = STATE_DIR / name
    if not path.is_file(): raise FileNotFoundError(name)
    return path

def create_feedback_bundle(payload):
    STATE_DIR.mkdir(exist_ok=True); stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"); output = STATE_DIR / f"SAILVu-feedback-{stamp}.zip"
    safe = {k: payload.get(k) for k in ("notes", "app", "browser", "connection", "pathsSeen", "instrumentSources", "instrumentTimestamps", "instrumentReceivedTimes", "latestInstrumentValues", "sampling", "storage", "recentVoyageRecords")}
    safe["createdAt"] = datetime.now(timezone.utc).isoformat(); safe["privacy"] = "Signal K tokens and browser local-storage contents are excluded."
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("feedback.json", json.dumps(safe, indent=2))
        screenshot = payload.get("screenshot") or {}
        if screenshot.get("data") and screenshot.get("name"):
            data = base64.b64decode(screenshot["data"], validate=True)
            if len(data) <= 5 * 1024 * 1024: archive.writestr("screenshot-" + Path(screenshot["name"]).name, data)
    return {"success": True, "filename": output.name, "path": str(output)}
