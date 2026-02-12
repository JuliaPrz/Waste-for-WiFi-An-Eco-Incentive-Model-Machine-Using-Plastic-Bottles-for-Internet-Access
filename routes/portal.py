import os
import subprocess
from flask import Blueprint, render_template, request, redirect, url_for, current_app, jsonify
from services.network import get_mac_for_ip
import db
bp = Blueprint("portal", __name__)


@bp.route("/register", methods=("GET", "POST"))
def register():
    # auto-detect IP
    ip = request.remote_addr
    mac = request.values.get("mac")
    # If caller didn't supply mac (useful for dev), try to resolve it via dnsmasq/ARP
    if not mac:
        try:
            mac = get_mac_for_ip(ip)
        except Exception:
            mac = None
    session_manager = current_app.extensions["session_manager"]
    session_id = session_manager.create(ip, mac)
    # If request is AJAX/JSON prefer returning JSON so frontend can remain single-page
    if request.is_json or request.headers.get("X-Requested-With") == "XMLHttpRequest":
        return jsonify({"session_id": session_id})
    return redirect(url_for("portal.waiting", session_id=session_id))


@bp.route("/waiting/<session_id>")
def waiting(session_id):
    # waiting page will poll for changes and provide mock trigger when enabled
    return render_template("waiting.html", session_id=session_id, mock=current_app.config.get("MOCK_SENSOR", False))


@bp.route("/api/session/<int:session_id>/status")
def session_status(session_id):
    """Return basic session info for the UI (guard against server errors)."""
    try:
        session = db.get_session(session_id)
        if not session:
            return jsonify({"error": "session_not_found"}), 404

        return jsonify({
            "session_id": session["id"],
            "status": session["status"],
            "mac_address": session.get("mac_address"),
            "ip_address": session.get("ip_address"),
            "bottles_inserted": session.get("bottles_inserted", 0),
            "session_start": session.get("session_start"),
            "session_end": session.get("session_end"),
        }), 200
    except Exception:
        current_app.logger.exception("Error fetching session status")
        return jsonify({"error": "internal_server_error"}), 500


@bp.route("/api/session/lookup", methods=("GET", "POST"))
def api_session_lookup():
    """
    Called by captive portal client when opening the portal.
    Returns existing session for this device if any of statuses
    (awaiting_insertion, inserting, active) exist, otherwise creates
    a new session with status = awaiting_insertion and returns it.
    """
    client_ip = request.remote_addr or request.headers.get("X-Forwarded-For")
    mac = None
    try:
        mac = get_mac_for_ip(client_ip)
    except Exception:
        mac = None

    # allow client to pass a mac param (for dev/testing)
    if request.is_json:
        body = request.get_json()
        mac = body.get("mac") or mac

    # check for existing session for this device
    existing = db.get_session_for_device(mac=mac, ip=client_ip, statuses=(
        "awaiting_insertion", "inserting", "active"
    ))
    if existing:
        current_app.logger.debug("Session lookup: returning existing session for %s/%s -> %s", mac, client_ip, existing.get("id"))
        return jsonify({"found": True, "session": existing}), 200

    # no existing session -> create awaiting_insertion
    session_id = db.create_session(mac, client_ip, status="awaiting_insertion")
    session = db.get_session(session_id)
    current_app.logger.debug("Session lookup: created new awaiting_insertion session %s for %s/%s", session_id, mac, client_ip)
    return jsonify({"found": False, "session": session}), 201


def _get_mac_for_ip(ip):
    """Try to find the MAC address for `ip` using common system methods.

    Works on Linux (reads /proc/net/arp) and falls back to `arp -n` or `arp -a`.
    Returns None when not found.
    """
    try:
        # Linux proc file is easiest
        if os.path.exists('/proc/net/arp'):
            with open('/proc/net/arp') as f:
                for line in f.readlines()[1:]:
                    parts = line.split()
                    if parts[0] == ip:
                        mac = parts[3]
                        if mac != '00:00:00:00:00:00':
                            return mac
        # fallback to arp command
        for cmd in (['arp', '-n', ip], ['arp', '-a', ip]):
            try:
                out = subprocess.check_output(cmd, stderr=subprocess.DEVNULL, universal_newlines=True)
                if ip in out:
                    # try to extract a mac-like token
                    import re
                    m = re.search(r'([0-9a-fA-F]{2}(?:[:\-][0-9a-fA-F]{2}){5})', out)
                    if m:
                        return m.group(1)
            except Exception:
                continue
    except Exception:
        pass
    return None


@bp.route("/sensor/hit", methods=("POST",))
def sensor_hit():
    data = request.get_json(silent=True) or request.form or {}
    session_id = data.get("session_id")
    session_manager = current_app.extensions["session_manager"]
    ok = session_manager.handle_bottle(session_id=session_id)
    return jsonify({"ok": bool(ok)})
