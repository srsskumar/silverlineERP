import { describe, expect, it } from 'vitest';
import {
  avatarHue,
  checklistProgress,
  columnColor,
  dueState,
  initialsOf,
  isDoneLike,
  priorityPips,
  priorityTone,
  relativeTime,
  shortRef,
  statusHue,
  statusLabel,
} from '../lib/board-visuals';

describe('statusHue', () => {
  it('gives each standard stage its own identity', () => {
    expect(statusHue('TO_DO')).toBe('todo');
    expect(statusHue('IN_PROGRESS')).toBe('progress');
    expect(statusHue('IN_REVIEW')).toBe('review');
    expect(statusHue('DONE')).toBe('done');
    expect(statusHue('BLOCKED')).toBe('blocked');
  });

  it('falls back to neutral for a project-defined status', () => {
    // Projects can add statuses through the workflow editor; an unknown code
    // must not borrow a meaning (green = good) it has not earned.
    expect(statusHue('QUALITY_CHECK')).toBe('review');
    expect(statusHue('AWAITING_PERMIT')).toBe('neutral');
    expect(statusHue('')).toBe('neutral');
  });

  it('is case-insensitive', () => {
    expect(statusHue('in_progress')).toBe('progress');
  });
});

describe('columnColor', () => {
  it('uses the board-configured colour when the column sets one', () => {
    expect(columnColor('TO_DO', '#ff00aa')).toBe('#ff00aa');
  });

  it('falls back to the status token otherwise', () => {
    expect(columnColor('TO_DO', null)).toBe('hsl(var(--status-todo))');
    expect(columnColor('TO_DO', '   ')).toBe('hsl(var(--status-todo))');
  });
});

describe('isDoneLike', () => {
  it('treats every terminal status as settled', () => {
    expect(isDoneLike('DONE')).toBe(true);
    expect(isDoneLike('CANCELLED')).toBe(true);
    expect(isDoneLike('CLOSED')).toBe(true);
    expect(isDoneLike('IN_PROGRESS')).toBe(false);
    expect(isDoneLike('BLOCKED')).toBe(false);
  });
});

describe('statusLabel', () => {
  it('reads as prose, not as a constant', () => {
    expect(statusLabel('IN_PROGRESS')).toBe('In progress');
    expect(statusLabel('TO_DO')).toBe('To do');
    expect(statusLabel('')).toBe('');
  });
});

describe('initialsOf', () => {
  it('takes first and last initials from a display name', () => {
    expect(initialsOf('Thota Dheeraj')).toBe('TD');
  });

  it('splits usernames on their separators', () => {
    expect(initialsOf('employee.one')).toBe('EO');
    expect(initialsOf('user_slv001_3')).toBe('U3');
  });

  it('degrades to two characters for a single token', () => {
    expect(initialsOf('admin')).toBe('AD');
  });

  it('marks an empty label rather than rendering a blank circle', () => {
    expect(initialsOf('')).toBe('—');
    expect(initialsOf(null)).toBe('—');
  });
});

