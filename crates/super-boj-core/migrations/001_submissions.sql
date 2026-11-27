CREATE TABLE problems (
    id INTEGER PRIMARY KEY CHECK(id > 0),
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;

CREATE TABLE submission_intents (
    id TEXT PRIMARY KEY,
    account_context TEXT,
    problem_id INTEGER NOT NULL REFERENCES problems(id),
    language TEXT NOT NULL,
    source_code TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('PREPARED','AWAITING_CONFIRMATION','CONFIRMED','CANCELLED','UNVERIFIED')),
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;

CREATE INDEX intents_by_problem ON submission_intents(problem_id, account_context, status, created_at DESC);

CREATE TABLE submissions (
    id INTEGER PRIMARY KEY,
    intent_id TEXT NOT NULL UNIQUE REFERENCES submission_intents(id),
    account_context TEXT NOT NULL,
    problem_id INTEGER NOT NULL REFERENCES problems(id),
    boj_submission_id TEXT NOT NULL,
    language TEXT NOT NULL,
    source_code TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    verdict TEXT NOT NULL,
    raw_verdict TEXT,
    execution_time_ms INTEGER,
    memory_kb INTEGER,
    submitted_at TEXT,
    state TEXT NOT NULL CHECK(state IN ('SUBMITTED','JUDGING','JUDGED','UNKNOWN')),
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    revision INTEGER NOT NULL DEFAULT 1,
    UNIQUE(account_context, boj_submission_id)
) STRICT;

CREATE INDEX submissions_by_problem ON submissions(account_context, problem_id, id DESC);
CREATE INDEX submissions_by_account ON submissions(account_context, id DESC);

CREATE TRIGGER immutable_intent_source
BEFORE UPDATE OF source_code, source_hash, language, problem_id, account_context ON submission_intents
BEGIN
    SELECT RAISE(ABORT, 'immutable submission intent');
END;

CREATE TRIGGER immutable_submission_source
BEFORE UPDATE OF source_code, source_hash, language, problem_id, intent_id, account_context, boj_submission_id ON submissions
BEGIN
    SELECT RAISE(ABORT, 'immutable submission source');
END;

CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;
