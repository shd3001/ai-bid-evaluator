from alembic import context
from sqlalchemy import create_engine
from ai_bid_evaluator.infrastructure.orm_models import Base

config = context.config
connection = config.attributes.get("connection")
if connection is not None:
    context.configure(connection=connection, target_metadata=Base.metadata, render_as_batch=True)
    with context.begin_transaction():
        context.run_migrations()
else:
    engine = create_engine(config.get_main_option("sqlalchemy.url"))
    with engine.begin() as connection:
        context.configure(connection=connection, target_metadata=Base.metadata, render_as_batch=True)
        with context.begin_transaction():
            context.run_migrations()
