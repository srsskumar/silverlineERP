import { describe, expect, it } from 'vitest';
import {
  buildWorkbook, zipStore, columnRef, sheetCsv, optionsNote, type SheetSpec,
} from '../lib/xlsx';
import { IMPORT_TEMPLATES, templateSheet } from '../lib/import-templates';
import { taskTemplateSheets, assigneeOptions, TASK_STATUS_OPTIONS } from '../lib/task-template';
import type { Person } from '../lib/people';

const people: Person[] = [
  { id: 'u1', username: 'anitha', employee_id: 'e1', emp_no: 'EMP001', name: 'Anitha Devi', employee_status: 'ACTIVE' },
  { id: 'u2', username: 'anitha2', employee_id: 'e2', emp_no: 'EMP014', name: 'Anitha Sastry', employee_status: 'ACTIVE' },
  { id: 'u3', username: 'admin', employee_id: null, emp_no: null, name: 'admin', employee_status: null },
];

async function bytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}
const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe('columnRef', () => {
  it('counts the way a spreadsheet does', () => {
    expect(columnRef(0)).toBe('A');
    expect(columnRef(25)).toBe('Z');
    expect(columnRef(26)).toBe('AA');
    expect(columnRef(27)).toBe('AB');
  });
});

describe('zipStore', () => {
  it('writes a file a reader will recognise as a zip', async () => {
    const b = await bytes(zipStore([{ name: 'a.txt', data: new TextEncoder().encode('hello') }]));
    expect([b[0], b[1], b[2], b[3]]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(text(b)).toContain('a.txt');
    expect(text(b)).toContain('hello');
    // End-of-central-directory signature, the last 22 bytes of the file.
    const end = b.length - 22;
    expect([b[end], b[end + 1], b[end + 2], b[end + 3]]).toEqual([0x50, 0x4b, 0x05, 0x06]);
  });

  it('records the entry count and directory offset in the end record', async () => {
    // A reader trusts these over walking the entries; wrong numbers produce a
    // file that opens as empty rather than one that fails loudly.
    const entries = [
      { name: 'a', data: new Uint8Array([1]) },
      { name: 'b', data: new Uint8Array([2]) },
    ];
    const b = await bytes(zipStore(entries));
    const end = b.length - 22;
    const u16 = (at: number) => b[at] + (b[at + 1] << 8);
    const u32 = (at: number) => b[at] + (b[at + 1] << 8) + (b[at + 2] << 16) + b[at + 3] * 0x1000000;
    expect(u16(end + 8)).toBe(2);
    expect(u16(end + 10)).toBe(2);
    // The recorded offset must land on a central-directory header.
    const dir = u32(end + 16);
    expect([b[dir], b[dir + 1], b[dir + 2], b[dir + 3]]).toEqual([0x50, 0x4b, 0x01, 0x02]);
    expect(u32(end + 12)).toBe(end - dir);
  });

  it('writes a CRC that matches the data', async () => {
    // A mismatched CRC is the one error every zip reader refuses outright.
    const data = new TextEncoder().encode('123456789');
    const b = await bytes(zipStore([{ name: 'a', data }]));
    const crc = b[14] + (b[15] << 8) + (b[16] << 16) + b[17] * 0x1000000;
    expect(crc).toBe(0xcbf43926); // the standard check value for "123456789"
  });
});

describe('buildWorkbook', () => {
  const spec: SheetSpec[] = [{
    name: 'Tasks',
    columns: [{ header: 'title' }, { header: 'status', options: ['TO_DO', 'DONE'] }],
    rows: [['Survey', 'TO_DO']],
  }];

  it('contains the parts a workbook needs to open', async () => {
    const t = text(await bytes(buildWorkbook(spec)));
    for (const part of [
      '[Content_Types].xml', '_rels/.rels',
      'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/worksheets/sheet1.xml',
    ]) {
      expect(t, part).toContain(part);
    }
  });

  it('puts a dropdown on the column that has fixed values', async () => {
    // The reason the template is a spreadsheet and not a CSV.
    const t = text(await bytes(buildWorkbook(spec)));
    expect(t).toContain('<dataValidation type="list"');
    expect(t).toContain('<formula1>Lists!$A$2:$A$3</formula1>');
    expect(t).toContain('errorTitle="Not an allowed value"');
  });

  it('hides the lookup sheet', async () => {
    // It is machinery; a reader who sees it wonders whether to fill it in.
    const t = text(await bytes(buildWorkbook(spec)));
    expect(t).toContain('name="Lists" sheetId="2"');
    expect(t).toMatch(/name="Lists"[^/]*state="hidden"/);
  });

  it('escapes a value that would otherwise break the XML', async () => {
    const t = text(await bytes(buildWorkbook([{
      name: 'Tasks',
      columns: [{ header: 'title' }],
      rows: [['Rock & <roll> "quoted"']],
    }])));
    expect(t).toContain('Rock &amp; &lt;roll&gt; &quot;quoted&quot;');
    // The raw form must not survive anywhere, or the file will not open.
    expect(t).not.toContain('<roll>');
  });

  it('leaves a column without options free of validation', async () => {
    const t = text(await bytes(buildWorkbook([{
      name: 'Tasks', columns: [{ header: 'title' }], rows: [['x']],
    }])));
    expect(t).not.toContain('<dataValidation');
  });
});

describe('task template', () => {
  it('offers the assignee as a name with their number', () => {
    // Two people called Anitha in one organisation is ordinary; a bare name
    // would leave the row ambiguous and the importer guessing.
    const options = assigneeOptions(people);
    expect(options).toContain('Anitha Devi (EMP001)');
    expect(options).toContain('Anitha Sastry (EMP014)');
  });

  it('falls back to the sign-in name for an account with no employee record', () => {
    expect(assigneeOptions(people)).toContain('admin');
  });

  it('never offers a raw user id', () => {
    for (const option of assigneeOptions(people)) expect(option).not.toContain('u1');
  });

  it('builds the assignee dropdown from live people', async () => {
    const t = text(await bytes(buildWorkbook(taskTemplateSheets({ people }))));
    expect(t).toContain('Anitha Devi (EMP001)');
    for (const status of TASK_STATUS_OPTIONS) expect(t).toContain(status);
  });

  it('keeps subtasks on the same sheet as their parents', () => {
    // A second sheet would mean keying the parent identifier twice.
    const sheets = taskTemplateSheets({ people });
    expect(sheets).toHaveLength(1);
    const headers = sheets[0].columns.map((c) => c.header);
    expect(headers).toContain('parent_title');
    // Found by column name, not position: a new column at the front used to
    // move every index and break this test rather than the template.
    const titleAt = headers.indexOf('title');
    const parentAt = headers.indexOf('parent_title');
    const subtask = sheets[0].rows.find((r) => r[parentAt] !== '');
    expect(subtask?.[parentAt]).toBe('Survey the Ameerpet stretch');
    // The parent it names has to exist on the sheet, or the example teaches a
    // pattern that fails on upload.
    expect(sheets[0].rows.some((r) => r[titleAt] === subtask?.[parentAt])).toBe(true);
  });

  it('survives an empty directory without producing a broken file', async () => {
    // A fresh organisation has no employees yet; the file must still open.
    const t = text(await bytes(buildWorkbook(taskTemplateSheets({ people: [] }))));
    expect(t).toContain('xl/workbook.xml');
    expect(t).toContain('TO_DO');
  });
});

describe('csv fallback', () => {
  const spec: SheetSpec = {
    name: 'Tasks',
    columns: [{ header: 'title' }, { header: 'status', options: ['TO_DO', 'DONE'] }],
    rows: [['Survey, phase 1', 'TO_DO']],
  };

  it('quotes only the cell that needs it', () => {
    expect(sheetCsv(spec)).toBe('title,status\n"Survey, phase 1",TO_DO\n');
  });

  it('escapes an embedded quote the way a CSV reader expects', () => {
    const csv = sheetCsv({ ...spec, rows: [['He said "go"', 'DONE']] });
    expect(csv).toContain('"He said ""go"""');
  });

  it('defuses a cell that would open as a formula rather than the text it is', () => {
    // A CSV has no cell-type information the way the workbook does (every
    // one of its cells is written inlineStr), so a spreadsheet reading the
    // fallback decides for itself, and Excel, LibreOffice and Google Sheets
    // all read a leading =, +, - or @ as a formula. Somebody's query subject
    // or a landmark description is typed, not authored as a formula.
    for (const dangerous of ['=1+1', '+1+1', '-1+1', '@SUM(1)', "=cmd|'/C calc'!A1"]) {
      const csv = sheetCsv({ ...spec, rows: [[dangerous, 'DONE']] });
      // Quoted or not (a quote mark in the value forces quoting, which is a
      // separate, already-covered concern), the defused value is right there
      // in the file, one character further in than it was typed.
      expect(csv, dangerous).toContain(`'${dangerous}`);
    }
  });

  it('leaves a genuine negative or signed number alone', () => {
    const csv = sheetCsv({ ...spec, rows: [['-12.5', 'DONE']] });
    expect(csv).toContain('-12.5,DONE');
  });

  it('carries exactly the columns the workbook does', async () => {
    // The two downloads must not drift apart; a CSV with a column the
    // importer does not know is the hardest failure for a user to diagnose.
    const t = text(await bytes(buildWorkbook([spec])));
    for (const header of sheetCsv(spec).split('\n')[0].split(',')) {
      expect(t).toContain(header);
    }
  });

  it('writes down the rules the CSV cannot enforce', () => {
    // The dropdowns are gone, so the allowed values have to be stated.
    expect(optionsNote(spec)).toEqual(['status must be one of: TO_DO, DONE']);
  });

  it('points a long list at the workbook rather than printing it', () => {
    const people = Array.from({ length: 40 }, (_, i) => `Person ${i}`);
    const note = optionsNote({ ...spec, columns: [{ header: 'assigned_to', options: people }] })[0];
    expect(note).toContain('and 34 more');
    expect(note).toContain('Excel');
  });

  it('says nothing about a column with no fixed values', () => {
    expect(optionsNote({ name: 'x', columns: [{ header: 'title' }], rows: [] })).toEqual([]);
  });
});

describe('import templates', () => {
  it('turns every template into a sheet with its headers intact', () => {
    for (const template of IMPORT_TEMPLATES) {
      const sheet = templateSheet(template);
      expect(sheet.columns.map((c) => c.header)).toEqual(template.headers);
      // The example row has to line up with the headers or the file misleads.
      expect(sheet.rows[0]).toHaveLength(template.headers.length);
    }
  });

  it('only declares options for columns that exist', () => {
    for (const template of IMPORT_TEMPLATES) {
      for (const header of Object.keys(template.options ?? {})) {
        expect(template.headers, `${template.key}.${header}`).toContain(header);
      }
    }
  });

  it('gives the example row values its own dropdowns accept', () => {
    // An example that would be rejected on upload teaches the wrong thing.
    for (const template of IMPORT_TEMPLATES) {
      for (const [header, values] of Object.entries(template.options ?? {})) {
        const value = template.example[template.headers.indexOf(header)];
        if (value === '') continue;
        expect(values, `${template.key}.${header}`).toContain(value);
      }
    }
  });

  it('builds a workbook per template that opens', async () => {
    for (const template of IMPORT_TEMPLATES) {
      const t = text(await bytes(buildWorkbook([templateSheet(template)])));
      expect(t, template.key).toContain('xl/workbook.xml');
      expect(t, template.key).toContain('xl/worksheets/sheet1.xml');
    }
  });

  it('puts a dropdown on every template that has a fixed-value column', async () => {
    // Split from the test above: a template can legitimately have no enum
    // columns — the survey village list is all codes and names — and
    // requiring a dropdown everywhere would mean inventing one.
    const withOptions = IMPORT_TEMPLATES.filter(
      (t) => Object.keys(t.options ?? {}).length > 0);
    expect(withOptions.length).toBeGreaterThan(0);
    for (const template of withOptions) {
      const t = text(await bytes(buildWorkbook([templateSheet(template)])));
      expect(t, template.key).toContain('<dataValidation type="list"');
    }
  });
});

describe('the task template and its project column', () => {
  const people = [{ id: '1', name: 'Asha Rao', emp_no: 'EMP001' }] as never;

  it('carries the project a task belongs to', () => {
    // Without it a filled-in sheet cannot say which board the work lands on,
    // which is the one field that decides whether anybody sees the task.
    const [sheet] = taskTemplateSheets({ people });
    expect(sheet.columns.map((c) => c.header)).toContain('project_code');
  });

  it('offers real project codes rather than free text', () => {
    // A typo there makes a whole upload arrive nowhere.
    const [sheet] = taskTemplateSheets({ people, projectCodes: ['SURVEY-AP-01', 'HYD-ROAD-01'] });
    const column = sheet.columns.find((c) => c.header === 'project_code');
    expect(column?.options).toEqual(['SURVEY-AP-01', 'HYD-ROAD-01']);
  });

  it('adds a land survey sheet only when the stages are known', () => {
    expect(taskTemplateSheets({ people })).toHaveLength(1);
    const withStages = taskTemplateSheets({
      people, surveyStages: ['Ground truthing', 'GT quality check'],
    });
    expect(withStages).toHaveLength(2);
    expect(withStages[1].name).toBe('Land survey');
  });

  it('makes the survey subtask a list of stages, not free text', () => {
    /*
     * A survey subtask is a stage, and the stages are the same eight every
     * time — offering them as a list is the difference between a sheet that
     * imports and one that half-imports. On the ordinary sheet a free-text
     * subtask title is correct, which is why the two sheets differ.
     */
    const stages = ['Ground truthing', 'GT quality check'];
    const [ordinary, survey] = taskTemplateSheets({ people, surveyStages: stages });
    expect(ordinary.columns.find((c) => c.header === 'parent_title')?.options).toBeUndefined();
    expect(survey.columns.find((c) => c.header === 'parent_title')?.options).toEqual(stages);
  });
});
