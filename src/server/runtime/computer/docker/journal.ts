import { createHash } from 'node:crypto';
import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import nodePath from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { ComputerActor, ComputerReceipt } from '@/types/agentComputer';

import type { ComputerDispatch } from '../provider';

export class ProviderJournalError extends Error {
  constructor(readonly code: 'BUSY' | 'UNKNOWN' | 'STALE' | 'CONFLICT' | 'INVALID' | 'MISSING') { super(`COMPUTER_PROVIDER_${code}`); }
}
export interface ProviderSession { control: ComputerActor; resourceId: string; state: 'new' | 'ready' | 'sleeping'; }
interface SessionRow { active: string | null; control: ComputerActor; resource_id: string; revision: number; session_id: string; state: ProviderSession['state']; uncertain: number; }
interface CommandRow { deadline: number; id: string; intent: string; receipt: string | null; revision: number; session_id: string; status: 'dispatched' | 'done' | 'unknown'; }
export type ReceiptLookup = { status: 'done'; receipt: ComputerReceipt } | { status: 'pending' | 'unknown' | 'missing' };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Provider-owned durable ledger. No model credentials or shell arguments are stored. */
export class ComputerProviderJournal {
  private readonly db: DatabaseSync;
  constructor(filename: string, binding: string, private readonly clock = Date.now) {
    if (filename !== ':memory:') {
      mkdirSync(nodePath.dirname(filename), { recursive: true, mode: 0o700 });
      closeSync(openSync(filename, 'a', 0o600)); chmodSync(filename, 0o600);
    }
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (session_id TEXT PRIMARY KEY, resource_id TEXT NOT NULL, state TEXT NOT NULL, control TEXT NOT NULL, revision INTEGER NOT NULL, active TEXT, uncertain INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, revision INTEGER NOT NULL, intent TEXT NOT NULL, status TEXT NOT NULL, deadline INTEGER NOT NULL, receipt TEXT);
      CREATE INDEX IF NOT EXISTS commands_session ON commands(session_id);`);
    this.db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)').run('driverBinding', binding);
    const saved = this.db.prepare('SELECT value FROM settings WHERE key=?').get('driverBinding') as { value: string };
    if (saved.value !== binding) { this.db.close(); throw new ProviderJournalError('CONFLICT'); }
  }
  private tx<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = run(); this.db.exec('COMMIT'); return result; } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private expire(session: SessionRow) {
    if (!session.active) return;
    const row = this.db.prepare('SELECT * FROM commands WHERE id=?').get(session.active) as unknown as CommandRow | undefined;
    if (!row || row.deadline <= this.clock()) {
      if (row) this.db.prepare("UPDATE commands SET status='unknown' WHERE id=? AND status='dispatched'").run(row.id);
      this.db.prepare('UPDATE sessions SET uncertain=1 WHERE session_id=?').run(session.session_id);
      session.uncertain = 1;
    }
  }
  claim(dispatch: ComputerDispatch): { cached: ComputerReceipt } | { session: ProviderSession } {
    return this.tx(() => {
      const existing = this.db.prepare('SELECT * FROM commands WHERE id=?').get(dispatch.commandId) as unknown as CommandRow | undefined;
      const intent = hash(dispatch);
      if (existing) {
        if (existing.session_id !== dispatch.sessionId || existing.revision !== dispatch.revision || existing.intent !== intent) throw new ProviderJournalError('CONFLICT');
        if (existing.status === 'done' && existing.receipt) return { cached: JSON.parse(existing.receipt) as ComputerReceipt };
        // Duplicate requests never dispatch again, even when their original lease expired.
        throw new ProviderJournalError(existing.status === 'unknown' || existing.deadline <= this.clock() ? 'UNKNOWN' : 'BUSY');
      }
      const deadline = Date.parse(dispatch.expiresAt);
      if (!Number.isFinite(deadline) || deadline <= this.clock() || deadline > this.clock() + 65000) throw new ProviderJournalError('INVALID');
      const resource = `qz-cmp-${hash(dispatch.sessionId).slice(0, 32)}`;
      let session = this.db.prepare('SELECT * FROM sessions WHERE session_id=?').get(dispatch.sessionId) as unknown as SessionRow | undefined;
      if (!session) {
        if (dispatch.command.kind !== 'ensure' || dispatch.resourceId) throw new ProviderJournalError('MISSING');
        this.db.prepare("INSERT INTO sessions VALUES(?,?,'new','agent',0,NULL,0)").run(dispatch.sessionId, resource);
        session = this.db.prepare('SELECT * FROM sessions WHERE session_id=?').get(dispatch.sessionId) as unknown as SessionRow;
      }
      this.expire(session);
      if (session.uncertain) throw new ProviderJournalError('UNKNOWN');
      if (session.active) throw new ProviderJournalError('BUSY');
      if (dispatch.revision <= session.revision) throw new ProviderJournalError('STALE');
      if (dispatch.resourceId && dispatch.resourceId !== session.resource_id) throw new ProviderJournalError('CONFLICT');
      if (dispatch.actor === 'agent' && (session.control !== 'agent' || dispatch.command.kind === 'control')) throw new ProviderJournalError('CONFLICT');
      if (['shell','browser'].includes(dispatch.command.kind) && (dispatch.actor !== session.control || session.state !== 'ready')) throw new ProviderJournalError('CONFLICT');
      if (dispatch.command.kind !== 'ensure' && session.state === 'new') throw new ProviderJournalError('CONFLICT');
      if (dispatch.command.kind === 'control' && session.state !== 'ready') throw new ProviderJournalError('CONFLICT');
      this.db.prepare("INSERT INTO commands VALUES(?,?,?,?,'dispatched',?,NULL)").run(dispatch.commandId, dispatch.sessionId, dispatch.revision, intent, deadline);
      this.db.prepare('UPDATE sessions SET revision=?,active=? WHERE session_id=?').run(dispatch.revision, dispatch.commandId, dispatch.sessionId);
      return { session: { resourceId: session.resource_id, state: session.state, control: session.control } };
    });
  }
  finish(dispatch: ComputerDispatch, receipt: ComputerReceipt) {
    this.tx(() => {
      const command = this.db.prepare('SELECT * FROM commands WHERE id=?').get(dispatch.commandId) as unknown as CommandRow;
      const session = this.db.prepare('SELECT * FROM sessions WHERE session_id=?').get(dispatch.sessionId) as unknown as SessionRow;
      if (!command || !session || session.active !== command.id || session.revision !== dispatch.revision || session.uncertain || command.status !== 'dispatched' || command.deadline <= this.clock()) throw new ProviderJournalError('UNKNOWN');
      this.db.prepare("UPDATE commands SET status='done',receipt=? WHERE id=?").run(JSON.stringify(receipt), command.id);
      this.db.prepare('UPDATE sessions SET state=?,control=?,active=NULL WHERE session_id=?').run(receipt.state, receipt.control, session.session_id);
    });
  }
  fail(dispatch: ComputerDispatch) {
    this.tx(() => {
      this.db.prepare("UPDATE commands SET status='unknown' WHERE id=? AND session_id=? AND status='dispatched'").run(dispatch.commandId, dispatch.sessionId);
      this.db.prepare('UPDATE sessions SET uncertain=1 WHERE session_id=? AND active=?').run(dispatch.sessionId, dispatch.commandId);
    });
  }
  lookup(sessionId: string, commandId: string, revision: number): ReceiptLookup {
    return this.tx(() => {
      const command = this.db.prepare('SELECT * FROM commands WHERE id=? AND session_id=? AND revision=?').get(commandId, sessionId, revision) as unknown as CommandRow | undefined;
      if (!command) return { status: 'missing' };
      const session = this.db.prepare('SELECT * FROM sessions WHERE session_id=?').get(sessionId) as unknown as SessionRow;
      if (session.revision !== revision) return { status: 'unknown' };
      if (command.status === 'done' && command.receipt) return { status: 'done', receipt: JSON.parse(command.receipt) as ComputerReceipt };
      this.expire(session);
      return { status: command.status === 'unknown' || command.deadline <= this.clock() ? 'unknown' : 'pending' };
    });
  }
  close() { this.db.close(); }
  consoleSession(identity: { sessionId:string;resourceId:string;revision:number }): ProviderSession {
    const session = this.db.prepare('SELECT * FROM sessions WHERE session_id=?').get(identity.sessionId) as unknown as SessionRow | undefined;
    if (!session || session.resource_id !== identity.resourceId) throw new ProviderJournalError('MISSING');
    if (session.revision !== identity.revision) throw new ProviderJournalError('STALE');
    if (session.active || session.uncertain || session.state !== 'ready') throw new ProviderJournalError('BUSY');
    return { resourceId:session.resource_id, state:session.state, control:session.control };
  }
}
