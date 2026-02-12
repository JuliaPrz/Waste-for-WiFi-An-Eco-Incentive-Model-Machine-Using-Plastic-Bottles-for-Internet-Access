from flask import Flask, send_from_directory, render_template, request, jsonify
from pathlib import Path
from datetime import datetime, timezone
import db

def create_app(test_config=None):
    app = Flask(__name__, instance_relative_config=True)
    app.config.from_mapping(
        SECRET_KEY="dev",
        DB_PATH=str(Path(app.instance_path) / "wifi_portal.db"),
        SESSION_DURATION=300,
        MOCK_SENSOR=True,
    )

    if test_config:
        app.config.update(test_config)

    Path(app.instance_path).mkdir(parents=True, exist_ok=True)

    # Initialize DB and ensure teardown is registered
    db.init_db(app)
    app.teardown_appcontext(db.close_db)

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
    def register_bottle():
        data = request.get_json() or {}
        session_id = data.get("session_id")
        if not session_id:
            return jsonify({"error": "No session_id provided"}), 400

        session = db.get_session(session_id)
        if not session:
            return jsonify({"error": "Invalid session"}), 400

        if session["status"] not in (db.STATUS_INSERTING, db.STATUS_AWAITING_INSERTION):
            return jsonify({"error": "Session not accepting bottles"}), 400

        db.add_bottle_to_session(session_id, seconds_per_bottle=120)
        updated_session = db.get_session(session_id)

        return jsonify({
            "success": True,
            "bottles_inserted": updated_session["bottles_inserted"],
            "seconds_earned": updated_session["seconds_earned"],
            "minutes_earned": updated_session["seconds_earned"] // 60
        })

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
        try:
            data = request.get_json() or {}
            mac_address = data.get("mac_address") or request.remote_addr
            ip_address = data.get("ip_address") or request.remote_addr

            # Try DB-level acquire_insertion_lock (atomic across processes)
            session_id = db.acquire_insertion_lock(mac_address=mac_address, ip_address=ip_address)
            if session_id is None:
                return jsonify({
                    "error": "machine_busy",
                    "message": "Another user is currently inserting a bottle"
                }), 409

            session = db.get_session(session_id)
            return jsonify({
                "success": True,
                "session_id": session_id,
                "status": session.get("status") if session else "inserting"
            }), 201
        except Exception as e:
            app.logger.exception("Error in /api/session/create")
            return jsonify({"error": "internal_server_error", "message": str(e)}), 500

    # Simple unlock endpoint (best-effort) — transition inserting -> awaiting_insertion for this device
    @app.route("/api/session/unlock", methods=["POST"])
    def release_insertion_lock():
        try:
            data = request.get_json(silent=True) or {}
            client_ip = request.remote_addr
            mac = data.get("mac_address") or data.get("mac") or None

            # Find any inserting session for this device
            sess = db.get_session_for_device(mac=mac, ip=client_ip, statuses=(db.STATUS_INSERTING,))
            if not sess:
                return jsonify({"success": True, "message": "No inserting session found"}), 200

            db.update_session_status(sess["id"], db.STATUS_AWAITING_INSERTION)
            return jsonify({"success": True}), 200
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
