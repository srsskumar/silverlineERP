# 46. Document Governance (NEW)

*Extends §3 (Employee Management) and §29 (Storage). Written after the finance
modules, because loading four of them made the same gap visible four times.*

Documents exist all over Silverline already — employee records, task evidence,
payslips, tender papers, GST invoices. Each lives in its own table, attached to
its own parent, readable only from its own screen. Nothing knows about
documents as a class.

That is fine until somebody asks the two questions this section exists to
answer:

- **What is about to expire, and what stops if it does?**
- **Which revision is the current one, and who is holding an old one?**

Neither can be answered today. Both have to be, because in Indian construction
the answer to the first one is sometimes "work stops at the site tomorrow".

---

## 46.1 Why the existing layer is not enough

**46.1.1 There is no register.** `employee_documents`, `task_evidence`,
`payslip_documents` and the tender attachments are four tables with four
schemas and no common view. A query for "everything expiring in the next
thirty days" has to be written four times and re-written whenever a fifth
place starts holding documents. In practice it is never written at all.

**46.1.2 Nothing has an expiry date.** Not one of the existing tables records
one. The documents that matter most in this business are precisely the ones
that lapse:

| Document | Lapses into |
| --- | --- |
| Labour licence (CLRA s.12) | Employing contract labour becomes an offence; work stops |
| BOCW registration | Same, plus cess assessment exposure |
| Workmen's compensation policy | Uninsured statutory liability for every injury |
| Contractor's all-risk policy | Uninsured damage, and usually a contract breach |
| Crane / lifting tackle test certificate | Equipment must be taken out of service |
| Driving licence, vehicle fitness, permit, PUC | Vehicle off the road; driver personally liable |
| GST registration, PAN, EPF and ESIC codes | Cannot invoice, cannot remit, cannot be paid |
| Bank guarantee (EMD, performance, advance) | Client left unsecured, or the guarantee is invoked |
| Bid validity | The tender lapses |
| Medical fitness, safety training card | Worker cannot be deployed on site |

Every one of these has a renewal lead time measured in weeks, and every one of
them is currently tracked in somebody's spreadsheet or not at all.

**46.1.3 There is no notion of a current revision.** A document can be
uploaded twice with no relationship between the two rows. On a site this is
the difference between building to revision C and building to revision E. The
register must know which revision supersedes which, keep the old one
retrievable for audit, and refuse to present it as current.

**46.1.4 Deletion is unconstrained.** Statutory retention in India runs to
eight years for books of account (Companies Act 2013 s.128), six years for
income-tax records, three years for CLRA registers. A document under audit,
dispute or arbitration must survive any routine clean-up regardless of age.

---

## 46.2 The register

**46.2.1** One table records every controlled document, whatever it is attached
to. Attachment is polymorphic: `owner_type` plus `owner_id`, over the entities
that already exist (`employee`, `project`, `client`, `vendor`, `asset`,
`tender`, `organization`). An organisation-level document — the GST
registration, the labour licence — attaches to the org itself.

**46.2.2** The register holds metadata, not content. Existing content stays
where it is; a register row may point at an `employee_documents` row through
`source_type`/`source_id`. The register is the index, and the index is what was
missing. Migrating stored bytes is out of scope (§46.6).

**46.2.3** Every row carries a **document type** from a governed list, because
the expiry rules, the retention period and the lead time are properties of the
type rather than of the individual file. Types are seeded (46.5) and
extensible per organisation.

**46.2.4** A row carries `issued_on`, `valid_from`, `expires_on`, the issuing
authority, and the document's own reference number. `expires_on` is nullable:
a degree certificate does not expire. A type marked `expiry_required` refuses a
row without one, because a labour licence with no recorded expiry is worse
than no record at all — it reads as compliant.

## 46.3 Expiry and renewal

**46.3.1** A document is in exactly one state, derived and never stored:

| State | Meaning |
| --- | --- |
| `VALID` | In force, outside its notice window |
| `EXPIRING` | In force, inside the notice window for its type |
| `EXPIRED` | Past its expiry date |
| `SUPERSEDED` | A later revision replaced it |
| `NO_EXPIRY` | Not time-limited |

Derived, for the same reason a settlement position is derived (§45): a stored
status is a status that is wrong at midnight.

**46.3.2** The notice window is a property of the type and defaults to its
renewal lead time. A labour licence taking six weeks to renew gets sixty days
of notice; a PUC certificate taking an afternoon gets seven. A single global
"30 days" is what makes people ignore the alerts.

**46.3.3** Expiry of a document whose type is marked `blocks_operations` is
reported separately and prominently. This is the difference between "the
director's PAN card scan is old" and "the labour licence expired, and every
worker on site today is there unlawfully".

**46.3.4** A renewal creates a new row that supersedes the old one, carrying
forward the type, owner and reference. The old row becomes `SUPERSEDED` and
stays readable. Renewal is not an edit of the expiry date: the previous
certificate existed and an inspector may ask for it.

## 46.4 Revisions

**46.4.1** `supersedes_id` points at the row this one replaces. A row may be
superseded once only; a second attempt is refused rather than silently
producing two "current" revisions.

**46.4.2** Revision numbering is free text (`Rev C`, `v2`, `2026-A`) because
every client numbers drawings differently and forcing a scheme produces a
field everybody types around.

**46.4.3** A superseded document can be read and downloaded but never appears
as the current revision, and is excluded from expiry alerts — chasing the
renewal of a document that has already been renewed is noise.

## 46.5 Seeded document types

Seeded because an empty list means the first user invents `Labour Licence`,
the second invents `labour license`, and the register stops being answerable.
Each seed carries its statutory basis, notice window, retention period and
whether its lapse stops work.

Statutory and licensing: GST registration, PAN, TAN, Udyam, EPF code, ESIC
code, labour licence, BOCW registration, shops and establishments, professional
tax registration.
Insurance: CAR policy, workmen's compensation, third-party liability, vehicle
insurance.
Equipment and vehicle: lifting tackle test certificate, fitness certificate,
permit, PUC.
People: driving licence, medical fitness, safety training card, employment
contract, educational certificate.
Commercial: bank guarantee, EMD, work order, agreement, drawing, bid document.

## 46.6 Controls

**46.6.1** Retention is a property of the type. Deletion is refused before the
retention period has run from the document's expiry or issue date.

**46.6.2** A **legal hold** on a document refuses deletion outright, regardless
of retention, until the hold is released. Placing and releasing a hold are
separate permissions and both are audited.

**46.6.3** Confidential types (salary, medical, identity) are visible only with
an explicit permission, not to anyone who can see the register.

**46.6.4** Every write goes through `mutate()` and produces an audit event, as
elsewhere.

## 46.7 Explicitly out of scope

- Migrating existing stored content into the register. The register indexes;
  the bytes stay where they are.
- Optical character recognition, or reading an expiry date out of a scan.
- Controlled distribution and recall — knowing which site office holds a paper
  copy of which revision. Worth doing; needs a distribution list model that
  does not exist yet.
- Digital signatures and DSC management.
