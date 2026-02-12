"""
Database schema and helpers for EcoNeT captive portal.
Stores sessions, ratings, bottle logs, and system events.
"""
from flask import current_app, g
import sqlite3
import os
from datetime import datetime, timezone

# Session status constants
STATUS_AWAITING_INSERTION = 'awaiting_insertion'
STATUS_INSERTING = 'inserting'
STATUS_ACTIVE = 'active'
STATUS_EXPIRED = 'expired'
STATUS_DISCONNECTED = 'disconnected'

ALL_SESSION_STATUSES = (
    STATUS_AWAITING_INSERTION,
    STATUS_INSERTING,
    STATUS_ACTIVE,
    STATUS_EXPIRED,
    STATUS_DISCONNECTED,
)

DEFAULT_SESSION_STATUS = STATUS_AWAITING_INSERTION
SECONDS_PER_BOTTLE = 120  # 2 minutes per bottle

def get_db():
    """Get or create database connection for current request."""
    if 'db' not in g:
        db_path = current_app.config.get('DB_PATH') or current_app.config.get('DATABASE')
        if not db_path:
            db_path = os.path.join(current_app.instance_path, 'wifi_portal.db')
            os.makedirs(current_app.instance_path, exist_ok=True)
        g.db = sqlite3.connect(db_path, detect_types=sqlite3.PARSE_DECLTYPES)
        g.db.row_factory = sqlite3.Row
        g.db.execute('PRAGMA foreign_keys = ON')
    return g.db

def close_db(e=None):
    """Close database connection at end of request."""
    db = g.pop('db', None)
    if db is not None:
        db.close()

def init_db(app=None):
    """Initialize database with schema."""
    if app:
        with app.app_context():
            db = get_db()
            _create_tables(db)
            db.commit()
    else:
        db = get_db()
        _create_tables(db)
        db.commit()

def _create_tables(db):
    """Create all tables with proper schema, indexes, and foreign keys."""
    
    # SESSIONS TABLE
    db.execute('''
        CREATE TABLE IF NOT EXISTS sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            mac_address TEXT NOT NULL,
            ip_address TEXT,
            bottles_inserted INTEGER DEFAULT 0,
            seconds_earned INTEGER DEFAULT 0,
            session_start INTEGER,
            session_end INTEGER,
            status TEXT DEFAULT 'awaiting_insertion',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            CHECK (status IN ('awaiting_insertion', 'inserting', 'active', 'expired', 'disconnected'))
        )
    ''')
    
    # RATINGS TABLE
    db.execute('''
        CREATE TABLE IF NOT EXISTS ratings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id INTEGER NOT NULL,
            q1 INTEGER CHECK (q1 BETWEEN 1 AND 5),
            q2 INTEGER CHECK (q2 BETWEEN 1 AND 5),
            q3 INTEGER CHECK (q3 BETWEEN 1 AND 5),
            q4 INTEGER CHECK (q4 BETWEEN 1 AND 5),
            q5 INTEGER CHECK (q5 BETWEEN 1 AND 5),
            q6 INTEGER CHECK (q6 BETWEEN 1 AND 5),
            q7 INTEGER CHECK (q7 BETWEEN 1 AND 5),
            q8 INTEGER CHECK (q8 BETWEEN 1 AND 5),
            q9 INTEGER CHECK (q9 BETWEEN 1 AND 5),
            q10 INTEGER CHECK (q10 BETWEEN 1 AND 5),
            comment TEXT,
            submitted_at INTEGER NOT NULL,
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        )
    ''')
    
    # BOTTLE_LOGS TABLE
    db.execute('''
        CREATE TABLE IF NOT EXISTS bottle_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id INTEGER NOT NULL,
            detected_at INTEGER NOT NULL,
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        )
    ''')
    
    # SYSTEM_LOGS TABLE
    db.execute('''
        CREATE TABLE IF NOT EXISTS system_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_type TEXT NOT NULL,
            description TEXT,
            created_at INTEGER NOT NULL,
            CHECK (event_type IN (
                'session_started',
                'session_expired',
                'session_disconnected',
                'bottle_inserted',
                'rating_submitted'
            ))
        )
    ''')
    
    # Create indexes
    db.execute('CREATE INDEX IF NOT EXISTS idx_sessions_mac ON sessions(mac_address)')
    db.execute('CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status)')
    db.execute('CREATE INDEX IF NOT EXISTS idx_sessions_created ON sessions(created_at)')
    db.execute('CREATE INDEX IF NOT EXISTS idx_ratings_session ON ratings(session_id)')
    db.execute('CREATE INDEX IF NOT EXISTS idx_bottle_logs_session ON bottle_logs(session_id)')
    db.execute('CREATE INDEX IF NOT EXISTS idx_system_logs_type ON system_logs(event_type)')
    db.execute('CREATE INDEX IF NOT EXISTS idx_system_logs_created ON system_logs(created_at)')

