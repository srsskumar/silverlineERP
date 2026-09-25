import { describe, expect, it } from 'vitest';
import {
  resolveLadder, validateSlabs, effectiveApprovers, createsDelegationCycle,
  nextActionableStep, canAct, requiresReapproval, overdueSteps,
  approvalPolicySchema, approvalDecisionSchema, delegationSchema,
  APPROVAL_ROLE_GRANTS, APPROVAL_STATUS_TONES, APPROVAL_STATUSES,
  type ApprovalLevel, type ApprovalStep, type Delegation,
} from './approvals.js';

/** A typical Indian procurement DoA: site → PM → finance head → director. */
const LEVELS: ApprovalLevel[] = [
  { sequence: 1, minAmount: 0, maxAmount: 50_000, approverRole: 'TEAM_LEAD', slaHours: 24 },
  { sequence: 2, minAmount: 50_000, maxAmount: 500_000, approverRole: 'PROJECT_MANAGER', slaHours: 48 },
  { sequence: 3, minAmount: 500_000, maxAmount: 2_500_000, approverRole: 'ADMIN', slaHours: 72 },
  { sequence: 4, minAmount: 2_500_000, maxAmount: null, approverRole: 'SUPER_ADMIN', slaHours: 96 },
];

const step = (over: Partial<ApprovalStep> = {}): ApprovalStep => ({
  sequence: 1, status: 'PENDING', approverRole: 'PROJECT_MANAGER', approverUserId: null, ...over,
});

describe('DoA ladder', () => {
  it('routes a small amount to the first level only', () => {
    expect(resolveLadder(LEVELS, 20_000).map(s => s.sequence)).toEqual([1]);
  });

  it('escalates through every level below in cumulative mode', () => {
    // A 6 lakh order is seen by the team lead, PM and finance head — the norm
    // for Indian procurement, not just the topmost authority.
    expect(resolveLadder(LEVELS, 600_000).map(s => s.sequence)).toEqual([1, 2, 3]);
  });

  it('routes only to the owning level in single mode', () => {
    expect(resolveLadder(LEVELS, 600_000, 'SINGLE').map(s => s.sequence)).toEqual([3]);
  });

  it('sends an amount on a slab boundary to the higher authority', () => {
    // Bands are half-open, so exactly 50,000 belongs to level 2, not level 1.
    // The conservative reading, and the one an auditor expects.
    expect(resolveLadder(LEVELS, 49_999, 'SINGLE').map(s => s.sequence)).toEqual([1]);
    expect(resolveLadder(LEVELS, 50_000, 'SINGLE').map(s => s.sequence)).toEqual([2]);
  });

  it('routes an unbounded amount to the open-ended top slab', () => {
    expect(resolveLadder(LEVELS, 99_000_000, 'SINGLE').map(s => s.sequence)).toEqual([4]);
  });

  it('routes a zero-value document to the first level', () => {
    expect(resolveLadder(LEVELS, 0).map(s => s.sequence)).toEqual([1]);
  });

  it('carries the SLA onto each step for escalation', () => {
    expect(resolveLadder(LEVELS, 600_000).map(s => s.slaHours)).toEqual([24, 48, 72]);
  });
});

describe('slab validation', () => {
  it('accepts a complete ladder', () => {
    expect(validateSlabs(LEVELS).valid).toBe(true);
  });

  it('rejects a gap that would route nothing', () => {
    const gapped: ApprovalLevel[] = [
      { sequence: 1, minAmount: 0, maxAmount: 50_000, approverRole: 'TEAM_LEAD' },
      { sequence: 2, minAmount: 75_000, maxAmount: null, approverRole: 'ADMIN' },
    ];
    const result = validateSlabs(gapped);
    expect(result.valid).toBe(false);
    expect(result.problem).toContain('route to nobody');
  });

  it('rejects overlapping slabs', () => {
    const overlapping: ApprovalLevel[] = [
      { sequence: 1, minAmount: 0, maxAmount: 100_000, approverRole: 'TEAM_LEAD' },
      { sequence: 2, minAmount: 50_000, maxAmount: null, approverRole: 'ADMIN' },
    ];
    expect(validateSlabs(overlapping).problem).toContain('overlap');
  });

  it('insists the ladder starts at zero', () => {
    const late: ApprovalLevel[] = [{ sequence: 1, minAmount: 1000, maxAmount: null, approverRole: 'ADMIN' }];
    expect(validateSlabs(late).problem).toContain('start at zero');
  });

  it('insists the top slab is open-ended', () => {
    const capped: ApprovalLevel[] = [{ sequence: 1, minAmount: 0, maxAmount: 100_000, approverRole: 'ADMIN' }];
    expect(validateSlabs(capped).problem).toContain('open-ended');
  });

  it('rejects two levels sharing a sequence', () => {
    const clashing: ApprovalLevel[] = [
      { sequence: 1, minAmount: 0, maxAmount: 50_000, approverRole: 'TEAM_LEAD' },
      { sequence: 1, minAmount: 50_000, maxAmount: null, approverRole: 'ADMIN' },
    ];
    expect(validateSlabs(clashing).problem).toContain('sequence');
  });

  it('rejects an empty policy', () => {
    expect(validateSlabs([]).valid).toBe(false);
  });
});

