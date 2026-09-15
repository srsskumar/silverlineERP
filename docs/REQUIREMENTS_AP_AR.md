# 58. Accounts Payable & Receivable (NEW)

*Extends §15 (Financial & Payment Management) and §45 (Financial Control). Written
after §45 shipped, because building the payment ledger made three gaps obvious.*

Silverline scoped a general ledger out of v1 (§2.3), and that stands. What
follows is not accounting — it is the two operational questions a contracting
business asks every week:

- **Who owes us, how long have they owed it, and is any of it at risk?**
- **Whom do we owe, what must be paid by law this week, and what may wait?**

---

## 58.1 Why the existing layer is not enough

§45 gave us payments, allocations and a settlement position per document. Three
things are missing, and each is a specific failure rather than a nice-to-have.

**58.1.1 There is no receivables ledger at all.** `/api/v1/finance/outstanding`
ages vendor invoices — that is *payables*, despite the neutral name. RA bills
are certified and then tracked nowhere, so the one number a contracting
business lives by, "what has the client not paid", cannot be produced.

**58.1.2 Ageing that counts retention is wrong.** Retention is withheld under
the contract until the defect liability period ends. It is owed, but it is not
*collectable*. An ageing report that drops it into the 90-plus bucket sends the
collections team to chase money the client is entitled to hold, which wastes
their time and damages the relationship. Retention belongs in its own column
with its release date, not in the overdue analysis.

**58.1.3 Payables ageing on 30/60/90 understates a statutory liability.**
Where the supplier is a registered micro or small enterprise, s.15 of the MSMED
Act 2006 fixes the payment period at 45 days where there is a written
agreement and 15 days where there is not — regardless of the credit terms
negotiated. s.16 then accrues interest at three times the RBI bank rate,
compounded monthly, and that interest is not deductible for income tax.

A generic ageing bucket hides this: an MSME invoice 40 days old is *nearly
overdue by law* while sitting comfortably in "0–60 days". The company also has
to disclose the amount and interest in its annual accounts. This is the single
most commonly mishandled payables rule in Indian mid-market ERP.

---

## 58.2 Receivables (AR)

**58.2.1 Ledger.** Every certified RA bill, less what has been settled, aged
from its due date. The due date is the certification date plus the payment
terms on the project's billing policy; where no terms are recorded the bill is
listed as *undated* rather than assumed current, because assuming makes an
unknown look like a good number.

**58.2.2 Buckets.** Not yet due, 1–30, 31–60, 61–90, over 90. Disputed amounts
are reported separately and never inside an age bucket — a dispute is a
different problem from slow payment and goes to a different person.

**58.2.3 Retention.** Reported as its own figure with the DLP end date, and
excluded from both the buckets and the overdue total.

**58.2.4 Credit exposure.** Against `clients.credit_limit` where one is set:
outstanding plus work certified but not yet billed. A limit that is only
checked at order time is not a control; it has to be visible as it is consumed.

**58.2.5 Statement of account.** Per client: opening balance, every bill and
receipt in the period, closing balance. This is what gets emailed when a client
disputes the total, so it must reconcile exactly to the ledger.

**58.2.6 Days sales outstanding.** Outstanding divided by credit sales in the
period, times the days in the period. Reported alongside the period used,
because a DSO with no stated window is not a number anybody can act on.

---

## 58.3 Payables (AP)

**58.3.1 Ledger.** Vendor invoices, approved expense claims awaiting
reimbursement, and retention held against subcontractors, each less what has
been paid.

**58.3.2 Statutory due date.** For a supplier with a Udyam registration and an
MSME category, the due date is the MSMED date, not the negotiated terms — and
where the two differ, the earlier one governs. The report shows both so the
difference is visible rather than silently applied.

**58.3.3 Accrued interest.** For every MSME invoice past its statutory date,
interest at three times the RBI bank rate compounded monthly, shown as a
running figure. It is a real liability whether or not anybody has recorded it.

**58.3.4 Payment run.** Select what is due, produce a batch, approve it, then
record the payments. The batch must refuse:

- an invoice under dispute;
- an invoice whose three-way match has not passed, unless somebody holds the
  match override and states why;
- a document already fully settled.

Ordering is by statutory due date first and negotiated due date second, so the
invoices that carry a legal consequence are paid before those that merely carry
a relationship one.

**58.3.5 Hold.** A payable may be put on hold with a reason. A held document is
excluded from the payment run but stays in the ageing, because the money is
still owed — hiding it would make the payables position look better than it is.

---

## 58.4 Controls

- Neither ledger is a stored balance. Both are derived from the documents and
  their allocations, for the reason given in §45: a cached total and a ledger
  of payments eventually disagree, and the ledger is always right.
- A payment run is approved by somebody other than whoever built it. Building a
  batch and releasing it single-handed is how a payment to an unintended
  account leaves the building.
- Nothing is hard-deleted (§45.5). A cancelled run stays, with its reason.

## 58.5 Explicitly out of scope

General ledger, trial balance, journal entries, and statutory filing (GSTR,
TDS returns). This layer produces the figures those processes consume; it does
not replace an accounting package.
