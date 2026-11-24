
-- PTO Info Daily
-- Migration 0002: Editorial review workflow
-- Preserves existing articles and author records.

-- Track the editorial review stage separately from publication status.
ALTER TABLE articles
ADD COLUMN review_status TEXT NOT NULL DEFAULT 'draft'
CHECK (
  review_status IN (
    'draft',
    'submitted',
    'changes_requested',
    'approved'
  )
);

-- Record when an article was submitted for review.
ALTER TABLE articles
ADD COLUMN submitted_at TEXT;

-- Record when an article was last reviewed.
ALTER TABLE articles
ADD COLUMN reviewed_at TEXT;

-- Record the editor or administrator who reviewed the article.
ALTER TABLE articles
ADD COLUMN reviewer_id TEXT REFERENCES authors(id);

-- Existing published articles are treated as approved.
UPDATE articles
SET review_status = 'approved',
    reviewed_at = COALESCE(published_at, updated_at)
WHERE status = 'published';

-- Improve article filtering for editorial operations.
CREATE INDEX IF NOT EXISTS idx_articles_review_status
ON articles(review_status);

CREATE INDEX IF NOT EXISTS idx_articles_status_review
ON articles(status, review_status);

CREATE INDEX IF NOT EXISTS idx_articles_author_review
ON articles(author_id, review_status);
