"""Frozen initial SQLite schema. Never import mutable runtime ORM metadata."""
from alembic import op
revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade():
    op.execute('\nCREATE TABLE companies (\n\tcompany_id VARCHAR NOT NULL, \n\tdata JSON NOT NULL, \n\tPRIMARY KEY (company_id)\n)\n\n')
    op.execute('\nCREATE TABLE idempotency_keys (\n\tscope VARCHAR NOT NULL, \n\t"key" VARCHAR NOT NULL, \n\trequest_hash VARCHAR NOT NULL, \n\tresponse JSON NOT NULL, \n\tPRIMARY KEY (scope, "key")\n)\n\n')
    op.execute('\nCREATE TABLE model_cache (\n\tcache_key VARCHAR NOT NULL, \n\tdata JSON NOT NULL, \n\tPRIMARY KEY (cache_key)\n)\n\n')
    op.execute('\nCREATE TABLE notices (\n\tnotice_id VARCHAR NOT NULL, \n\tdata JSON NOT NULL, \n\tPRIMARY KEY (notice_id)\n)\n\n')
    op.execute('\nCREATE TABLE projects (\n\tproject_id VARCHAR NOT NULL, \n\tname VARCHAR NOT NULL, \n\tPRIMARY KEY (project_id)\n)\n\n')
    op.execute('\nCREATE TABLE bidders (\n\tbidder_id VARCHAR NOT NULL, \n\tproject_id VARCHAR NOT NULL, \n\tname VARCHAR NOT NULL, \n\tPRIMARY KEY (bidder_id), \n\tFOREIGN KEY(project_id) REFERENCES projects (project_id)\n)\n\n')
    op.execute('\nCREATE TABLE notice_sources (\n\tsource_id INTEGER NOT NULL, \n\tnotice_id VARCHAR NOT NULL, \n\tdata JSON NOT NULL, \n\tPRIMARY KEY (source_id), \n\tFOREIGN KEY(notice_id) REFERENCES notices (notice_id)\n)\n\n')
    op.execute('\nCREATE TABLE runs (\n\trun_id VARCHAR NOT NULL, \n\tproject_id VARCHAR NOT NULL, \n\ttype VARCHAR NOT NULL, \n\tstatus VARCHAR NOT NULL, \n\towner VARCHAR, \n\tlease_until FLOAT, \n\tdata JSON NOT NULL, \n\tPRIMARY KEY (run_id), \n\tFOREIGN KEY(project_id) REFERENCES projects (project_id)\n)\n\n')
    op.execute('CREATE INDEX ix_runs_project_id ON runs (project_id)')
    op.execute('CREATE INDEX ix_runs_status ON runs (status)')
    op.execute('\nCREATE TABLE audit_events (\n\taudit_id INTEGER NOT NULL, \n\trun_id VARCHAR NOT NULL, \n\tdata JSON NOT NULL, \n\tPRIMARY KEY (audit_id), \n\tFOREIGN KEY(run_id) REFERENCES runs (run_id)\n)\n\n')
    op.execute('CREATE INDEX ix_audit_events_run_id ON audit_events (run_id)')
    op.execute('\nCREATE TABLE documents (\n\tdocument_id VARCHAR NOT NULL, \n\tproject_id VARCHAR NOT NULL, \n\tbidder_id VARCHAR, \n\trole VARCHAR NOT NULL, \n\tdata JSON NOT NULL, \n\tPRIMARY KEY (document_id), \n\tFOREIGN KEY(project_id) REFERENCES projects (project_id), \n\tFOREIGN KEY(bidder_id) REFERENCES bidders (bidder_id)\n)\n\n')
    op.execute('\nCREATE TABLE evaluations (\n\tevaluation_id INTEGER NOT NULL, \n\trun_id VARCHAR NOT NULL, \n\trevision INTEGER NOT NULL, \n\tdata JSON NOT NULL, \n\tPRIMARY KEY (evaluation_id), \n\tFOREIGN KEY(run_id) REFERENCES runs (run_id)\n)\n\n')
    op.execute('CREATE INDEX ix_evaluations_run_id ON evaluations (run_id)')
    op.execute('\nCREATE TABLE reports (\n\treport_id INTEGER NOT NULL, \n\trun_id VARCHAR NOT NULL, \n\trevision INTEGER NOT NULL, \n\tstale BOOLEAN NOT NULL, \n\tdata JSON NOT NULL, \n\tPRIMARY KEY (report_id), \n\tFOREIGN KEY(run_id) REFERENCES runs (run_id)\n)\n\n')
    op.execute('CREATE INDEX ix_reports_run_id ON reports (run_id)')
    op.execute('\nCREATE TABLE reviews (\n\treview_id INTEGER NOT NULL, \n\trun_id VARCHAR NOT NULL, \n\tdata JSON NOT NULL, \n\tPRIMARY KEY (review_id), \n\tFOREIGN KEY(run_id) REFERENCES runs (run_id)\n)\n\n')
    op.execute('CREATE INDEX ix_reviews_run_id ON reviews (run_id)')
    op.execute('\nCREATE TABLE run_events (\n\tseq INTEGER NOT NULL, \n\trun_id VARCHAR NOT NULL, \n\tdata JSON NOT NULL, \n\tPRIMARY KEY (seq), \n\tFOREIGN KEY(run_id) REFERENCES runs (run_id)\n)\n\n')
    op.execute('CREATE INDEX ix_run_events_run_id ON run_events (run_id)')
    op.execute('\nCREATE TABLE run_steps (\n\tstep_id INTEGER NOT NULL, \n\trun_id VARCHAR NOT NULL, \n\tname VARCHAR NOT NULL, \n\tdata JSON NOT NULL, \n\tPRIMARY KEY (step_id), \n\tUNIQUE (run_id, name), \n\tFOREIGN KEY(run_id) REFERENCES runs (run_id)\n)\n\n')
    op.execute('CREATE INDEX ix_run_steps_run_id ON run_steps (run_id)')
    op.execute('\nCREATE TABLE document_chunks (\n\tchunk_id VARCHAR NOT NULL, \n\tdocument_id VARCHAR NOT NULL, \n\tdata JSON NOT NULL, \n\tPRIMARY KEY (chunk_id), \n\tFOREIGN KEY(document_id) REFERENCES documents (document_id)\n)\n\n')


def downgrade():
    op.execute('DROP TABLE document_chunks')
    op.execute('DROP TABLE run_steps')
    op.execute('DROP TABLE run_events')
    op.execute('DROP TABLE reviews')
    op.execute('DROP TABLE reports')
    op.execute('DROP TABLE evaluations')
    op.execute('DROP TABLE documents')
    op.execute('DROP TABLE audit_events')
    op.execute('DROP TABLE runs')
    op.execute('DROP TABLE notice_sources')
    op.execute('DROP TABLE bidders')
    op.execute('DROP TABLE projects')
    op.execute('DROP TABLE notices')
    op.execute('DROP TABLE model_cache')
    op.execute('DROP TABLE idempotency_keys')
    op.execute('DROP TABLE companies')