describe('maker-checker', () => {
  const steps = [step({ sequence: 1 })];

  it('refuses to let the raiser approve their own request', () => {
    const decision = canAct({
      step: steps[0], steps, actorUserId: 'u1', actorRoles: ['PROJECT_MANAGER'],
      requesterUserId: 'u1', documentType: 'PURCHASE_ORDER',
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.code).toBe('SELF_APPROVAL');
  });

  it('allows a different approver holding the role', () => {
    const decision = canAct({
      step: steps[0], steps, actorUserId: 'u2', actorRoles: ['PROJECT_MANAGER'],
      requesterUserId: 'u1', documentType: 'PURCHASE_ORDER',
    });
    expect(decision.allowed).toBe(true);
  });

  it('permits self-approval only with the explicit override', () => {
    // §4.1: an emergency override, explicitly granted and audited.
    const decision = canAct({
      step: steps[0], steps, actorUserId: 'u1', actorRoles: ['SUPER_ADMIN'],
      requesterUserId: 'u1', documentType: 'PURCHASE_ORDER', hasSelfApproveOverride: true,
    });
    expect(decision.allowed).toBe(false); // still needs the right role
    const withRole = canAct({
      step: step({ approverRole: 'SUPER_ADMIN' }), steps: [step({ approverRole: 'SUPER_ADMIN' })],
      actorUserId: 'u1', actorRoles: ['SUPER_ADMIN'], requesterUserId: 'u1',
      documentType: 'PURCHASE_ORDER', hasSelfApproveOverride: true,
    });
    expect(withRole.allowed).toBe(true);
  });

  it('refuses somebody without the step’s role', () => {
    const decision = canAct({
      step: steps[0], steps, actorUserId: 'u2', actorRoles: ['EMPLOYEE'],
      requesterUserId: 'u1', documentType: 'PURCHASE_ORDER',
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.code).toBe('NOT_THE_APPROVER');
  });
});

describe('sequential gating', () => {
  const ladder = [
    step({ sequence: 1, status: 'PENDING', approverRole: 'TEAM_LEAD' }),
    step({ sequence: 2, status: 'PENDING', approverRole: 'PROJECT_MANAGER' }),
  ];

  it('points at the first pending step', () => {
    expect(nextActionableStep(ladder)!.sequence).toBe(1);
  });

  it('blocks a later level while an earlier one is pending', () => {
    // Without this the ladder collapses into "whoever clicks first".
    const decision = canAct({
      step: ladder[1], steps: ladder, actorUserId: 'u2', actorRoles: ['PROJECT_MANAGER'],
      requesterUserId: 'u1', documentType: 'PURCHASE_ORDER',
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.code).toBe('OUT_OF_SEQUENCE');
      expect(decision.reason).toContain('Level 1 must decide');
    }
  });

  it('opens the next level once the first approves', () => {
    const advanced = [{ ...ladder[0], status: 'APPROVED' as const }, ladder[1]];
    expect(nextActionableStep(advanced)!.sequence).toBe(2);
    expect(canAct({
      step: advanced[1], steps: advanced, actorUserId: 'u2', actorRoles: ['PROJECT_MANAGER'],
      requesterUserId: 'u1', documentType: 'PURCHASE_ORDER',
    }).allowed).toBe(true);
  });

  it('reports nothing actionable once every step is decided', () => {
    const done = ladder.map(s => ({ ...s, status: 'APPROVED' as const }));
    expect(nextActionableStep(done)).toBeNull();
  });
});

describe('delegation', () => {
  const delegation = (over: Partial<Delegation> = {}): Delegation => ({
    fromUserId: 'boss', toUserId: 'deputy',
    validFrom: '2026-09-01', validTo: '2026-09-30', ...over,
  });

  it('lets the delegate act inside the window', () => {
    const who = effectiveApprovers('boss', [delegation()], 'PURCHASE_ORDER', '2026-09-15');
    expect(who.map(w => w.userId)).toContain('deputy');
    expect(who.find(w => w.userId === 'deputy')!.viaDelegation).toBe(true);
  });

  it('does not let the delegate act outside it', () => {
    // Time-bound is the point: leave ends, authority ends.
    expect(effectiveApprovers('boss', [delegation()], 'PURCHASE_ORDER', '2026-10-01').map(w => w.userId))
      .toEqual(['boss']);
    expect(effectiveApprovers('boss', [delegation()], 'PURCHASE_ORDER', '2026-08-31').map(w => w.userId))
      .toEqual(['boss']);
  });

  it('includes both boundary days', () => {
    for (const day of ['2026-09-01', '2026-09-30']) {
      expect(effectiveApprovers('boss', [delegation()], 'PURCHASE_ORDER', day).map(w => w.userId))
        .toContain('deputy');
    }
  });

  it('honours a delegation limited to certain document types', () => {
    const limited = [delegation({ documentTypes: ['EXPENSE_CLAIM'] })];
    expect(effectiveApprovers('boss', limited, 'EXPENSE_CLAIM', '2026-09-15').map(w => w.userId)).toContain('deputy');
    expect(effectiveApprovers('boss', limited, 'PURCHASE_ORDER', '2026-09-15').map(w => w.userId)).not.toContain('deputy');
  });

  it('ignores a revoked delegation', () => {
    expect(effectiveApprovers('boss', [delegation({ revokedAt: '2026-09-10' })], 'PURCHASE_ORDER', '2026-09-15')
      .map(w => w.userId)).toEqual(['boss']);
  });

  it('follows an onward delegation', () => {
    const chain = [delegation(), delegation({ fromUserId: 'deputy', toUserId: 'second' })];
    const who = effectiveApprovers('boss', chain, 'PURCHASE_ORDER', '2026-09-15');
    expect(who.map(w => w.userId)).toEqual(['boss', 'deputy', 'second']);
    expect(who.find(w => w.userId === 'second')!.chain).toEqual(['boss', 'deputy']);
  });

  it('does not loop on a cycle', () => {
    const cyclic = [delegation(), delegation({ fromUserId: 'deputy', toUserId: 'boss' })];
    const who = effectiveApprovers('boss', cyclic, 'PURCHASE_ORDER', '2026-09-15');
    expect(who.map(w => w.userId).sort()).toEqual(['boss', 'deputy']);
  });

  it('detects a delegation that would close a cycle', () => {
    // A→B exists; B→A would mean nobody is accountable.
    const existing = [delegation({ fromUserId: 'a', toUserId: 'b' })];
    expect(createsDelegationCycle(existing, delegation({ fromUserId: 'b', toUserId: 'a' }))).toBe(true);
    expect(createsDelegationCycle(existing, delegation({ fromUserId: 'b', toUserId: 'c' }))).toBe(false);
  });

  it('detects a longer cycle', () => {
    const existing = [
      delegation({ fromUserId: 'a', toUserId: 'b' }),
      delegation({ fromUserId: 'b', toUserId: 'c' }),
    ];
    expect(createsDelegationCycle(existing, delegation({ fromUserId: 'c', toUserId: 'a' }))).toBe(true);
  });

  it('lets a delegate act on a step assigned to the principal by name', () => {
    const decision = canAct({
      step: step({ approverRole: null, approverUserId: 'boss' }),
      steps: [step({ approverRole: null, approverUserId: 'boss' })],
      actorUserId: 'deputy', actorRoles: [], requesterUserId: 'u1',
      delegations: [delegation()], documentType: 'PURCHASE_ORDER', today: '2026-09-15',
    });
    expect(decision.allowed).toBe(true);
    if (decision.allowed) expect(decision.viaDelegation).toBe(true);
  });

  it('refuses the delegate once the window closes', () => {
    const decision = canAct({
      step: step({ approverRole: null, approverUserId: 'boss' }),
      steps: [step({ approverRole: null, approverUserId: 'boss' })],
      actorUserId: 'deputy', actorRoles: [], requesterUserId: 'u1',
      delegations: [delegation()], documentType: 'PURCHASE_ORDER', today: '2026-10-05',
    });
    expect(decision.allowed).toBe(false);
  });

  describe('role-based steps (owner decision 2026-09-24)', () => {
    // A role-based step ("any PROJECT_MANAGER") names no one person, so
    // delegation used to only ever help a *named-approver* step: a deputy
    // covering their PM's leave held no PM role of their own and could not
    // act on a step that simply asked for the role. The principal's own
    // eligibility -- holding the role -- is what the delegate inherits.
    const roleStep = step({ approverRole: 'PROJECT_MANAGER', approverUserId: null });

    it('lets the delegate act when the principal holds the step’s role', () => {
      const decision = canAct({
        step: roleStep, steps: [roleStep],
        actorUserId: 'deputy', actorRoles: [], requesterUserId: 'u1',
        delegations: [delegation({ fromUserRoles: ['PROJECT_MANAGER'] })],
        documentType: 'PURCHASE_ORDER', today: '2026-09-15',
      });
      expect(decision.allowed).toBe(true);
      if (decision.allowed) {
        expect(decision.viaDelegation).toBe(true);
        // Audit needs to name whose authority the role match came from -- a
        // role step has no single approverUserId to fall back on the way a
        // named-approver step does.
        expect(decision.onBehalfOf).toBe('boss');
      }
    });

    it('refuses the delegate when the principal never held that role', () => {
      const decision = canAct({
        step: roleStep, steps: [roleStep],
        actorUserId: 'deputy', actorRoles: [], requesterUserId: 'u1',
        delegations: [delegation({ fromUserRoles: ['TEAM_LEAD'] })],
        documentType: 'PURCHASE_ORDER', today: '2026-09-15',
      });
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) expect(decision.code).toBe('NOT_THE_APPROVER');
    });

    it('still refuses outside the delegation window even with a matching role', () => {
      const decision = canAct({
        step: roleStep, steps: [roleStep],
        actorUserId: 'deputy', actorRoles: [], requesterUserId: 'u1',
        delegations: [delegation({ fromUserRoles: ['PROJECT_MANAGER'] })],
        documentType: 'PURCHASE_ORDER', today: '2026-10-05',
      });
      expect(decision.allowed).toBe(false);
    });

    it('never lets a delegate approve their own document, role-based or not', () => {
      // Deputy raised the request themselves; boss's PM role would otherwise
      // hand deputy eligibility on the very document deputy is the requester
      // of. Maker-checker must still win.
      const decision = canAct({
        step: roleStep, steps: [roleStep],
        actorUserId: 'deputy', actorRoles: [], requesterUserId: 'deputy',
        delegations: [delegation({ fromUserRoles: ['PROJECT_MANAGER'] })],
        documentType: 'PURCHASE_ORDER', today: '2026-09-15',
      });
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) expect(decision.code).toBe('SELF_APPROVAL');
    });

    it('holding the role directly still works without any delegation', () => {
      const decision = canAct({
        step: roleStep, steps: [roleStep],
        actorUserId: 'someone_else', actorRoles: ['PROJECT_MANAGER'], requesterUserId: 'u1',
        documentType: 'PURCHASE_ORDER', today: '2026-09-15',
      });
      expect(decision.allowed).toBe(true);
      if (decision.allowed) expect(decision.viaDelegation).toBe(false);
    });

    describe('carries the principal’s project scope (fix round 1, I2)', () => {
      it('lets the delegate act for a project the principal can reach', () => {
        const decision = canAct({
          step: roleStep, steps: [roleStep],
          actorUserId: 'deputy', actorRoles: [], requesterUserId: 'u1',
          delegations: [delegation({
            fromUserRoles: ['PROJECT_MANAGER'],
            fromUserScope: { global: false, projects: ['proj-x'] },
          })],
          documentType: 'PURCHASE_ORDER', today: '2026-09-15', projectId: 'proj-x',
        });
        expect(decision.allowed).toBe(true);
      });

      it('refuses the delegate for a project the principal cannot reach', () => {
        // The delegate borrows boss's PM standing, not a blanket one -- boss
        // manages proj-x, not proj-y, so the deputy can only act for proj-x.
        const decision = canAct({
          step: roleStep, steps: [roleStep],
          actorUserId: 'deputy', actorRoles: [], requesterUserId: 'u1',
          delegations: [delegation({
            fromUserRoles: ['PROJECT_MANAGER'],
            fromUserScope: { global: false, projects: ['proj-x'] },
          })],
          documentType: 'PURCHASE_ORDER', today: '2026-09-15', projectId: 'proj-y',
        });
        expect(decision.allowed).toBe(false);
        if (!decision.allowed) expect(decision.code).toBe('NOT_THE_APPROVER');
      });

      it('leaves an org-wide document unrestricted, whatever the principal’s scope', () => {
        const decision = canAct({
          step: roleStep, steps: [roleStep],
          actorUserId: 'deputy', actorRoles: [], requesterUserId: 'u1',
          delegations: [delegation({
            fromUserRoles: ['PROJECT_MANAGER'],
            fromUserScope: { global: false, projects: ['proj-x'] },
          })],
          documentType: 'PURCHASE_ORDER', today: '2026-09-15', projectId: null,
        });
        expect(decision.allowed).toBe(true);
      });

      it('lets a globally-scoped principal’s delegate reach any project', () => {
        const decision = canAct({
          step: roleStep, steps: [roleStep],
          actorUserId: 'deputy', actorRoles: [], requesterUserId: 'u1',
          delegations: [delegation({
            fromUserRoles: ['PROJECT_MANAGER'],
            fromUserScope: { global: true, projects: [] },
          })],
          documentType: 'PURCHASE_ORDER', today: '2026-09-15', projectId: 'proj-y',
        });
        expect(decision.allowed).toBe(true);
      });

      it('stays permissive when an older caller has not supplied the principal’s scope', () => {
        const decision = canAct({
          step: roleStep, steps: [roleStep],
          actorUserId: 'deputy', actorRoles: [], requesterUserId: 'u1',
          delegations: [delegation({ fromUserRoles: ['PROJECT_MANAGER'] })],
          documentType: 'PURCHASE_ORDER', today: '2026-09-15', projectId: 'proj-y',
        });
        expect(decision.allowed).toBe(true);
      });
    });
  });
});

