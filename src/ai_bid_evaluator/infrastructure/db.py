from contextlib import contextmanager
from pathlib import Path
import time
from sqlalchemy import create_engine, event, text
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool


class Database:
    def __init__(self, url: str):
        if not url.startswith("sqlite:"):
            raise ValueError("首版只支持本机 SQLite")
        self.url = url
        kwargs = {"connect_args": {"check_same_thread": False, "timeout": 2}}
        if url in {"sqlite://", "sqlite:///:memory:"}:
            kwargs["poolclass"] = StaticPool
        self.engine = create_engine(url, **kwargs)
        self.closed = False

        @event.listens_for(self.engine, "connect")
        def configure(connection, _):
            cursor = connection.cursor()
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.execute("PRAGMA journal_mode=WAL")
            cursor.execute("PRAGMA busy_timeout=2000")
            cursor.close()

    def migrate(self):
        from alembic import command
        from alembic.config import Config
        config = Config()
        config.set_main_option("script_location", str(Path(__file__).resolve().parent / "migrations"))
        with self.engine.connect() as connection:
            config.attributes["connection"] = connection
            command.upgrade(config, "head")

    @contextmanager
    def read(self):
        with Session(self.engine, expire_on_commit=False) as session:
            yield session

    @contextmanager
    def write(self):
        with Session(self.engine, expire_on_commit=False) as session:
            for attempt in range(3):
                try:
                    session.execute(text("BEGIN IMMEDIATE"))
                    break
                except OperationalError as exc:
                    session.rollback()
                    if "locked" not in str(exc).lower() or attempt == 2:
                        raise
                    time.sleep(0.05 * (attempt + 1))
            try:
                yield session
                session.commit()
            except BaseException:
                session.rollback()
                raise

    def ready(self):
        with self.read() as session:
            session.execute(text("SELECT run_id FROM runs LIMIT 1"))
            return True

    def close(self):
        self.engine.dispose()
        self.closed = True
