"""SQLite store: sources, clips, posts, metrics, money, events."""
import json
import sqlite3
from datetime import datetime, timezone

from . import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY, path TEXT NOT NULL, title TEXT, creator TEXT, creator_handle TEXT,
  rights TEXT NOT NULL, rights_proof TEXT, duration REAL, status TEXT DEFAULT 'new',
  created_at TEXT);
CREATE TABLE IF NOT EXISTS clips (
  id INTEGER PRIMARY KEY, source_id INTEGER REFERENCES sources(id), start REAL, end REAL,
  score REAL, reasons TEXT, category TEXT, transcript TEXT, hook TEXT, path TEXT,
  copy_json TEXT, status TEXT DEFAULT 'detected', created_at TEXT);
-- clip status: detected -> rendered -> awaiting_approval -> approved -> scheduled -> published | rejected | failed
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY, clip_id INTEGER REFERENCES clips(id), platform TEXT, buffer_post_id TEXT,
  status TEXT, due_at TEXT, sent_at TEXT, external_link TEXT, error TEXT, test_name TEXT,
  created_at TEXT);
CREATE TABLE IF NOT EXISTS metrics (
  id INTEGER PRIMARY KEY, post_id INTEGER REFERENCES posts(id), read_at TEXT, hours_after REAL,
  views REAL, reach REAL, likes REAL, comments REAL, shares REAL, saves REAL, follows REAL,
  avg_watch_sec REAL, raw TEXT);
CREATE TABLE IF NOT EXISTS money (
  id INTEGER PRIMARY KEY, date TEXT, kind TEXT CHECK(kind IN ('revenue','cost')),
  stream TEXT, amount REAL, note TEXT, verified INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY, at TEXT, level TEXT, agent TEXT, message TEXT, data TEXT);
"""


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def connect():
    config.DATA.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(config.DB_PATH)
    con.row_factory = sqlite3.Row
    con.executescript(SCHEMA)
    # migrations
    for table, col in (("sources", "ext_project"), ("clips", "ext_id")):
        cols = {r[1] for r in con.execute(f"PRAGMA table_info({table})")}
        if col not in cols:
            con.execute(f"ALTER TABLE {table} ADD COLUMN {col} TEXT")
    con.commit()
    return con


def log(con, agent, message, level="info", **data):
    con.execute("INSERT INTO events(at,level,agent,message,data) VALUES(?,?,?,?,?)",
                (now(), level, agent, message, json.dumps(data) if data else None))
    con.commit()
    print(f"[{level}] {agent}: {message}")
