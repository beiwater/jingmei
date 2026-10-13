CREATE TABLE IF NOT EXISTS instances (
	instance TEXT PRIMARY KEY,
	first_seen INTEGER NOT NULL,
	last_seen INTEGER NOT NULL,
	version TEXT NOT NULL,
	bun TEXT NOT NULL,
	os TEXT NOT NULL,
	arch TEXT NOT NULL,
	platforms TEXT NOT NULL,
	personas TEXT NOT NULL,
	spaces TEXT NOT NULL,
	features TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS instances_last_seen ON instances (last_seen);
