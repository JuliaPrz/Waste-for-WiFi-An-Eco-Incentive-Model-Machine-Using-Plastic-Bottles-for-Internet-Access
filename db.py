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

ALL_SESSION_STATUSES = (
    STATUS_AWAITING_INSERTION,
    STATUS_INSERTING,
    STATUS_ACTIVE,
    STATUS_EXPIRED,
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
            CHECK (status IN ('awaiting_insertion', 'inserting', 'active', 'expired'))
        )
    ''')

    # Enforce at most one row with status='inserting'
    db.execute('''
        CREATE UNIQUE INDEX IF NOT EXISTS idx_single_inserting
        ON sessions(status)
        WHERE status = 'inserting'
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
                'bottle_inserted',
                'rating_submitted'
            ))
        )
    ''')

    # ✅ RATINGS TABLE (needed by submit_rating)
    db.execute('''
        CREATE TABLE IF NOT EXISTS ratings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id INTEGER NOT NULL,
            q1 INTEGER, q2 INTEGER, q3 INTEGER, q4 INTEGER, q5 INTEGER,
            q6 INTEGER, q7 INTEGER, q8 INTEGER, q9 INTEGER, q10 INTEGER,
            comment TEXT,
            submitted_at INTEGER NOT NULL,
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        )
    ''')
    db.execute('CREATE INDEX IF NOT EXISTS idx_ratings_session ON ratings(session_id)')

    # Create indexes
    db.execute('CREATE INDEX IF NOT EXISTS idx_sessions_mac ON sessions(mac_address)')
    db.execute('CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status)')
    db.execute('CREATE INDEX IF NOT EXISTS idx_sessions_created ON sessions(created_at)')
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

def get_session_for_device(mac_address=None, ip_address=None, statuses=None):
    """
    Find the most recent session for a device (by mac or ip) with given statuses.
    Returns session dict or None.
    
    Best practice: prefer MAC lookup over IP for device identification.
    """
    if not mac_address and not ip_address:
        return None
    
    db = get_db()
    cur = db.cursor()
    
    # Build WHERE clause
    where_parts = []
    params = []
    
    if mac_address:
        where_parts.append("mac_address = ?")
        params.append(mac_address)
    
    if ip_address:
        where_parts.append("ip_address = ?")
        params.append(ip_address)
    
    if statuses:
        placeholders = ','.join(['?'] * len(statuses))
        where_parts.append(f"status IN ({placeholders})")
        params.extend(statuses)
    
    where_clause = " OR ".join(where_parts[:2] if len(where_parts) > 2 else where_parts[:1])
    if statuses and len(where_parts) > 2:
        where_clause = f"({where_clause}) AND {where_parts[2]}"
    
    query = f"""
        SELECT id, mac_address, ip_address, bottles_inserted, seconds_earned,
               session_start, session_end, status, created_at, updated_at
        FROM sessions
        WHERE {where_clause}
        ORDER BY updated_at DESC, created_at DESC
        LIMIT 1
    """
    
    cur.execute(query, tuple(params))
    row = cur.fetchone()
    
    if not row:
        return None
    
    return {
        'id': row[0],
        'mac_address': row[1],
        'ip_address': row[2],
        'bottles_inserted': row[3],
        'seconds_earned': row[4],
        'session_start': row[5],
        'session_end': row[6],
        'status': row[7],
        'created_at': row[8],
        'updated_at': row[9]
    }

def acquire_insertion_lock(mac_address=None, ip_address=None):
    """
    Acquire the machine-wide insertion lock.

    Returns:
        int session_id on success, or None if another session already holds the lock.

    Behavior:
    - If THIS device has a session with status in (awaiting_insertion, active, inserting),
      prefer the newest one:
        * awaiting_insertion or active -> transition to inserting and return its id
        * inserting -> just return its id
    - If another session (for any device) already has status='inserting', return None.
    - Otherwise create a new session with status='inserting' and return its id.

    The UNIQUE INDEX on status='inserting' guarantees at most one such row.
    """
    db = get_db()
    now = int(datetime.now(timezone.utc).timestamp())
    cur = db.cursor()

    try:
        db.execute("BEGIN IMMEDIATE")

        # Get available columns (schema may evolve)
        cur.execute("PRAGMA table_info(sessions)")
        cols_info = cur.fetchall()
        if not cols_info:
            db.rollback()
            return None
        available_cols = {r[1] for r in cols_info}

        mac_cols = [c for c in ("mac_address", "mac", "client_mac") if c in available_cols]
        ip_cols = [c for c in ("ip_address", "ip", "client_ip") if c in available_cols]

        # 1) If some session already holds inserting, remember it
        cur.execute(
            "SELECT id FROM sessions WHERE status = ? LIMIT 1",
            (STATUS_INSERTING,),
        )
        existing_inserting = cur.fetchone()  # tuple like (id,) or None

        # 2) Find this device's most recent session in (awaiting_insertion, active, inserting)
        where_parts = []
        params = []

        if mac_address and mac_cols:
            where_parts.append(f"{mac_cols[0]} = ?")
            params.append(mac_address)
        elif ip_address and ip_cols:
            where_parts.append(f"{ip_cols[0]} = ?")
            params.append(ip_address)

        row = None
        if where_parts:
            where_sql = f"({where_parts[0]}) AND status IN (?, ?, ?)"
            params_with_status = params + [
                STATUS_AWAITING_INSERTION,
                STATUS_ACTIVE,
                STATUS_INSERTING,
            ]
            cur.execute(
                f"""
                SELECT id, status
                FROM sessions
                WHERE {where_sql}
                ORDER BY created_at DESC
                LIMIT 1
                """,
                tuple(params_with_status),
            )
            row = cur.fetchone()

        if row:
            session_id, status = row

            if status == STATUS_INSERTING:
                # This device already holds the lock
                db.commit()
                return session_id

            # Another session (maybe other device) is inserting
            if existing_inserting and existing_inserting[0] != session_id:
                db.commit()
                return None

            # Upgrade this device's session to inserting
            cur.execute(
                "UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?",
                (STATUS_INSERTING, now, session_id),
            )
            db.commit()
            return session_id

        # 3) No session for this device; if someone else is inserting, we're busy
        if existing_inserting:
            db.commit()
            return None

        # 4) Create a new session in inserting state for this device
        insert_cols = []
        insert_vals = []

        if mac_cols and mac_address:
            insert_cols.append(mac_cols[0])
            insert_vals.append(mac_address)
        if ip_cols and ip_address:
            insert_cols.append(ip_cols[0])
            insert_vals.append(ip_address)

        insert_cols.extend(["status", "created_at", "updated_at"])
        insert_vals.extend([STATUS_INSERTING, now, now])

        cols_sql = ",".join(insert_cols)
        placeholders = ",".join(["?"] * len(insert_vals))
        cur.execute(
            f"INSERT INTO sessions ({cols_sql}) VALUES ({placeholders})",
            tuple(insert_vals),
        )
        new_id = cur.lastrowid
        db.commit()
        return new_id

    except sqlite3.IntegrityError as e:
        # UNIQUE(status='inserting') violated -> someone else grabbed the lock
        try:
            db.rollback()
        except Exception:
            pass
        current_app.logger.warning("acquire_insertion_lock: integrity error: %s", e)
        return None
    except Exception:
        try:
            db.rollback()
        except Exception:
            pass
        raise

def _row_to_dict(row):
    """Helper to convert sqlite3.Row to plain dict."""
    if row is None:
        return None
    return {k: row[k] for k in row.keys()}

def expire_stale_awaiting_sessions(max_age_seconds=600):
    """
    Mark sessions with status=awaiting_insertion older than max_age_seconds as expired.
    Returns number of sessions updated.
    """
    db = get_db()
    now = int(datetime.now(timezone.utc).timestamp())
    cutoff = now - int(max_age_seconds)
    cur = db.cursor()
    cur.execute(
        """
        UPDATE sessions
        SET status = ?, updated_at = ?
        WHERE status = ?
          AND created_at IS NOT NULL
          AND created_at < ?
        """,
        (STATUS_EXPIRED, now, STATUS_AWAITING_INSERTION, cutoff),
    )
    db.commit()
    return cur.rowcount

def expire_finished_active_sessions():
    """
    Mark active sessions whose time has fully elapsed as expired.
    Uses session_end as the authoritative end time.
    Returns number of sessions updated.
    """
    db = get_db()
    now = int(datetime.now(timezone.utc).timestamp())
    cur = db.cursor()
    cur.execute(
        """
        UPDATE sessions
        SET status = ?, updated_at = ?
        WHERE status = ?
          AND session_end IS NOT NULL
          AND session_end <= ?
        """,
        (STATUS_EXPIRED, now, STATUS_ACTIVE, now),
    )
    db.commit()
    return cur.rowcount

def update_session(session_id, updates):
    """Update session fields
    
    Args:
        session_id: Session ID to update
        updates: Dictionary of fields to update (e.g., {'bottles_inserted': 3, 'seconds_earned': 360})
    
    Returns:
        bool: True if successful, False otherwise
    """
    conn = get_db()
    if not conn:
        return False
    
    # Build UPDATE query dynamically
    set_clauses = []
    values = []
    for key, value in updates.items():
        set_clauses.append(f"{key} = ?")
        values.append(value)
    
    if not set_clauses:
        return False
    
    values.append(session_id)  # Add session_id for WHERE clause
    
    query = f"UPDATE sessions SET {', '.join(set_clauses)} WHERE id = ?"
    
    try:
        conn.execute(query, values)
        conn.commit()
        return True
    except Exception as e:
        print(f"Error updating session {session_id}: {e}")
        return False



