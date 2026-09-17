import type { SheetSpec } from './xlsx';
import type { Person } from './people';

/**
 * The tasks-and-subtasks upload template.
 *
 * A spreadsheet rather than a CSV because of the dropdowns. A CSV can *state*
 * that status must be one of six words and that the assignee must be somebody
 * who exists; a spreadsheet stops a seventh word and an invented name being
 * typed in the first place. Half the rejections on a bulk upload are a
 * mis-typed enum or a person who left last year.
 *
 * Subtasks live on the same sheet as their parents rather than a second one.
 * A separate sheet means keying the parent's identifier twice and getting it
 * wrong; one sheet with a `parent_title` column reads the way the work
 * actually breaks down.
 */

export const TASK_STATUS_OPTIONS = [
  'TO_DO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE', 'BLOCKED', 'CANCELLED',
] as const;

export const TASK_PRIORITY_OPTIONS = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;

export interface TaskTemplateContext {
  /** Real people, so the assignee column is a list of names rather than ids. */
  people: Person[];
  /** The project this upload is for, shown in the example rows. */
  projectCode?: string;
  /**
   * The projects a task may belong to, as codes.
   *
   * The template had no project column at all, so a filled-in sheet could
   * not say where its tasks went — the one field that decides whether the
   * work appears on anybody's board. A dropdown of real codes also stops the
   * typo that makes a whole upload land nowhere.
   */
  projectCodes?: string[];
  /**
   * Stage names for the land survey variant.
   *
   * A survey subtask is a stage, and the stages are the same eight every
   * time. Offering them as a list is the difference between a sheet that
   * imports and one that half-imports.
   */
  surveyStages?: string[];
}

/**
 * Assignee options as names.
 *
 * The employee name, with the employee number where there is one, because two
 * people called Anitha in the same organisation is ordinary and a bare name
 * would make the row ambiguous. The importer matches on this whole string.
 */
export function assigneeOptions(people: Person[]): string[] {
  return people
    .map(p => (p.emp_no ? `${p.name} (${p.emp_no})` : p.name))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

export function taskTemplateSheets(context: TaskTemplateContext): SheetSpec[] {
  const assignees = assigneeOptions(context.people);
  const project = context.projectCode ?? 'HYD-ROAD-01';

  const columns = [
    // Where the task goes. Without it a filled-in sheet cannot say which
    // board the work belongs on.
    {
      header: 'project_code',
      options: context.projectCodes?.length ? context.projectCodes : undefined,
      width: 20,
    },
    { header: 'title', width: 38 },
    // Blank for a top-level task; the exact title of the parent for a subtask.
    { header: 'parent_title', width: 32 },
    { header: 'description', width: 42 },
    { header: 'status', options: [...TASK_STATUS_OPTIONS], width: 16 },
    { header: 'priority', options: [...TASK_PRIORITY_OPTIONS], width: 14 },
    { header: 'assigned_to', options: assignees, width: 30 },
    { header: 'planned_start_date', width: 18 },
    { header: 'planned_end_date', width: 18 },
    { header: 'estimated_hours', width: 16 },
    { header: 'labels', width: 24 },
  ];

  const example = (
    title: string, parent: string, description: string, status: string,
    priority: string, planStart: string, planEnd: string, hours: string, labels: string,
  ) => [
    project, title, parent, description, status, priority,
    assignees[0] ?? '', planStart, planEnd, hours, labels,
  ];

  return [
    {
      name: 'Tasks',
      columns,
      rows: [
        example(
          'Survey the Ameerpet stretch', '', 'Total station survey, chainage 0 to 1200',
          'TO_DO', 'HIGH', '2026-10-01', '2026-10-07', '32', 'survey;phase-1',
        ),
        // A subtask: the same sheet, naming its parent.
        example(
          'Set out control points', 'Survey the Ameerpet stretch',
          'Establish and mark the benchmark pillars',
          'TO_DO', 'MEDIUM', '2026-10-01', '2026-10-02', '8', 'survey',
        ),
        example(
          'Mobilise the crew', '', `Crew and equipment to site for ${project}`,
          'IN_PROGRESS', 'URGENT', '2026-09-28', '2026-09-30', '16', 'mobilisation',
        ),
      ],
    },
    /*
     * A second sheet for land survey work.
     *
     * The note allows a separate format because the requirements differ, and
     * they do: a survey task is a village and its subtasks are the eight
     * stages, the same eight every time. Offering them as a list is the
     * difference between a sheet that imports and one that half-imports —
     * and the ordinary Tasks sheet cannot carry that, because a free-text
     * subtask title there is correct.
     */
    ...(context.surveyStages?.length ? [{
      name: 'Land survey',
      columns: [
        ...columns.slice(0, 2),
        { header: 'parent_title', options: undefined, width: 32 },
        ...columns.slice(3),
      ].map(c => (c.header === 'parent_title'
        ? { ...c, options: context.surveyStages }
        : c)),
      rows: [
        example(
          'ADAKULA', '', 'Ground truthing and records for the village',
          'TO_DO', 'HIGH', '2026-10-01', '2026-11-15', '', 'survey;village',
        ),
        example(
          'Ground truthing', 'ADAKULA', 'Field measurement of the village',
          'TO_DO', 'HIGH', '2026-10-01', '2026-10-20', '', 'survey',
        ),
        example(
          'GT quality check', 'ADAKULA', 'Check the ground truthing before vectorization',
          'TO_DO', 'MEDIUM', '2026-10-21', '2026-10-28', '', 'survey;qc',
        ),
      ],
    }] : []),
  ];
}

export const TASK_TEMPLATE_NOTES = [
  'project_code says which project the task belongs to, and is a dropdown of the projects you can see. Without it the task has no board to appear on.',
  'The Land survey sheet is a separate format for survey work: the task is a village and the subtasks are its stages, which is why parent_title there is a list rather than free text.',
  'Leave parent_title blank for a top-level task. For a subtask, put the exact title of its parent — the parent must appear somewhere on the same sheet.',
  'status, priority and assigned_to are dropdowns. Anything typed by hand is rejected on upload, which is the point of the spreadsheet.',
  'assigned_to is the employee name with their number, exactly as the list offers it. Two people share a first name often enough that the number matters.',
  'Dates are YYYY-MM-DD. A date written 01/10/2026 is ambiguous and is refused.',
  'labels are separated by a semicolon. A label that does not exist yet is created.',
  'The Lists sheet holds the dropdown values and is hidden; it is machinery, not something to fill in.',
  'Delete the three example rows before uploading.',
];
