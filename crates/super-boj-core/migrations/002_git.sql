CREATE TABLE repositories (
    id TEXT PRIMARY KEY,
    remote_url TEXT NOT NULL,
    branch TEXT NOT NULL,
    local_path TEXT NOT NULL,
    auto_sync INTEGER NOT NULL CHECK(auto_sync IN (0, 1)),
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
    managed_head TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(remote_url, branch)
);
CREATE UNIQUE INDEX repositories_active ON repositories(active) WHERE active = 1;

CREATE TABLE sync_jobs (
    id INTEGER PRIMARY KEY,
    submission_id INTEGER NOT NULL REFERENCES submissions(id),
    repository_id TEXT NOT NULL REFERENCES repositories(id),
    status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK(status IN ('PENDING', 'WRITING_FILES', 'COMMITTING', 'COMMITTED', 'PUSHING', 'PUSHED', 'RETRY_WAIT', 'FAILED', 'CONFLICT')),
    commit_sha TEXT,
    pushed_sha TEXT,
    pushed_at INTEGER,
    synced_revision INTEGER NOT NULL DEFAULT 0,
    working_revision INTEGER,
    working_metadata TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    next_retry_at INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(submission_id, repository_id)
);
CREATE INDEX sync_jobs_queue ON sync_jobs(repository_id, status, id);
