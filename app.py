import os
import sqlite3
import uuid
from datetime import datetime
from functools import wraps

from flask import (
    Flask, g, request, session, jsonify,
    render_template, redirect, url_for, abort, send_from_directory
)
from werkzeug.security import generate_password_hash, check_password_hash
from werkzeug.utils import secure_filename

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "data.db")
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)

app = Flask(__name__)
# In production set DASHBOARD_SECRET as an environment variable.
app.secret_key = os.environ.get("DASHBOARD_SECRET", "dev-change-me-in-production")
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    MAX_CONTENT_LENGTH=20 * 1024 * 1024,  # 20 MB per request (file uploads)
)


@app.errorhandler(413)
def too_large(exc):
    return jsonify(error="Файл слишком большой (макс. 20 МБ)"), 413


# ---------------------------------------------------------------------------
# Database helpers
# ---------------------------------------------------------------------------
def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


@app.teardown_appcontext
def close_db(exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    db = sqlite3.connect(DB_PATH)
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS users (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            username      TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            created_at    TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS nodes (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id    INTEGER NOT NULL,
            parent_id  INTEGER,
            zone_id    INTEGER,
            title      TEXT NOT NULL DEFAULT '',
            content    TEXT NOT NULL DEFAULT '',
            x          REAL NOT NULL DEFAULT 0,
            y          REAL NOT NULL DEFAULT 0,
            color      TEXT NOT NULL DEFAULT '#6366f1',
            width      REAL,
            height     REAL,
            is_root    INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (user_id)   REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (parent_id) REFERENCES nodes(id) ON DELETE CASCADE,
            FOREIGN KEY (zone_id)   REFERENCES zones(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_nodes_user ON nodes(user_id);

        CREATE TABLE IF NOT EXISTS node_members (
            node_id    INTEGER NOT NULL,
            user_id    INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (node_id, user_id),
            FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS zones (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id    INTEGER NOT NULL,
            title      TEXT NOT NULL DEFAULT '',
            x          REAL NOT NULL DEFAULT 0,
            y          REAL NOT NULL DEFAULT 0,
            width      REAL NOT NULL DEFAULT 320,
            height     REAL NOT NULL DEFAULT 220,
            color      TEXT NOT NULL DEFAULT '#6366f1',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_zones_user ON zones(user_id);

        CREATE TABLE IF NOT EXISTS node_links (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id    INTEGER NOT NULL,
            from_id    INTEGER NOT NULL,
            to_id      INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (from_id) REFERENCES nodes(id) ON DELETE CASCADE,
            FOREIGN KEY (to_id)   REFERENCES nodes(id) ON DELETE CASCADE,
            UNIQUE (from_id, to_id)
        );

        CREATE TABLE IF NOT EXISTS node_files (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            node_id     INTEGER NOT NULL,
            user_id     INTEGER NOT NULL,
            filename    TEXT NOT NULL,
            stored_name TEXT NOT NULL,
            mime        TEXT,
            size        INTEGER,
            created_at  TEXT NOT NULL,
            FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        """
    )
    # Migrate older databases: add columns introduced later.
    cols = {r[1] for r in db.execute("PRAGMA table_info(nodes)").fetchall()}
    for col, coltype in (("width", "REAL"), ("height", "REAL"), ("zone_id", "INTEGER")):
        if col not in cols:
            db.execute(f"ALTER TABLE nodes ADD COLUMN {col} {coltype}")
    db.commit()
    seed_users(db)
    db.close()


# Test accounts created automatically on first start.
SEED_USERS = [
    ("admin", "admin1234"),
    ("test", "test1234"),
]


def create_user(db, username, password):
    """Insert a user with their root node. Returns the new user id."""
    cur = db.execute(
        "INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)",
        (username, generate_password_hash(password), now()),
    )
    uid = cur.lastrowid
    db.execute(
        """INSERT INTO nodes (user_id, parent_id, title, content, x, y, color, is_root, created_at, updated_at)
           VALUES (?, NULL, ?, ?, ?, ?, ?, 1, ?, ?)""",
        (uid, "Материнская нода", "Здесь можно писать. От неё рисуйте другие ноды.",
         0, 0, "#8b5cf6", now(), now()),
    )
    return uid


def seed_users(db):
    for username, password in SEED_USERS:
        exists = db.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone()
        if not exists:
            create_user(db, username, password)
    db.commit()


def now():
    return datetime.utcnow().isoformat(timespec="seconds") + "Z"


# ---------------------------------------------------------------------------
# Auth helpers
# ---------------------------------------------------------------------------
def current_user():
    uid = session.get("user_id")
    if uid is None:
        return None
    row = get_db().execute("SELECT id, username FROM users WHERE id = ?", (uid,)).fetchone()
    return row


def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if session.get("user_id") is None:
            if request.path.startswith("/api/"):
                return jsonify(error="Требуется вход"), 401
            return redirect(url_for("login_page"))
        return view(*args, **kwargs)
    return wrapped


# ---------------------------------------------------------------------------
# Pages
# ---------------------------------------------------------------------------
@app.route("/")
def index():
    if session.get("user_id"):
        return redirect(url_for("dashboard_page"))
    return redirect(url_for("login_page"))


@app.route("/login")
def login_page():
    if session.get("user_id"):
        return redirect(url_for("dashboard_page"))
    return render_template("auth.html", mode="login")


@app.route("/register")
def register_page():
    if session.get("user_id"):
        return redirect(url_for("dashboard_page"))
    return render_template("auth.html", mode="register")


@app.route("/dashboard")
@login_required
def dashboard_page():
    return render_template("dashboard.html", username=current_user()["username"])


# ---------------------------------------------------------------------------
# Auth API
# ---------------------------------------------------------------------------
@app.post("/api/register")
def api_register():
    data = request.get_json(silent=True) or request.form
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""

    if len(username) < 3:
        return jsonify(error="Логин минимум 3 символа"), 400
    if len(password) < 4:
        return jsonify(error="Пароль минимум 4 символа"), 400

    db = get_db()
    exists = db.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone()
    if exists:
        return jsonify(error="Такой логин уже занят"), 409

    uid = create_user(db, username, password)
    db.commit()

    session.clear()
    session["user_id"] = uid
    return jsonify(ok=True, username=username)


@app.post("/api/login")
def api_login():
    data = request.get_json(silent=True) or request.form
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""

    row = get_db().execute(
        "SELECT id, password_hash FROM users WHERE username = ?", (username,)
    ).fetchone()
    if row is None or not check_password_hash(row["password_hash"], password):
        return jsonify(error="Неверный логин или пароль"), 401

    session.clear()
    session["user_id"] = row["id"]
    return jsonify(ok=True, username=username)


@app.post("/api/logout")
def api_logout():
    session.clear()
    return jsonify(ok=True)


@app.get("/api/me")
@login_required
def api_me():
    u = current_user()
    return jsonify(id=u["id"], username=u["username"])


@app.get("/api/users")
@login_required
def api_users_list():
    """All accounts — used to attach users to nodes."""
    rows = get_db().execute("SELECT id, username FROM users ORDER BY username").fetchall()
    return jsonify(users=[{"id": r["id"], "username": r["username"]} for r in rows])


# ---------------------------------------------------------------------------
# Zones API (bounding areas that nodes can live inside)
# ---------------------------------------------------------------------------
def zone_to_dict(r):
    return {
        "id": r["id"],
        "title": r["title"],
        "x": r["x"],
        "y": r["y"],
        "width": r["width"],
        "height": r["height"],
        "color": r["color"],
    }


@app.get("/api/zones")
@login_required
def api_zones_list():
    uid = session["user_id"]
    rows = get_db().execute("SELECT * FROM zones WHERE user_id = ? ORDER BY id", (uid,)).fetchall()
    return jsonify(zones=[zone_to_dict(r) for r in rows])


@app.post("/api/zones")
@login_required
def api_zones_create():
    uid = session["user_id"]
    data = request.get_json(silent=True) or {}
    db = get_db()
    cur = db.execute(
        """INSERT INTO zones (user_id, title, x, y, width, height, color, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            uid,
            (data.get("title") or "Зона")[:200],
            float(data.get("x") or 0),
            float(data.get("y") or 0),
            max(80.0, float(data.get("width") or 320)),
            max(80.0, float(data.get("height") or 220)),
            data.get("color") or "#6366f1",
            now(), now(),
        ),
    )
    db.commit()
    row = db.execute("SELECT * FROM zones WHERE id = ?", (cur.lastrowid,)).fetchone()
    return jsonify(zone=zone_to_dict(row)), 201


@app.put("/api/zones/<int:zone_id>")
@login_required
def api_zones_update(zone_id):
    uid = session["user_id"]
    db = get_db()
    row = db.execute("SELECT * FROM zones WHERE id = ? AND user_id = ?", (zone_id, uid)).fetchone()
    if row is None:
        return jsonify(error="Зона не найдена"), 404

    data = request.get_json(silent=True) or {}
    try:
        width = max(80.0, float(data.get("width", row["width"])))
        height = max(80.0, float(data.get("height", row["height"])))
    except (TypeError, ValueError):
        width, height = row["width"], row["height"]
    fields = {
        "title": (data.get("title", row["title"]) or "")[:200],
        "x": data.get("x", row["x"]),
        "y": data.get("y", row["y"]),
        "width": width,
        "height": height,
        "color": data.get("color", row["color"]),
    }
    db.execute(
        """UPDATE zones SET title=?, x=?, y=?, width=?, height=?, color=?, updated_at=?
           WHERE id=? AND user_id=?""",
        (fields["title"], fields["x"], fields["y"], fields["width"], fields["height"],
         fields["color"], now(), zone_id, uid),
    )
    db.commit()
    row = db.execute("SELECT * FROM zones WHERE id = ?", (zone_id,)).fetchone()
    return jsonify(zone=zone_to_dict(row))


@app.delete("/api/zones/<int:zone_id>")
@login_required
def api_zones_delete(zone_id):
    uid = session["user_id"]
    db = get_db()
    row = db.execute("SELECT 1 FROM zones WHERE id = ? AND user_id = ?", (zone_id, uid)).fetchone()
    if row is None:
        return jsonify(error="Зона не найдена"), 404
    db.execute("UPDATE nodes SET zone_id = NULL WHERE zone_id = ? AND user_id = ?", (zone_id, uid))
    db.execute("DELETE FROM zones WHERE id = ? AND user_id = ?", (zone_id, uid))
    db.commit()
    return jsonify(ok=True)


# ---------------------------------------------------------------------------
# Node links API (extra connections beyond the parent/child tree — e.g. a
# node that has several "parents")
# ---------------------------------------------------------------------------
def link_to_dict(r):
    return {"id": r["id"], "from_id": r["from_id"], "to_id": r["to_id"]}


@app.get("/api/links")
@login_required
def api_links_list():
    uid = session["user_id"]
    rows = get_db().execute("SELECT * FROM node_links WHERE user_id = ? ORDER BY id", (uid,)).fetchall()
    return jsonify(links=[link_to_dict(r) for r in rows])


@app.post("/api/links")
@login_required
def api_links_create():
    uid = session["user_id"]
    data = request.get_json(silent=True) or {}
    try:
        from_id = int(data.get("from_id"))
        to_id = int(data.get("to_id"))
    except (TypeError, ValueError):
        return jsonify(error="Некорректные ноды для связи"), 400
    if from_id == to_id:
        return jsonify(error="Нельзя связать ноду саму с собой"), 400

    db = get_db()
    owns = db.execute(
        "SELECT COUNT(*) c FROM nodes WHERE user_id = ? AND id IN (?, ?)", (uid, from_id, to_id)
    ).fetchone()["c"]
    if owns != 2:
        return jsonify(error="Ноды не найдены"), 404

    dup = db.execute(
        """SELECT 1 FROM node_links WHERE user_id=?
           AND ((from_id=? AND to_id=?) OR (from_id=? AND to_id=?))""",
        (uid, from_id, to_id, to_id, from_id),
    ).fetchone()
    if dup:
        return jsonify(error="Такая связь уже существует"), 409

    cur = db.execute(
        "INSERT INTO node_links (user_id, from_id, to_id, created_at) VALUES (?, ?, ?, ?)",
        (uid, from_id, to_id, now()),
    )
    db.commit()
    row = db.execute("SELECT * FROM node_links WHERE id = ?", (cur.lastrowid,)).fetchone()
    return jsonify(link=link_to_dict(row)), 201


@app.delete("/api/links/<int:link_id>")
@login_required
def api_links_delete(link_id):
    uid = session["user_id"]
    db = get_db()
    row = db.execute("SELECT 1 FROM node_links WHERE id = ? AND user_id = ?", (link_id, uid)).fetchone()
    if row is None:
        return jsonify(error="Связь не найдена"), 404
    db.execute("DELETE FROM node_links WHERE id = ? AND user_id = ?", (link_id, uid))
    db.commit()
    return jsonify(ok=True)


# ---------------------------------------------------------------------------
# Node file attachments API
# ---------------------------------------------------------------------------
def file_to_dict(r):
    return {
        "id": r["id"],
        "filename": r["filename"],
        "mime": r["mime"],
        "size": r["size"],
        "url": url_for("api_files_download", file_id=r["id"]),
    }


def node_files(db, node_id):
    rows = db.execute("SELECT * FROM node_files WHERE node_id = ? ORDER BY id", (node_id,)).fetchall()
    return [file_to_dict(r) for r in rows]


@app.post("/api/nodes/<int:node_id>/files")
@login_required
def api_node_files_upload(node_id):
    uid = session["user_id"]
    db = get_db()
    owns = db.execute("SELECT 1 FROM nodes WHERE id = ? AND user_id = ?", (node_id, uid)).fetchone()
    if not owns:
        return jsonify(error="Нода не найдена"), 404

    f = request.files.get("file")
    if not f or not f.filename:
        return jsonify(error="Файл не выбран"), 400

    safe = secure_filename(f.filename) or "file"
    stored = f"{uuid.uuid4().hex}_{safe}"
    f.save(os.path.join(UPLOAD_DIR, stored))
    size = os.path.getsize(os.path.join(UPLOAD_DIR, stored))

    cur = db.execute(
        """INSERT INTO node_files (node_id, user_id, filename, stored_name, mime, size, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (node_id, uid, safe, stored, f.mimetype, size, now()),
    )
    db.commit()
    row = db.execute("SELECT * FROM node_files WHERE id = ?", (cur.lastrowid,)).fetchone()
    return jsonify(file=file_to_dict(row)), 201


@app.get("/api/files/<int:file_id>")
@login_required
def api_files_download(file_id):
    uid = session["user_id"]
    row = get_db().execute(
        "SELECT * FROM node_files WHERE id = ? AND user_id = ?", (file_id, uid)
    ).fetchone()
    if row is None:
        abort(404)
    return send_from_directory(UPLOAD_DIR, row["stored_name"], as_attachment=True,
                                download_name=row["filename"])


@app.delete("/api/files/<int:file_id>")
@login_required
def api_files_delete(file_id):
    uid = session["user_id"]
    db = get_db()
    row = db.execute("SELECT * FROM node_files WHERE id = ? AND user_id = ?", (file_id, uid)).fetchone()
    if row is None:
        return jsonify(error="Файл не найден"), 404
    db.execute("DELETE FROM node_files WHERE id = ? AND user_id = ?", (file_id, uid))
    db.commit()
    try:
        os.remove(os.path.join(UPLOAD_DIR, row["stored_name"]))
    except OSError:
        pass
    return jsonify(ok=True)


# ---------------------------------------------------------------------------
# Nodes API
# ---------------------------------------------------------------------------
def node_members(db, node_id):
    rows = db.execute(
        """SELECT u.id, u.username FROM node_members m
           JOIN users u ON u.id = m.user_id
           WHERE m.node_id = ? ORDER BY u.username""",
        (node_id,),
    ).fetchall()
    return [{"id": r["id"], "username": r["username"]} for r in rows]


def set_node_members(db, node_id, user_ids):
    ids = {int(i) for i in user_ids if str(i).lstrip("-").isdigit()}
    db.execute("DELETE FROM node_members WHERE node_id = ?", (node_id,))
    for uid in ids:
        if db.execute("SELECT 1 FROM users WHERE id = ?", (uid,)).fetchone():
            db.execute(
                "INSERT OR IGNORE INTO node_members (node_id, user_id, created_at) VALUES (?, ?, ?)",
                (node_id, uid, now()),
            )


def node_to_dict(r, db=None):
    db = db or get_db()
    return {
        "id": r["id"],
        "parent_id": r["parent_id"],
        "zone_id": r["zone_id"],
        "title": r["title"],
        "content": r["content"],
        "x": r["x"],
        "y": r["y"],
        "color": r["color"],
        "width": r["width"],
        "height": r["height"],
        "is_root": bool(r["is_root"]),
        "members": node_members(db, r["id"]),
        "files": node_files(db, r["id"]),
    }


def opt_size(value, current):
    """Validate an optional size (px). None clears it back to auto."""
    if value is None:
        return None
    try:
        v = float(value)
    except (TypeError, ValueError):
        return current
    return max(60.0, min(2000.0, v))


def valid_zone_id(db, uid, zone_id, fallback):
    if zone_id is None:
        return None
    row = db.execute("SELECT 1 FROM zones WHERE id = ? AND user_id = ?", (zone_id, uid)).fetchone()
    return zone_id if row else fallback


@app.get("/api/nodes")
@login_required
def api_nodes_list():
    uid = session["user_id"]
    rows = get_db().execute(
        "SELECT * FROM nodes WHERE user_id = ? ORDER BY id", (uid,)
    ).fetchall()
    return jsonify(nodes=[node_to_dict(r) for r in rows])


@app.post("/api/nodes")
@login_required
def api_nodes_create():
    uid = session["user_id"]
    data = request.get_json(silent=True) or {}
    db = get_db()

    parent_id = data.get("parent_id")
    is_root = bool(data.get("is_root")) and parent_id is None
    if parent_id is not None:
        owns = db.execute(
            "SELECT 1 FROM nodes WHERE id = ? AND user_id = ?", (parent_id, uid)
        ).fetchone()
        if not owns:
            return jsonify(error="Родительская нода не найдена"), 404

    zone_id = valid_zone_id(db, uid, data.get("zone_id"), None)
    default_title = "Новая материнская нода" if is_root else "Новая нода"

    cur = db.execute(
        """INSERT INTO nodes (user_id, parent_id, zone_id, title, content, x, y, color, is_root,
                               created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            uid,
            parent_id,
            zone_id,
            (data.get("title") or default_title)[:200],
            data.get("content") or "",
            float(data.get("x") or 0),
            float(data.get("y") or 0),
            data.get("color") or "#6366f1",
            1 if is_root else 0,
            now(),
            now(),
        ),
    )
    db.commit()
    row = db.execute("SELECT * FROM nodes WHERE id = ?", (cur.lastrowid,)).fetchone()
    return jsonify(node=node_to_dict(row)), 201


@app.put("/api/nodes/<int:node_id>")
@login_required
def api_nodes_update(node_id):
    uid = session["user_id"]
    db = get_db()
    row = db.execute(
        "SELECT * FROM nodes WHERE id = ? AND user_id = ?", (node_id, uid)
    ).fetchone()
    if row is None:
        return jsonify(error="Нода не найдена"), 404

    data = request.get_json(silent=True) or {}
    fields = {
        "title": data.get("title", row["title"]),
        "content": data.get("content", row["content"]),
        "x": data.get("x", row["x"]),
        "y": data.get("y", row["y"]),
        "color": data.get("color", row["color"]),
        "width": opt_size(data.get("width"), row["width"]) if "width" in data else row["width"],
        "height": opt_size(data.get("height"), row["height"]) if "height" in data else row["height"],
        "zone_id": valid_zone_id(db, uid, data.get("zone_id"), row["zone_id"]) if "zone_id" in data else row["zone_id"],
    }
    db.execute(
        """UPDATE nodes SET title=?, content=?, x=?, y=?, color=?, width=?, height=?, zone_id=?, updated_at=?
           WHERE id=? AND user_id=?""",
        (fields["title"], fields["content"], fields["x"], fields["y"],
         fields["color"], fields["width"], fields["height"], fields["zone_id"],
         now(), node_id, uid),
    )
    if isinstance(data.get("members"), list):
        set_node_members(db, node_id, data["members"])
    db.commit()
    row = db.execute("SELECT * FROM nodes WHERE id = ?", (node_id,)).fetchone()
    return jsonify(node=node_to_dict(row))


@app.delete("/api/nodes/<int:node_id>")
@login_required
def api_nodes_delete(node_id):
    uid = session["user_id"]
    db = get_db()
    row = db.execute(
        "SELECT * FROM nodes WHERE id = ? AND user_id = ?", (node_id, uid)
    ).fetchone()
    if row is None:
        return jsonify(error="Нода не найдена"), 404
    if row["is_root"]:
        root_count = db.execute(
            "SELECT COUNT(*) c FROM nodes WHERE user_id = ? AND is_root = 1", (uid,)
        ).fetchone()["c"]
        if root_count <= 1:
            return jsonify(error="Нельзя удалить последнюю материнскую ноду"), 400
    # ON DELETE CASCADE removes descendants automatically.
    db.execute("DELETE FROM nodes WHERE id = ? AND user_id = ?", (node_id, uid))
    db.commit()
    return jsonify(ok=True)


@app.get("/api/nodes/<int:node_id>/export")
@login_required
def api_nodes_export(node_id):
    uid = session["user_id"]
    db = get_db()
    root = db.execute("SELECT 1 FROM nodes WHERE id = ? AND user_id = ?", (node_id, uid)).fetchone()
    if root is None:
        return jsonify(error="Нода не найдена"), 404

    rows = db.execute(
        """WITH RECURSIVE sub(id) AS (
             SELECT id FROM nodes WHERE id = ? AND user_id = ?
             UNION ALL
             SELECT n.id FROM nodes n JOIN sub s ON n.parent_id = s.id
           )
           SELECT * FROM nodes WHERE id IN (SELECT id FROM sub) ORDER BY id""",
        (node_id, uid),
    ).fetchall()
    ids = {r["id"] for r in rows}

    links = db.execute("SELECT * FROM node_links WHERE user_id = ?", (uid,)).fetchall()
    branch_links = [
        {"from_id": l["from_id"], "to_id": l["to_id"]}
        for l in links if l["from_id"] in ids and l["to_id"] in ids
    ]

    return jsonify(
        exported_at=now(),
        root_id=node_id,
        nodes=[node_to_dict(r, db) for r in rows],
        links=branch_links,
    )


if __name__ == "__main__":
    init_db()
    port = int(os.environ.get("PORT", 5000))
    app.run(host="127.0.0.1", port=port, debug=True)
