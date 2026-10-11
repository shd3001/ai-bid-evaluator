from copy import deepcopy
from .orm_models import ModelCacheRow


class ModelCache:
    def __init__(self, db):
        self.db = db

    def get(self, key):
        with self.db.read() as session:
            row = session.get(ModelCacheRow, key)
            return deepcopy(row.data) if row else None

    def __setitem__(self, key, value):
        with self.db.write() as session:
            session.merge(ModelCacheRow(cache_key=key, data=value))
