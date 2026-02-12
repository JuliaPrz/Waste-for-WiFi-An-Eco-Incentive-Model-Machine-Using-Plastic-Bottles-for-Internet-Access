from flask import Flask, make_response, send_from_directory, render_template, request, jsonify
from pathlib import Path
from datetime import datetime, timezone
import db
import threading
import time

def create_app(test_config=None):
    app = Flask(__name__, instance_relative_config=True)
    app.config.from_mapping(
        SECRET_KEY="dev",
        DB_PATH=str(Path(app.instance_path) / "wifi_portal.db"),
        SESSION_DURATION=300,
        MOCK_SENSOR=True,
        STALE_SESSION_AGE=600,       # seconds before awaiting_insertion is considered stale
        CLEANUP_INTERVAL=60,        # how often to run cleanup (seconds)
    )

    if test_config:
        app.config.update(test_config)

    Path(app.instance_path).mkdir(parents=True, exist_ok=True)

    # Initialize DB and ensure teardown is registered
    db.init_db(app)
    app.teardown_appcontext(db.close_db)

    # start background cleanup thread to expire stale/finished sessions
    def _cleanup_loop(application):
        with application.app_context():
            while True:
                try:
                    stale_awaiting = db.expire_stale_awaiting_sessions(
                        application.config.get("STALE_SESSION_AGE", 600)
                    )
                    finished_active = db.expire_finished_active_sessions()
                    if stale_awaiting or finished_active:
                        application.logger.debug(
                            "Session cleanup: expired %d stale awaiting_insertion, %d finished active",
                            stale_awaiting,
                            finished_active,
                        )
                except Exception as e:
                    application.logger.exception("Session cleanup error: %s", e)
                time.sleep(application.config.get("CLEANUP_INTERVAL", 60))

    t = threading.Thread(target=_cleanup_loop, args=(app,), daemon=True)
    t.start()

    # Blueprints (keep routing organized in routes/)
    from routes.portal import bp as portal_bp
    from routes.rating import bp as rating_bp
    app.register_blueprint(portal_bp)
    app.register_blueprint(rating_bp)

    @app.route("/")
    def index():
        session_id = request.args.get("session")
        session_data = None
        if session_id:
            session_data = db.get_session(int(session_id))
        return render_template("index.html", session=session_data)

    @app.route("/favicon.ico")
    def favicon():
        return send_from_directory(app.root_path, "favicon.ico")

    @app.route("/rate.html")
    def rate():
        session_id = request.args.get("session")
        return render_template("rate.html", session_id=session_id)

    # Session retrieval
    @app.route("/api/session/<int:session_id>")
    def get_session_api(session_id):
        session = db.get_session(session_id)
        if not session:
            return jsonify({"error": "Session not found"}), 404
        return jsonify(session)

    # Bottle registration
    @app.route("/api/bottle", methods=["POST"])
    def insert_bottle():
        """Handle bottle insertion - allows both 'inserting' and 'active' statuses"""
        data = request.get_json()
        session_id = data.get('session_id')
        count = data.get('count', 1)  # Allow bulk insert

        if not session_id:
            return jsonify({'error': 'session_id required'}), 400

        try:
            session_id = int(session_id)
        except (ValueError, TypeError):
            return jsonify({'error': 'Invalid session_id'}), 400

        session = db.get_session(session_id)
        if not session:
            return jsonify({'error': 'Session not found'}), 404

        # ✅ Allow bottles for both 'inserting' and 'active' statuses
        if session.get('status') not in ['inserting', 'active']:
            return jsonify({
                'error': f'Session is not accepting bottles (status: {session.get("status")})'
            }), 400

        # Update bottle count and total seconds earned
        bottles_before = session.get('bottles_inserted', 0)
        seconds_before = session.get('seconds_earned', 0)
        
        new_bottles = bottles_before + count
        new_total_seconds = seconds_before + (count * 120)  # Track total seconds earned

        # ✅ Calculate session_end based on current status
        session_end = session.get('session_end')
        current_time = int(datetime.now(timezone.utc).timestamp())
        
        if session.get('status') == 'active':
            # ✅ For ACTIVE sessions: extend from current remaining time
            # If session_end exists and hasn't expired, add to remaining time
            if session_end and session_end > current_time:
                # Extend from current end time
                session_end += (count * 120)
            else:
                # Session expired, restart from now
                session_end = current_time + (count * 120)
        else:
            # ✅ For INSERTING sessions: session_end not set yet (will be set on activation)
            session_end = None

        # Update database
        success = db.update_session(session_id, {
            'bottles_inserted': new_bottles,
            'seconds_earned': new_total_seconds,
            'session_end': session_end
        })

        if not success:
            return jsonify({'error': 'Failed to update session'}), 500

        # Calculate remaining time for response
        remaining_seconds = 0
        if session_end and session_end > current_time:
            remaining_seconds = session_end - current_time

        return jsonify({
            'session_id': session_id,
            'bottles_inserted': new_bottles,
            'minutes_earned': new_total_seconds // 60,
            'seconds_earned': new_total_seconds,
            'session_end': session_end,
            'remaining_seconds': remaining_seconds,
            'status': session.get('status')
        }), 200

    # Start / activate session
    @app.route("/api/session/<int:session_id>/activate", methods=["POST"])
    def activate_session(session_id):
        session = db.get_session(session_id)
        if not session:
            return jsonify({"error": "Session not found"}), 404
        if session["bottles_inserted"] == 0:
            return jsonify({"error": "No bottles inserted"}), 400

        db.start_session(session_id)
        updated_session = db.get_session(session_id)
        return jsonify({"success": True, "session": updated_session})

    # Update session status
    @app.route("/api/session/<int:session_id>/status", methods=["POST"])
    def update_status(session_id):
        data = request.get_json() or {}
        status = data.get("status")
        if status not in db.ALL_SESSION_STATUSES:
            return jsonify({"error": "Invalid status"}), 400
        db.update_session_status(session_id, status)
        return jsonify({"success": True})

    # Expire session
    @app.route("/api/session/<int:session_id>/expire", methods=["POST"])
    def expire_session(session_id):
        session = db.get_session(session_id)
        if not session:
            return jsonify({"error": "Session not found"}), 404
        db.update_session_status(session_id, db.STATUS_EXPIRED)
        return jsonify({"success": True})

    # Create session / acquire insertion lock (returns 409 if busy)
    @app.route("/api/session/create", methods=["POST"])
    def create_session_api():
        """Create or acquire insertion lock for a session."""
        from routes.portal import get_device_identifier
        
        client_ip = request.remote_addr or request.headers.get("X-Forwarded-For")
        
        # Use centralized device identifier logic
        mac_address, is_cookie, set_cookie = get_device_identifier(request)
        
        try:
            session_id = db.acquire_insertion_lock(mac_address=mac_address, ip_address=client_ip)
            
            if not session_id:
                return jsonify({"error": "Machine is currently busy", "message": "Another user is inserting bottles"}), 409
            
            session = db.get_session(session_id)
            resp = make_response(jsonify({"session_id": session_id, "session": session}), 200)
            if set_cookie:
                device_id = mac_address.replace("device:", "")
                resp.set_cookie("device_id", device_id, max_age=60*60*24*365*5, path="/", samesite='Lax')
            return resp
        except Exception as e:
            app.logger.error(f"Error in /api/session/create: {e}", exc_info=True)
            return jsonify({"error": "Failed to create session", "detail": str(e)}), 500

    # Simple unlock endpoint (best-effort) — transition inserting -> awaiting_insertion for this device
    @app.route("/api/session/unlock", methods=["POST"])
    def unlock_insertion():
        """Release insertion lock without activating session."""
        from routes.portal import get_device_identifier
    
        try:
            client_ip = request.remote_addr or request.headers.get("X-Forwarded-For")
            
            # Use centralized device identifier logic
            mac_address, is_cookie, set_cookie = get_device_identifier(request)
            
            # Find any inserting session for this device
            inserting_session = db.get_session_for_device(
                mac_address=mac_address,
                ip_address=client_ip,
                statuses=('inserting',)
            )
            
            if inserting_session:
                session_id = inserting_session['id']
                # If bottles were inserted, revert to active; otherwise expire
                if inserting_session.get('bottles_inserted', 0) > 0:
                    db.update_session_status(session_id, db.STATUS_ACTIVE)
                    app.logger.info(f"Reverted session {session_id} to active after unlock")
                else:
                    db.update_session_status(session_id, db.STATUS_EXPIRED)
                    app.logger.info(f"Expired session {session_id} after unlock with no bottles")
            
            resp = make_response(jsonify({"success": True, "message": "Insertion lock released"}), 200)
            if set_cookie:
                device_id = mac_address.replace("device:", "")
                resp.set_cookie("device_id", device_id, max_age=60*60*24*365*5, path="/", samesite='Lax')
            return resp
        except Exception as e:
            app.logger.exception("Error in /api/session/unlock")
            return jsonify({"error": "internal_server_error", "message": str(e)}), 500

    # Captive portal detection (returns redirect to portal and ensures session exists)
    @app.route("/generate_204")
    @app.route("/connecttest.txt")
    @app.route("/hotspot-detect.html")
    def captive_portal_detect():
        client_ip = request.remote_addr
        # Attempt to resolve MAC via services.network.get_mac_for_ip if available
        try:
            from services.network import get_mac_for_ip
            mac = get_mac_for_ip(client_ip)
        except Exception:
            mac = None

        # NOTE/TODO: On Raspberry Pi ensure Flask receives real client IP (not 127.0.0.1)
        # when running behind any NAT/proxy. If using a reverse proxy set app.wsgi_app =
        # ProxyFix(...) or read X-Forwarded-For carefully. Also ensure services/network.get_mac_for_ip
        # reads /proc/net/arp or dnsmasq leases on the Pi (implemented in services/network.py).

        # Check for any existing session for this device
        existing = db.get_session_for_device(mac=mac, ip=client_ip, statuses=(db.STATUS_AWAITING_INSERTION, db.STATUS_INSERTING, db.STATUS_ACTIVE))
        if existing:
            session_id = existing["id"]
        else:
            session_id = db.create_session(mac, client_ip, status=db.STATUS_AWAITING_INSERTION)

        # Redirect to portal with session ID
        return f'<html><body><script>window.location.href="/?session={session_id}";</script></body></html>'

    return app


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="EcoNeT captive portal")
    parser.add_argument("--mock", dest="mock", action="store_true", help="Enable mock sensor")
    parser.add_argument("--no-mock", dest="mock", action="store_false", help="Disable mock sensor")
    parser.set_defaults(mock=True)
    args = parser.parse_args()

    cfg = {"MOCK_SENSOR": bool(args.mock)}
    app = create_app(test_config=cfg)
    app.run(debug=True, host="0.0.0.0")
