"""Session manager: creates sessions, starts timers, uses access controller.
"""
import time
import uuid
import threading
import logging
from datetime import datetime, timezone, timedelta

from db import create_session as db_create_session, acquire_insertion_lock, get_session, start_session, extend_session, update_session_status, revoke_session

class SessionManager:
    def __init__(self, app, access_controller):
        self.app = app
        self.access_controller = access_controller

    def create(self, ip, mac=None):
        """
        Try to atomically acquire the insertion lock by creating a session with status='inserting'.
        Returns session_id on success, or None if machine is busy.
        """
        # Use DB-level lock helper
        session_id = acquire_insertion_lock(mac_address=mac, ip_address=ip)
        if session_id is None:
            self.app.logger.info("create: insertion lock busy for ip=%s mac=%s", ip, mac)
            return None
        self.app.logger.info("create: acquired insertion lock, session_id=%s for ip=%s", session_id, ip)
        return session_id

    def start_for(self, session_id):
        session = get_session(session_id)
        if not session:
            return False
        ip = session["ip"]
        duration = session["duration"] or self.app.config.get("SESSION_DURATION")
        start_ts = int(time.time())
        update_session_status(session_id, start_ts, duration)

        # grant access
        self.access_controller.grant(ip, duration)

        # schedule revoke
        timer = threading.Timer(duration, self._revoke, args=(session_id,))
        timer.daemon = True
        timer.start()
        self.timers[session_id] = timer
        logging.info("Started session %s for %s seconds", session_id, duration)
        return True

    def _revoke(self, session_id):
        session = get_session(session_id)
        if not session:
            return
        ip = session["ip"]
        revoke_session(session_id, int(time.time()))
        self.access_controller.revoke(ip)
        self.timers.pop(session_id, None)
        logging.info("Revoked session %s", session_id)

    def handle_bottle(self, session_id=None, ip=None):
        # Called when sensor detects a bottle. Prefer session_id, otherwise match ip.
        if session_id:
            # if session is active, extend it; if waiting, start it
            session = get_session(session_id)
            if not session:
                return False
            if session["status"] == "active":
                duration = session["duration"] or self.app.config.get("SESSION_DURATION")
                res = extend_session(session_id, duration)
                # res contains new end and bottles; reschedule timer
                if res:
                    # cancel existing timer and reschedule
                    old = self.timers.get(session_id)
                    if old:
                        try:
                            old.cancel()
                        except Exception:
                            pass
                    remaining = max(0, res["end"] - int(time.time()))
                    timer = threading.Timer(remaining, self._revoke, args=(session_id,))
                    timer.daemon = True
                    timer.start()
                    self.timers[session_id] = timer
                    return True
                return False
            else:
                return self.start_for(session_id)
        # matching by IP could be implemented; for now, fail gracefully
        return False

    def status(self, session_id):
        session = get_session(session_id)
        if not session:
            return {"status": "not_found"}
        return {
            "status": session["status"],
            "ip": session["ip"],
            "mac": session["mac"],
            "bottles": session["bottles"] if "bottles" in session.keys() else 0,
            "duration": session["duration"],
            "start": session["start_time"],
            "end": session["end_time"],
        }