# ============================================================================
# SESSION HELPERS
# ============================================================================

def create_session(mac_address, ip_address=None, status=DEFAULT_SESSION_STATUS):
    """
    Create a session row. Detects available session columns and inserts only them.
    Returns integer session id.
    """
    db = get_db()
    now = int(datetime.now(timezone.utc).timestamp())

    cur = db.cursor()
    # get actual columns for sessions table
    cur.execute("PRAGMA table_info(sessions)")
    cols_info = cur.fetchall()
    if not cols_info:
        raise RuntimeError("sessions table not found in database")

    available_cols = {row[1] for row in cols_info}  # name is at index 1

    # Map desirable fields -> candidate column names (in preference order)
    candidates = {
        "mac": [("mac", mac_address), ("mac_address", mac_address), ("client_mac", mac_address)],
        "ip": [("ip", ip_address), ("ip_address", ip_address), ("client_ip", ip_address)],
        "status": [("status", status)],
        "created_at": [("created_at", now), ("created", now), ("created_ts", now)],
        "updated_at": [("updated_at", now), ("updated", now), ("updated_ts", now)],
    }

    insert_cols = []
    insert_vals = []
    for logical, options in candidates.items():
        for col_name, value in options:
            if col_name in available_cols:
                insert_cols.append(col_name)
                insert_vals.append(value)
                break

    if not insert_cols:
        raise RuntimeError("No known columns found to create a session row")

    placeholders = ",".join(["?"] * len(insert_vals))
    cols_sql = ",".join(insert_cols)
    sql = f"INSERT INTO sessions ({cols_sql}) VALUES ({placeholders})"
    cur.execute(sql, tuple(insert_vals))
    db.commit()
    return cur.lastrowid

def get_session(session_id):
    """Get session by ID."""
    db = get_db()
    row = db.execute('SELECT * FROM sessions WHERE id = ?', (session_id,)).fetchone()
    return dict(row) if row else None

def update_session_status(session_id, status):
    """Update session status."""
    db = get_db()
    now = int(datetime.now(timezone.utc).timestamp())
    
    db.execute('''
        UPDATE sessions 
        SET status = ?, updated_at = ?
        WHERE id = ?
    ''', (status, now, session_id))
    
    db.commit()
    
    if status == STATUS_EXPIRED:
        log_system_event('session_expired', f'Session {session_id} expired')
    elif status == STATUS_DISCONNECTED:
        log_system_event('session_disconnected', f'Session {session_id} disconnected')

def start_session(session_id):
    """Activate session and set start/end times."""
    db = get_db()
    session = get_session(session_id)
    if not session:
        return False
    
    now = int(datetime.now(timezone.utc).timestamp())
    session_end = now + session['seconds_earned']
    
    db.execute('''
        UPDATE sessions 
        SET status = ?, session_start = ?, session_end = ?, updated_at = ?
        WHERE id = ?
    ''', (STATUS_ACTIVE, now, session_end, now, session_id))
    
    db.commit()
    return True

def add_bottle_to_session(session_id, seconds_per_bottle=SECONDS_PER_BOTTLE):
    """Register a bottle insertion and add time."""
    db = get_db()
    now = int(datetime.now(timezone.utc).timestamp())
    
    db.execute('''
        UPDATE sessions 
        SET bottles_inserted = bottles_inserted + 1,
            seconds_earned = seconds_earned + ?,
            updated_at = ?
        WHERE id = ?
    ''', (seconds_per_bottle, now, session_id))
    
    db.execute('''
        INSERT INTO bottle_logs (session_id, detected_at)
        VALUES (?, ?)
    ''', (session_id, now))
    
    db.commit()
    
    log_system_event('bottle_inserted', f'Bottle added to session {session_id}')
    
    return True

def extend_session(session_id, additional_seconds):
    """Extend an active session by adding more time."""
    db = get_db()
    session = get_session(session_id)
    if not session or session['status'] != STATUS_ACTIVE:
        return False
    
    now = int(datetime.now(timezone.utc).timestamp())
    new_end = session['session_end'] + additional_seconds
    
    db.execute('''
        UPDATE sessions 
        SET session_end = ?, seconds_earned = seconds_earned + ?, updated_at = ?
        WHERE id = ?
    ''', (new_end, additional_seconds, now, session_id))
    
    db.commit()
    return True

# ============================================================================
# RATING HELPERS
# ============================================================================

def submit_rating(session_id, answers, comment=None):
    """Submit rating for a session."""
    db = get_db()
    now = int(datetime.now(timezone.utc).timestamp())
    
    db.execute('''
        INSERT INTO ratings (
            session_id, q1, q2, q3, q4, q5, q6, q7, q8, q9, q10,
            comment, submitted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ''', (
        session_id,
        answers.get('q1'), answers.get('q2'), answers.get('q3'),
        answers.get('q4'), answers.get('q5'), answers.get('q6'),
        answers.get('q7'), answers.get('q8'), answers.get('q9'),
        answers.get('q10'),
        comment,
        now
    ))
    
    db.commit()
    
    log_system_event('rating_submitted', f'Rating submitted for session {session_id}')
    
    return True

