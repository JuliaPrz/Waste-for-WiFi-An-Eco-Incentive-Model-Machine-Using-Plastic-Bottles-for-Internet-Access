import os
import subprocess
import uuid
from flask import Blueprint, render_template, request, redirect, url_for, current_app, jsonify, make_response
import db
from services.network import get_mac_for_ip
from db import create_session, get_session, get_session_for_device
from datetime import datetime, timezone

bp = Blueprint("portal", __name__)


def get_device_identifier(request_obj):
    """
    Centralized device identifier logic.
    Priority:
    1. Explicit mac from request (client JS or form)
    2. ARP lookup from IP (works on Raspberry Pi LAN)
    3. Stable device_id cookie
    
    Returns: (identifier, is_cookie_based, set_cookie_flag)
    """
    client_ip = request_obj.remote_addr or request_obj.headers.get("X-Forwarded-For") or request_obj.headers.get("X-Real-IP")
    
    # 1. Check if client explicitly provided MAC
    mac = request_obj.values.get("mac") or None
    if request_obj.is_json:
        try:
            body = request_obj.get_json(silent=True) or {}
            mac = body.get("mac") or mac
        except Exception:
            pass
    
    if mac and mac != "unknown":
        current_app.logger.debug("Using client-provided MAC: %s", mac)
        return mac, False, False
    
    # 2. Try ARP lookup (Raspberry Pi)
    try:
        discovered_mac = get_mac_for_ip(client_ip)
        if discovered_mac:
            current_app.logger.debug("Discovered MAC via ARP: %s", discovered_mac)
            return discovered_mac, False, False
    except Exception as e:
        current_app.logger.debug("ARP lookup failed: %s", e)
    
    # 3. Use/create stable device_id cookie
    device_id = request_obj.cookies.get("device_id")
    if device_id:
        current_app.logger.debug("Using existing device_id cookie: %s", device_id)
        return f"device:{device_id}", True, False
    
    # Create new device_id
    new_device_id = str(uuid.uuid4())
    current_app.logger.debug("Created new device_id: %s", new_device_id)
    return f"device:{new_device_id}", True, True


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
    Captive portal session lookup.
    Returns existing session or creates new awaiting_insertion session.
    """
    client_ip = request.remote_addr or request.headers.get("X-Forwarded-For") or request.headers.get("X-Real-IP")
    
    # Get device identifier using centralized logic
    lookup_mac, is_cookie, set_cookie = get_device_identifier(request)
    
    current_app.logger.debug("Session lookup - MAC: %s, IP: %s, cookie-based: %s", lookup_mac, client_ip, is_cookie)
    
    # Look for existing session
    existing = get_session_for_device(
        mac_address=lookup_mac,
        ip_address=client_ip,
        statuses=('awaiting_insertion', 'inserting', 'active')
    )
    
    # Validate existing session belongs to this device
    if existing:
        existing_mac = existing.get('mac_address', '')
        if existing_mac != lookup_mac:
            current_app.logger.warning(
                "Session lookup: MAC mismatch - expected %s, got %s. Creating new session.",
                lookup_mac, existing_mac
            )
            existing = None
    
    # Check if existing session is still valid
    if existing:
        now_ts = int(datetime.now(timezone.utc).timestamp())
        session_end = existing.get('session_end')
        
        # Active session not yet expired
        if existing['status'] == 'active' and session_end and session_end > now_ts:
            current_app.logger.debug("Resuming active session %s (remaining: %ds)", existing['id'], session_end - now_ts)
            resp = make_response(jsonify({"found": True, "session": existing, "resumed": True}), 200)
            if set_cookie:
                device_id = lookup_mac.replace("device:", "")
                resp.set_cookie("device_id", device_id, max_age=60*60*24*365*5, path="/", samesite='Lax')
            return resp
        
        # Recent inserting/awaiting session (< 10 min)
        if existing['status'] in ('inserting', 'awaiting_insertion'):
            created_at = existing.get('created_at', 0)
            age = now_ts - created_at
            if age < 600:
                current_app.logger.debug("Resuming %s session %s (age: %ds)", existing['status'], existing['id'], age)
                resp = make_response(jsonify({"found": True, "session": existing, "resumed": True}), 200)
                if set_cookie:
                    device_id = lookup_mac.replace("device:", "")
                    resp.set_cookie("device_id", device_id, max_age=60*60*24*365*5, path="/", samesite='Lax')
                return resp
    
    # Create new session
    try:
        session_id = create_session(lookup_mac, client_ip, status="awaiting_insertion")
        session = get_session(session_id)
        current_app.logger.debug("Created new session %s for %s", session_id, lookup_mac)
        resp = make_response(jsonify({"found": False, "session": session, "resumed": False}), 201)
        if set_cookie:
            device_id = lookup_mac.replace("device:", "")
            resp.set_cookie("device_id", device_id, max_age=60*60*24*365*5, path="/", samesite='Lax')
        return resp
    except Exception as e:
        current_app.logger.exception("Failed to create session")
        return jsonify({"error": "Failed to create session", "detail": str(e)}), 500


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
@bp.route("/api/dev/clear-device", methods=["POST"])
def clear_device_id():
    """DEV ONLY: Clear device_id cookie to simulate new user."""
    if not current_app.config.get('MOCK_SENSOR'):
        return jsonify({"error": "Only available in dev mode"}), 403
    
    resp = make_response(jsonify({"success": True, "message": "device_id cleared"}))
    resp.set_cookie("device_id", "", max_age=0, path="/")
    return resp
