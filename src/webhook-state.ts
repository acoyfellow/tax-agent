import { DurableObject } from 'cloudflare:workers';
import type { Env } from './types';

interface SubmissionRecord {
  submissionId: string;
  status: string;
  formType: string;
  createdAt: string;
  updatedAt: string;
  records: string; // JSON stringified
}

export class WebhookState extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS submissions (
        submission_id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'CREATED',
        form_type TEXT NOT NULL DEFAULT 'FORM1099NEC',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        records TEXT NOT NULL DEFAULT '[]'
      )
    `);
  }

  async trackSubmission(submissionId: string, formType: string = 'FORM1099NEC'): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO submissions (submission_id, form_type) VALUES (?, ?)`,
      submissionId,
      formType,
    );
  }

  async updateStatus(submissionId: string, status: string, records: string): Promise<void> {
    this.ctx.storage.sql.exec(
      `UPDATE submissions SET status = ?, records = ?, updated_at = datetime('now') WHERE submission_id = ?`,
      status,
      records,
      submissionId,
    );
  }

  async getSubmission(submissionId: string): Promise<SubmissionRecord | null> {
    const cursor = this.ctx.storage.sql.exec(
      `SELECT * FROM submissions WHERE submission_id = ?`,
      submissionId,
    );
    const rows = [...cursor];
    if (rows.length === 0) return null;
    const row = rows[0] as Record<string, string>;
    return {
      submissionId: row['submission_id'] ?? '',
      status: row['status'] ?? '',
      formType: row['form_type'] ?? '',
      createdAt: row['created_at'] ?? '',
      updatedAt: row['updated_at'] ?? '',
      records: row['records'] ?? '[]',
    };
  }

  async listSubmissions(limit: number = 50): Promise<SubmissionRecord[]> {
    const cursor = this.ctx.storage.sql.exec(
      `SELECT * FROM submissions ORDER BY updated_at DESC LIMIT ?`,
      limit,
    );
    return [...cursor].map((row) => {
      const r = row as Record<string, string>;
      return {
        submissionId: r['submission_id'] ?? '',
        status: r['status'] ?? '',
        formType: r['form_type'] ?? '',
        createdAt: r['created_at'] ?? '',
        updatedAt: r['updated_at'] ?? '',
        records: r['records'] ?? '[]',
      };
    });
  }
}