describe('segregation of duties (fix round 1, I3)', () => {
  // One person may decide at most one level of a given instance, whether
  // acting as themselves or as someone else's delegate -- checked against
  // both identities an earlier step can carry: who physically decided it
  // (actedByUserId), and whose authority they borrowed to do it
  // (actedOnBehalfOf).
  const adminStep = (over: Partial<ApprovalStep> = {}): ApprovalStep =>
    step({ sequence: 2, approverRole: 'ADMIN', approverUserId: null, ...over });

  it('blocks a PM who cleared level 1 from reaching level 2 through a borrowed ADMIN delegation', () => {
    const level1 = step({ sequence: 1, approverRole: 'TEAM_LEAD', status: 'APPROVED', actedByUserId: 'pm1' });
    const level2 = adminStep({ status: 'PENDING' });
    const decision = canAct({
      step: level2, steps: [level1, level2],
      actorUserId: 'pm1', actorRoles: [], requesterUserId: 'someone-else',
      delegations: [{
        fromUserId: 'admin1', toUserId: 'pm1', validFrom: '2026-09-01', validTo: '2026-09-30',
        fromUserRoles: ['ADMIN'],
      }],
      documentType: 'PURCHASE_ORDER', today: '2026-09-15',
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.code).toBe('SEGREGATION_OF_DUTIES');
  });

  it('blocks a second delegate of the same principal who already decided a level', () => {
    // deputy1 decided level 1 on admin1's behalf; deputy2, a different
    // physical person but delegate of the same admin1, must not get level 2.
    const level1 = step({
      sequence: 1, approverRole: 'ADMIN', status: 'APPROVED',
      actedByUserId: 'deputy1', actedOnBehalfOf: 'admin1',
    });
    const level2 = adminStep({ status: 'PENDING' });
    const decision = canAct({
      step: level2, steps: [level1, level2],
      actorUserId: 'deputy2', actorRoles: [], requesterUserId: 'someone-else',
      delegations: [{
        fromUserId: 'admin1', toUserId: 'deputy2', validFrom: '2026-09-01', validTo: '2026-09-30',
        fromUserRoles: ['ADMIN'],
      }],
      documentType: 'PURCHASE_ORDER', today: '2026-09-15',
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.code).toBe('SEGREGATION_OF_DUTIES');
  });

  it('still lets an unrelated person decide the next level', () => {
    const level1 = step({ sequence: 1, approverRole: 'TEAM_LEAD', status: 'APPROVED', actedByUserId: 'tl1' });
    const level2 = adminStep({ status: 'PENDING' });
    const decision = canAct({
      step: level2, steps: [level1, level2],
      actorUserId: 'admin2', actorRoles: ['ADMIN'], requesterUserId: 'someone-else',
      documentType: 'PURCHASE_ORDER', today: '2026-09-15',
    });
    expect(decision.allowed).toBe(true);
  });

  it('does not count a skipped step -- nobody decided it', () => {
    const level1 = step({ sequence: 1, approverRole: 'TEAM_LEAD', status: 'SKIPPED', actedByUserId: null });
    const level2 = adminStep({ status: 'PENDING' });
    const decision = canAct({
      step: level2, steps: [level1, level2],
      actorUserId: 'admin1', actorRoles: ['ADMIN'], requesterUserId: 'someone-else',
      documentType: 'PURCHASE_ORDER', today: '2026-09-15',
    });
    expect(decision.allowed).toBe(true);
  });
});

describe('re-approval on amount change', () => {
  it('tears up approvals when the amount rises', () => {
    // The classic hole: approved at 4 lakh, edited to 6 lakh, ships on the
    // old signature.
    const result = requiresReapproval({ approvedAmount: 400_000, newAmount: 600_000, levels: LEVELS });
    expect(result.required).toBe(true);
    expect(result.reason).toContain('rose');
  });

  it('re-routes even a small rise that crosses a band', () => {
    const result = requiresReapproval({ approvedAmount: 499_000, newAmount: 501_000, levels: LEVELS });
    expect(result.required).toBe(true);
  });

  it('leaves a reduction standing when it stays in the same band', () => {
    // Re-approving a cheaper version of something already agreed wastes time
    // and trains people to click through.
    const result = requiresReapproval({ approvedAmount: 400_000, newAmount: 350_000, levels: LEVELS });
    expect(result.required).toBe(false);
  });

  it('re-routes a reduction that drops into a lower band', () => {
    const result = requiresReapproval({ approvedAmount: 600_000, newAmount: 40_000, levels: LEVELS });
    expect(result.required).toBe(true);
    expect(result.reason).toContain('different authority band');
  });

  it('allows a configured tolerance for minor variation', () => {
    // Freight or rounding on a PO should not restart the ladder.
    const within = requiresReapproval({ approvedAmount: 100_000, newAmount: 102_000, levels: LEVELS, tolerancePct: 5 });
    expect(within.required).toBe(false);
    const beyond = requiresReapproval({ approvedAmount: 100_000, newAmount: 110_000, levels: LEVELS, tolerancePct: 5 });
    expect(beyond.required).toBe(true);
  });

  it('always re-routes a rise from zero', () => {
    expect(requiresReapproval({ approvedAmount: 0, newAmount: 1, levels: LEVELS, tolerancePct: 50 }).required).toBe(true);
  });

  it('does nothing when the amount is unchanged', () => {
    expect(requiresReapproval({ approvedAmount: 400_000, newAmount: 400_000, levels: LEVELS }).required).toBe(false);
  });
});

describe('SLA escalation', () => {
  const now = new Date('2026-09-15T12:00:00Z');

  it('reports a step waiting past its SLA', () => {
    const overdue = overdueSteps([{
      ...step(), slaHours: 24, pendingSince: '2026-09-13T12:00:00Z',
    }], now);
    expect(overdue).toHaveLength(1);
    expect(overdue[0].hoursWaiting).toBe(48);
  });

  it('leaves a step inside its SLA alone', () => {
    expect(overdueSteps([{ ...step(), slaHours: 48, pendingSince: '2026-09-15T06:00:00Z' }], now)).toHaveLength(0);
  });

  it('ignores steps already decided', () => {
    expect(overdueSteps([{
      ...step({ status: 'APPROVED' }), slaHours: 1, pendingSince: '2026-01-01T00:00:00Z',
    }], now)).toHaveLength(0);
  });

  it('ignores steps with no SLA configured', () => {
    expect(overdueSteps([{ ...step(), slaHours: null, pendingSince: '2026-01-01T00:00:00Z' }], now)).toHaveLength(0);
  });
});

describe('schemas', () => {
  const policy = {
    document_type: 'PURCHASE_ORDER' as const, name: 'Procurement DoA',
    levels: [
      { sequence: 1, min_amount: 0, max_amount: 50_000, approver_role: 'TEAM_LEAD' },
      { sequence: 2, min_amount: 50_000, max_amount: null, approver_role: 'ADMIN' },
    ],
  };

  it('accepts a complete policy', () => {
    expect(approvalPolicySchema.safeParse(policy).success).toBe(true);
  });

  it('rejects a policy whose slabs leave a gap', () => {
    const gapped = {
      ...policy,
      levels: [
        { sequence: 1, min_amount: 0, max_amount: 50_000, approver_role: 'TEAM_LEAD' },
        { sequence: 2, min_amount: 90_000, max_amount: null, approver_role: 'ADMIN' },
      ],
    };
    expect(approvalPolicySchema.safeParse(gapped).success).toBe(false);
  });

  it('rejects a level naming no approver at all', () => {
    expect(approvalPolicySchema.safeParse({
      ...policy,
      levels: [{ sequence: 1, min_amount: 0, max_amount: null }],
    }).success).toBe(false);
  });

  it('insists a rejection carries a reason', () => {
    expect(approvalDecisionSchema.safeParse({ decision: 'REJECT' }).success).toBe(false);
    expect(approvalDecisionSchema.safeParse({ decision: 'REJECT', comments: 'Rate too high' }).success).toBe(true);
    expect(approvalDecisionSchema.safeParse({ decision: 'APPROVE' }).success).toBe(true);
  });

  it('insists a delegation carries a reason and a valid window', () => {
    const base = {
      to_user_id: '3f1a0c2e-0000-4000-8000-000000000001',
      valid_from: '2026-09-01', valid_to: '2026-09-30', reason: 'Annual leave',
    };
    expect(delegationSchema.safeParse(base).success).toBe(true);
    expect(delegationSchema.safeParse({ ...base, reason: '' }).success).toBe(false);
    expect(delegationSchema.safeParse({ ...base, valid_to: '2026-08-01' }).success).toBe(false);
  });
});

describe('role grants', () => {
  it('reserves the self-approval override for Super Admin', () => {
    const holders = Object.entries(APPROVAL_ROLE_GRANTS)
      .filter(([, codes]) => codes.includes('approval.self_approve'))
      .map(([role]) => role);
    expect(holders).toEqual(['SUPER_ADMIN']);
  });

  it('lets the Auditor read everything but change nothing', () => {
    // §4 gives the Auditor read across all domains, so read_all is required —
    // asserting the intent rather than an exact array, because the list will
    // grow and the rule that matters is "no mutating grant".
    expect(APPROVAL_ROLE_GRANTS.AUDITOR).toContain('approval.read_all');
    for (const mutating of ['approval.act', 'approval.configure', 'approval.delegate', 'approval.self_approve']) {
      expect(APPROVAL_ROLE_GRANTS.AUDITOR).not.toContain(mutating);
    }
  });

  it('separates seeing your own requests from seeing everybody\'s', () => {
    // Conflating these blocked the Auditor with the check meant to stop an
    // employee browsing other people's requests.
    expect(APPROVAL_ROLE_GRANTS.EMPLOYEE).toContain('approval.read');
    expect(APPROVAL_ROLE_GRANTS.EMPLOYEE).not.toContain('approval.read_all');
  });

  it('gives an employee visibility of their own requests but no authority', () => {
    expect(APPROVAL_ROLE_GRANTS.EMPLOYEE).toEqual(['approval.read']);
  });
});

describe('APPROVAL_STATUS_TONES (fix round 1, item 7)', () => {
  it('has an entry for every approval status, so nothing falls through to a silent default', () => {
    for (const status of APPROVAL_STATUSES) {
      expect(APPROVAL_STATUS_TONES[status]).toBeTruthy();
    }
  });

  it('reads RECALLED as danger and SUPERSEDED as info, matching what web already uses elsewhere', () => {
    expect(APPROVAL_STATUS_TONES.RECALLED).toBe('danger');
    expect(APPROVAL_STATUS_TONES.SUPERSEDED).toBe('info');
  });
});