describe('avatarHue', () => {
  it('is stable for the same id', () => {
    expect(avatarHue('abc-123')).toBe(avatarHue('abc-123'));
  });

  it('stays inside the colour wheel', () => {
    for (const seed of ['', 'a', 'user_slv001_49', '9f3b2c11-0000-4000-8000-000000000000']) {
      const hue = avatarHue(seed);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });

  it('separates different people', () => {
    expect(avatarHue('user_one')).not.toBe(avatarHue('user_two'));
  });
});

describe('shortRef', () => {
  it('shortens a uuid to a scannable reference', () => {
    expect(shortRef('69a9fa3f-1c2d-4e5f-8a9b-0c1d2e3f4a5b')).toBe('69A9FA');
  });

  it('is empty rather than misleading when there is no id', () => {
    expect(shortRef(null)).toBe('');
  });
});

describe('relativeTime', () => {
  const now = new Date('2026-09-14T12:00:00.000Z');

  it('describes ages the way a board is read', () => {
    expect(relativeTime('2026-09-14T11:59:30.000Z', now)).toBe('just now');
    expect(relativeTime('2026-09-14T11:30:00.000Z', now)).toBe('30 minutes ago');
    expect(relativeTime('2026-09-14T06:00:00.000Z', now)).toBe('6 hours ago');
    expect(relativeTime('2026-09-09T12:00:00.000Z', now)).toBe('5 days ago');
    expect(relativeTime('2026-06-14T12:00:00.000Z', now)).toBe('3 months ago');
    expect(relativeTime('2024-09-14T12:00:00.000Z', now)).toBe('2 years ago');
  });

  it('singularises', () => {
    expect(relativeTime('2026-09-13T12:00:00.000Z', now)).toBe('1 day ago');
    expect(relativeTime('2026-08-14T12:00:00.000Z', now)).toBe('1 month ago');
  });

  it('never renders a negative age for a clock-skewed row', () => {
    expect(relativeTime('2026-09-20T12:00:00.000Z', now)).toBe('just now');
  });

  it('is empty for a missing or unparseable timestamp', () => {
    expect(relativeTime(null, now)).toBe('');
    expect(relativeTime('not-a-date', now)).toBe('');
  });
});

describe('dueState', () => {
  const now = new Date('2026-09-14T12:00:00.000Z');

  it('flags a passed deadline on live work', () => {
    const due = dueState('2026-09-01', 'IN_PROGRESS', now);
    expect(due?.overdue).toBe(true);
  });

  it('does not call a task due today overdue', () => {
    // The deadline is a date, not an instant — 09:00 on the due date is fine.
    expect(dueState('2026-09-14', 'IN_PROGRESS', now)?.overdue).toBe(false);
  });

  it('never marks finished work overdue, however late it landed', () => {
    // The column already says it is done; re-flagging it red every time
    // someone scans the board relitigates a closed item.
    expect(dueState('2026-01-01', 'DONE', now)?.overdue).toBe(false);
    expect(dueState('2026-01-01', 'CANCELLED', now)?.overdue).toBe(false);
  });

  it('is absent when no deadline is set', () => {
    expect(dueState(null, 'IN_PROGRESS', now)).toBeNull();
    expect(dueState('nonsense', 'IN_PROGRESS', now)).toBeNull();
  });
});

describe('checklistProgress', () => {
  it('counts done items out of the total', () => {
    expect(
      checklistProgress([
        { id: '1', title: 'Toolbox talk complete', done: true },
        { id: '2', title: 'Permit to work signed', done: false },
      ]),
    ).toEqual({ done: 1, total: 2 });
  });

  it('omits the chip entirely for an empty checklist', () => {
    // "0/0" is noise on a card that is already dense.
    expect(checklistProgress([])).toBeNull();
    expect(checklistProgress(null)).toBeNull();
    expect(checklistProgress(undefined)).toBeNull();
  });

  it('tolerates the alternative key spellings and junk rows', () => {
    expect(checklistProgress([{ checked: true }, { completed: true }, null, 'x'])).toEqual({
      done: 2,
      total: 4,
    });
  });

  it('reads a wrapped { items: [...] } shape', () => {
    expect(checklistProgress({ items: [{ done: true }] })).toEqual({ done: 1, total: 1 });
  });
});

describe('priority', () => {
  it('lights pips in proportion to urgency', () => {
    expect(priorityPips('LOW')).toBe(0);
    expect(priorityPips('MEDIUM')).toBe(1);
    expect(priorityPips('HIGH')).toBe(2);
    expect(priorityPips('URGENT')).toBe(3);
    expect(priorityPips(null)).toBe(0);
    expect(priorityPips('WHATEVER')).toBe(0);
  });

  it('reserves the alarm hues for the top two', () => {
    expect(priorityTone('URGENT')).toBe('danger');
    expect(priorityTone('HIGH')).toBe('warning');
    expect(priorityTone('MEDIUM')).toBe('muted');
    expect(priorityTone(null)).toBe('muted');
  });
});
