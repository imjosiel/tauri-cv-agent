use rusqlite::{Connection, Result, params};
use crate::{JobListing, NightReport};
use chrono::Local;

pub struct Database {
    conn: Connection,
}

impl Database {
    pub fn new() -> Result<Self> {
        let path = dirs_next::data_dir()
            .unwrap_or_default()
            .join("cv-agent")
            .join("cvagent.db");

        std::fs::create_dir_all(path.parent().unwrap()).ok();
        let conn = Connection::open(path)?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
        Ok(Self { conn })
    }

    pub fn migrate(&self) -> Result<()> {
        self.conn.execute_batch("
            CREATE TABLE IF NOT EXISTS jobs (
                id              TEXT PRIMARY KEY,
                title           TEXT NOT NULL,
                company         TEXT NOT NULL,
                url             TEXT NOT NULL,
                site            TEXT NOT NULL,
                description     TEXT,
                score           INTEGER,
                status          TEXT NOT NULL DEFAULT 'found',
                applied_at      TEXT,
                resume_path     TEXT,
                skip_reason     TEXT,
                screenshot_path TEXT,
                created_at      TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS night_sessions (
                id          TEXT PRIMARY KEY,
                date        TEXT NOT NULL,
                config      TEXT NOT NULL,
                started_at  TEXT NOT NULL,
                finished_at TEXT,
                summary     TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
            CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at);
        ")?;
        Ok(())
    }

    pub fn upsert_job(&self, job: &JobListing) -> Result<()> {
        self.conn.execute(
            "INSERT INTO jobs (id, title, company, url, site, description, score, status,
                              applied_at, resume_path, skip_reason, screenshot_path)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
             ON CONFLICT(id) DO UPDATE SET
                score=excluded.score, status=excluded.status,
                applied_at=excluded.applied_at, resume_path=excluded.resume_path,
                skip_reason=excluded.skip_reason, screenshot_path=excluded.screenshot_path",
            params![
                job.id, job.title, job.company, job.url, job.site,
                job.description, job.score, job.status, job.applied_at,
                job.resume_path, job.skip_reason, job.screenshot_path
            ],
        )?;
        Ok(())
    }

    pub fn update_job_status(
        &self, id: &str, status: &str,
        reason: Option<&str>, resume_path: Option<&str>,
        screenshot: Option<&str>,
    ) -> Result<()> {
        let applied_at = if status == "applied" {
            Some(Local::now().to_rfc3339())
        } else {
            None
        };
        self.conn.execute(
            "UPDATE jobs SET status=?1, skip_reason=?2, resume_path=?3,
                            screenshot_path=?4, applied_at=?5
             WHERE id=?6",
            params![status, reason, resume_path, screenshot, applied_at, id],
        )?;
        Ok(())
    }

    pub fn get_jobs(
        &self,
        limit: Option<i64>,
        status: Option<String>,
    ) -> Result<Vec<JobListing>> {
        let lim = limit.unwrap_or(100);
        let mut stmt = match &status {
            Some(s) => {
                let mut st = self.conn.prepare(
                    "SELECT id,title,company,url,site,description,score,status,
                            applied_at,resume_path,skip_reason,screenshot_path
                     FROM jobs WHERE status=?1 ORDER BY created_at DESC LIMIT ?2"
                )?;
                let rows = st.query_map(params![s, lim], map_row)?;
                return rows.collect();
            }
            None => self.conn.prepare(
                "SELECT id,title,company,url,site,description,score,status,
                        applied_at,resume_path,skip_reason,screenshot_path
                 FROM jobs ORDER BY created_at DESC LIMIT ?1"
            )?,
        };
        let rows = stmt.query_map(params![lim], map_row)?;
        rows.collect()
    }

    pub fn get_report(&self, date: Option<String>) -> Result<NightReport> {
        let d = date.unwrap_or_else(|| Local::now().format("%Y-%m-%d").to_string());
        let where_clause = format!("WHERE date(created_at)='{}'", d);

        let count = |status: &str| -> usize {
            self.conn
                .query_row(
                    &format!("SELECT COUNT(*) FROM jobs {} AND status=?1", where_clause),
                    params![status],
                    |r| r.get::<_, i64>(0),
                )
                .unwrap_or(0) as usize
        };

        let jobs = self.get_jobs(Some(200), None)?;
        let today_jobs: Vec<_> = jobs
            .into_iter()
            .filter(|j| j.applied_at.as_deref().unwrap_or("").starts_with(&d))
            .collect();

        Ok(NightReport {
            date: d,
            found: count("found") + count("analyzed") + count("applied")
                + count("skipped") + count("captcha") + count("error"),
            analyzed: count("analyzed") + count("applied"),
            applied: count("applied"),
            skipped_score: count("skipped"),
            skipped_captcha: count("captcha"),
            skipped_error: count("error"),
            jobs: today_jobs,
        })
    }
}

fn map_row(row: &rusqlite::Row) -> rusqlite::Result<JobListing> {
    Ok(JobListing {
        id: row.get(0)?,
        title: row.get(1)?,
        company: row.get(2)?,
        url: row.get(3)?,
        site: row.get(4)?,
        description: row.get(5).unwrap_or_default(),
        score: row.get(6)?,
        status: row.get(7)?,
        applied_at: row.get(8)?,
        resume_path: row.get(9)?,
        skip_reason: row.get(10)?,
        screenshot_path: row.get(11)?,
    })
}
