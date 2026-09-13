/**
 * The map checks.
 *
 * Every issue says what is wrong, where, and what to do about it. An issue with
 * no fix is a complaint, and a tool that complains without helping is one
 * people learn to ignore.
 */

import type { MapIssue } from '@terrasmith/core';

interface Props {
  issues?: MapIssue[];
  stale?: boolean;
  resolution?: number;
  onClose(): void;
}

export function IssuesDialog({ issues = [], stale, resolution, onClose }: Props) {
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const info = issues.filter((i) => i.severity === 'info');

  return (
    <div className="scrim" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()} style={{ width: 'min(680px, 92vw)' }}>
        <div className="dialog-head">
          <h2>Map checks</h2>
          <button className="btn ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="dialog-body" style={{ padding: 0 }}>
          {issues.length === 0 && (
            <div className="empty-note" style={{ padding: '40px 24px' }}>
              {stale ? 'Checking…' : 'Nothing to flag. The map passes every check.'}
            </div>
          )}

          {errors.length > 0 && <Group title="Problems" issues={errors} />}
          {warnings.length > 0 && <Group title="Worth a look" issues={warnings} />}
          {info.length > 0 && <Group title="Notes" issues={info} />}
        </div>

        <div className="dialog-foot">
          <span style={{ flex: 1, color: 'var(--text-3)', fontSize: 11.5 }}>
            {resolution
              ? `Checked against the ${resolution}-sample preview. The export re-checks at full resolution.`
              : ''}
          </span>
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function Group({ title, issues }: { title: string; issues: MapIssue[] }) {
  return (
    <div>
      <div className="palette-group-label" style={{ padding: '12px 14px 6px' }}>
        {title}
      </div>
      {issues.map((issue, index) => (
        <div className={`issue ${issue.severity}`} key={`${issue.code}-${index}`}>
          <span className="bullet" />
          <div>
            <div className="issue-title">{issue.title}</div>
            <div className="issue-detail">{issue.detail}</div>
            {issue.fix && <div className="issue-fix">→ {issue.fix}</div>}
            {issue.where && 'x' in issue.where && (
              <div className="issue-detail" style={{ marginTop: 3, fontFamily: 'var(--mono)' }}>
                at {Math.round(issue.where.x)}, {Math.round(issue.where.z)}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
