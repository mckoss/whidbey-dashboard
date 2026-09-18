// On-disk issue store.
//
// Invariant: the live issue directory is only ever replaced by a *complete*
// staged issue. A failed or empty harvest can never blank the kiosk — the
// previous issue stays exactly as it was, and the failure is recorded in
// state.json so the UI can show it.

import { createHash } from 'crypto';
import { existsSync } from 'fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { writeFileAtomic } from './images.js';

export const STATE_VERSION = 1;

export class IssueStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.issuesDir = join(dataDir, 'issues');
    this.stateFile = join(dataDir, 'state.json');
    this.cacheFile = join(dataDir, 'condense-cache.json');
  }

  async init() {
    await mkdir(this.issuesDir, { recursive: true });
    return this;
  }

  async readState() {
    try {
      const parsed = JSON.parse(await readFile(this.stateFile, 'utf8'));
      return { version: STATE_VERSION, ...parsed };
    } catch {
      return {
        version: STATE_VERSION,
        currentIssueId: '',
        lastRunAt: null,
        lastSuccessAt: null,
        lastStatus: 'never-run',
        lastError: null,
      };
    }
  }

  async writeState(patch) {
    const state = { ...(await this.readState()), ...patch, version: STATE_VERSION };
    await mkdir(this.dataDir, { recursive: true });
    await writeFile(this.stateFile, `${JSON.stringify(state, null, 2)}\n`);
    return state;
  }

  async recordError(code, message, extra = {}) {
    return this.writeState({
      lastRunAt: new Date().toISOString(),
      lastStatus: 'error',
      lastError: { code, message, at: new Date().toISOString(), ...extra },
    });
  }

  async recordSuccess(issueId, extra = {}) {
    const now = new Date().toISOString();
    return this.writeState({
      currentIssueId: issueId,
      lastRunAt: now,
      lastSuccessAt: now,
      lastStatus: 'ok',
      lastError: null,
      ...extra,
    });
  }

  issueDir(issueId) {
    return join(this.issuesDir, issueId);
  }

  async listIssues() {
    try {
      const entries = await readdir(this.issuesDir, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name);
    } catch {
      return [];
    }
  }

  async readManifest(issueId) {
    if (!issueId) return null;
    try {
      return JSON.parse(await readFile(join(this.issueDir(issueId), 'manifest.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  async currentManifest() {
    const state = await this.readState();
    const byState = await this.readManifest(state.currentIssueId);
    if (byState) return byState;
    // Self-heal if state.json was lost but an issue is on disk.
    const issues = (await this.listIssues()).sort();
    for (const issueId of issues.reverse()) {
      const manifest = await this.readManifest(issueId);
      if (manifest) return manifest;
    }
    return null;
  }

  // ── Staging ────────────────────────────────────────────────────────────────

  async beginIssue(issueId) {
    const dir = join(this.dataDir, 'staging', `${issueId}-${process.pid}`);
    await rm(dir, { recursive: true, force: true });
    await mkdir(join(dir, 'images'), { recursive: true });
    return new StagedIssue(this, issueId, dir);
  }

  async pruneOtherIssues(keepIssueId) {
    const removed = [];
    for (const issueId of await this.listIssues()) {
      if (issueId === keepIssueId) continue;
      await rm(this.issueDir(issueId), { recursive: true, force: true });
      removed.push(issueId);
    }
    await rm(join(this.dataDir, 'staging'), { recursive: true, force: true });
    return removed;
  }

  // ── Caption condensing cache ───────────────────────────────────────────────

  static cacheKey(input) {
    return createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 32);
  }

  async readCache() {
    try {
      return JSON.parse(await readFile(this.cacheFile, 'utf8'));
    } catch {
      return {};
    }
  }

  async writeCache(cache) {
    await mkdir(this.dataDir, { recursive: true });
    await writeFile(this.cacheFile, `${JSON.stringify(cache, null, 2)}\n`);
  }
}

export class StagedIssue {
  constructor(store, issueId, dir) {
    this.store = store;
    this.issueId = issueId;
    this.dir = dir;
    this.slides = [];
  }

  async addImage(filename, buffer) {
    const path = join(this.dir, 'images', filename);
    const bytes = await writeFileAtomic(path, buffer);
    return { filename, bytes };
  }

  addSlide(slide) {
    this.slides.push(slide);
    return slide;
  }

  async commit(meta = {}) {
    if (!this.slides.length) {
      throw new Error('refusing to commit an issue with zero slides');
    }
    const manifest = {
      issueId: this.issueId,
      harvestedAt: new Date().toISOString(),
      slideCount: this.slides.length,
      ...meta,
      slides: this.slides,
    };
    await writeFile(join(this.dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

    const target = this.store.issueDir(this.issueId);
    const retired = `${target}.retiring-${process.pid}`;
    if (existsSync(target)) await rename(target, retired);
    try {
      await mkdir(this.store.issuesDir, { recursive: true });
      await rename(this.dir, target);
    } catch (err) {
      // Put the old issue back rather than leave the kiosk with nothing.
      if (existsSync(retired)) await rename(retired, target);
      throw err;
    }
    await rm(retired, { recursive: true, force: true });
    const removed = await this.store.pruneOtherIssues(this.issueId);
    await this.store.recordSuccess(this.issueId, {
      issueLabel: meta.issueLabel || '',
      slideCount: this.slides.length,
      removedIssues: removed,
    });
    return manifest;
  }

  async abort() {
    await rm(this.dir, { recursive: true, force: true });
  }
}

export default IssueStore;