def add_rating(session_id, answers, comment=None):
    """
    Compatibility wrapper for older import name used in routes.rating.
    Delegates to submit_rating which contains the actual implementation.
    """
    return submit_rating(session_id, answers, comment)

def get_rating_by_session(session_id):
    """Get rating for a specific session."""
    db = get_db()
    row = db.execute('SELECT * FROM ratings WHERE session_id = ?', (session_id,)).fetchone()
    return dict(row) if row else None

# ============================================================================
# LOGGING HELPERS
# ============================================================================

def log_system_event(event_type, description=None):
    """Log a system event."""
    db = get_db()
    now = int(datetime.now(timezone.utc).timestamp())
    
    db.execute('''
        INSERT INTO system_logs (event_type, description, created_at)
        VALUES (?, ?, ?)
    ''', (event_type, description, now))
    
    db.commit()

def get_bottle_logs(session_id):
    """Get all bottle insertions for a session."""
    db = get_db()
    rows = db.execute('''
        SELECT * FROM bottle_logs 
        WHERE session_id = ? 
        ORDER BY detected_at ASC
    ''', (session_id,)).fetchall()
    return [dict(row) for row in rows]

def get_system_logs(limit=100, event_type=None):
    """Get recent system logs."""
    db = get_db()
    if event_type:
        rows = db.execute('''
            SELECT * FROM system_logs 
            WHERE event_type = ?
            ORDER BY created_at DESC 
            LIMIT ?
        ''', (event_type, limit)).fetchall()
    else:
        rows = db.execute('''
            SELECT * FROM system_logs 
            ORDER BY created_at DESC 
            LIMIT ?
        ''', (limit,)).fetchall()
    return [dict(row) for row in rows]

# ============================================================================
# ANALYTICS HELPERS
# ============================================================================

def get_session_stats():
    """Get overall session statistics."""
    db = get_db()
    stats = db.execute('''
        SELECT 
            COUNT(*) as total_sessions,
            SUM(bottles_inserted) as total_bottles,
            SUM(seconds_earned) as total_seconds,
            AVG(bottles_inserted) as avg_bottles_per_session,
            AVG(seconds_earned) as avg_seconds_per_session
        FROM sessions
    ''').fetchone()
    return dict(stats) if stats else {}

def get_rating_stats():
    """Get rating statistics (average scores per question)."""
    db = get_db()
    stats = db.execute('''
        SELECT 
            COUNT(*) as total_ratings,
            AVG(q1) as avg_q1, AVG(q2) as avg_q2, AVG(q3) as avg_q3,
            AVG(q4) as avg_q4, AVG(q5) as avg_q5, AVG(q6) as avg_q6,
            AVG(q7) as avg_q7, AVG(q8) as avg_q8, AVG(q9) as avg_q9,
            AVG(q10) as avg_q10
        FROM ratings
    ''').fetchone()
    return dict(stats) if stats else {}

def get_session_for_device(mac=None, ip=None, statuses=ALL_SESSION_STATUSES):
    """
    Return the most recent session for a device identified by MAC or IP
    where session.status is one of `statuses`. Returns dict or None.
    """
    db = get_db()
    cur = db.cursor()

    # discover available columns in sessions table
    cur.execute("PRAGMA table_info(sessions)")
    cols_info = cur.fetchall()
    if not cols_info:
        return None
    available_cols = [r[1] for r in cols_info]

    # candidate names for mac/ip columns
    mac_candidates = [c for c in ("mac", "mac_address", "client_mac") if c in available_cols]
    ip_candidates = [c for c in ("ip", "ip_address", "client_ip") if c in available_cols]
    if "status" not in available_cols:
        return None

    where_clauses = []
    params = []

    if mac and mac_candidates:
        mac_clause = "(" + " OR ".join(f"{col} = ?" for col in mac_candidates) + ")"
        where_clauses.append(mac_clause)
        params.extend([mac] * len(mac_candidates))

    if ip and ip_candidates:
        ip_clause = "(" + " OR ".join(f"{col} = ?" for col in ip_candidates) + ")"
        where_clauses.append(ip_clause)
        params.extend([ip] * len(ip_candidates))

    # status IN (...)
    status_placeholders = ",".join(["?"] * len(statuses))
    where_clauses.append(f"status IN ({status_placeholders})")
    params.extend(statuses)

    where_sql = " AND ".join(where_clauses)
    sql = f"SELECT * FROM sessions WHERE {where_sql} ORDER BY id DESC LIMIT 1"
    cur.execute(sql, tuple(params))
    row = cur.fetchone()
    if not row:
        return None
    cols = [c[0] for c in cur.description]
    return dict(zip(cols, row))



