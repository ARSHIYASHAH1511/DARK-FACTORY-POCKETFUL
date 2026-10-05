
# 🏭 DARK FACTORY — Pocketful

### Zero-Trust Multi-Currency Ledger & Settlement Engine

**Pocketful** is a resilient financial ledger and settlement engine built inside a structured **Dark Factory** engineering workflow.

The system evolves from a core double-entry ledger into a persistent, concurrent, auditable, multi-currency settlement engine with escrow holds.

The project follows the **BAND workflow**:

> **Architect → Implementer → Adversary → Verifier**

Instead of treating testing as the final step, Pocketful deliberately separates system design, implementation, adversarial testing, and independent verification.

---

## 📖 Overview

Financial systems require strong guarantees around:

- Balance integrity
- Double-entry accounting
- Duplicate transaction protection
- Concurrent operations
- Auditability
- Transaction reversal
- Currency isolation
- Escrowed funds
- State-transition safety

Pocketful addresses these requirements through four sequential engineering stages.

Each stage adds a new layer of capability while preserving the invariants established by the previous stages.

---

# 🔁 The BAND Development Workflow

BAND separates engineering responsibilities into four distinct roles.

```text
┌──────────────────────────────────────────────────────────────┐
│                         ARCHITECT                            │
│                                                              │
│ Defines requirements, invariants, boundaries and edge cases  │
└──────────────────────────────┬───────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────┐
│                        IMPLEMENTER                           │
│                                                              │
│ Implements the requirements and builds the test foundation   │
└──────────────────────────────┬───────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────┐
│                         ADVERSARY                            │
│                                                              │
│ Attempts to break the implementation through edge cases,    │
│ invalid states, duplicate requests and concurrency           │
└──────────────────────────────┬───────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────┐
│                          VERIFIER                            │
│                                                              │
│ Independently validates requirements, invariants, regressions│
│ and adversarial behavior                                     │
└──────────────────────────────┬───────────────────────────────┘
                               │
                               ▼
                     ┌─────────────────┐
                     │     VERIFIED    │
                     │     RELEASE     │
                     └─────────────────┘
````

### BAND Roles

| Role            | Responsibility                                              | Evidence                |
| --------------- | ----------------------------------------------------------- | ----------------------- |
| **Architect**   | Defines requirements, invariants, boundaries and edge cases | Architecture mandates   |
| **Implementer** | Builds the system against the defined requirements          | Implementation + tests  |
| **Adversary**   | Attempts to break the implementation                        | Adversarial test suite  |
| **Verifier**    | Independently validates the completed system                | Full verification suite |

The role mandates are stored in:

```text
.band/mandates/
├── 01_architect.md
├── 02_implementer.md
├── 03_adversary.md
└── 04_verifier.md
```

---

# 🚀 System Evolution

Pocketful was developed through four sequential engineering stages.

```text
┌──────────────┐
│   STAGE 1    │
│ Double-Entry  │
│   Ledger      │
└──────┬───────┘
       │
       ▼
┌──────────────┐
│   STAGE 2    │
│ Persistence + │
│ Concurrency   │
└──────┬───────┘
       │
       ▼
┌──────────────┐
│   STAGE 3    │
│ Audit Trail + │
│   Reversal    │
└──────┬───────┘
       │
       ▼
┌──────────────┐
│   STAGE 4    │
│ Multi-Currency│
│ + Escrow      │
└──────────────┘
```

---

## 1️⃣ Stage 1 — Double-Entry Ledger

The foundation introduces a basic double-entry ledger.

### Capabilities

* Account creation
* Balance tracking
* Double-entry transactions
* Zero-sum transaction validation
* Positive-amount validation
* Unknown-account rejection
* Duplicate transaction protection

### Verification

```text
7/7 tests passed
```

---

## 2️⃣ Stage 2 — Persistent & Concurrent Ledger

The second stage introduces SQLite-backed persistence and concurrency protection.

### Capabilities

* SQLite persistence
* Atomic transaction processing
* Transaction idempotency
* Transaction ID reuse protection
* Concurrent transaction handling
* Safe retry behavior

### Verification

```text
3/3 tests passed
```

---

## 3️⃣ Stage 3 — Audit Trail & Reversal

The third stage introduces transaction history and controlled reversal.

### Capabilities

* Transaction timestamps
* Audit events
* Reversal transactions
* Original transaction preservation
* Double-reversal protection
* Atomic reversal operations
* Zero-sum preservation

### Verification

```text
6/6 tests passed
```

---

## 4️⃣ Stage 4 — Multi-Currency Settlement & Escrow

The final stage extends the ledger into a settlement engine.

### Capabilities

* Currency-aware accounts
* Currency mismatch protection
* Available balance calculation
* Escrow holds
* Hold creation
* Hold release
* Hold capture
* Protection against spending held funds
* Concurrent hold protection
* Settlement transaction recording

### Verification

```text
8/8 tests passed
```

---

# 🧮 Core Safety Invariants

Pocketful maintains several important accounting and state invariants.

### 1. Double-Entry Integrity

Every successful transfer maintains the zero-sum property:

```text
Total Debits + Total Credits = 0
```

A debit decreases one account while the corresponding credit increases another account by the same amount.

---

### 2. Available Balance Integrity

For an account with active escrow holds:

```text
Available Balance =
Account Balance − Active Held Amount
```

Funds reserved by an active hold cannot be spent by another transaction.

---

### 3. Currency Isolation

Settlement between accounts using different currencies is rejected.

```text
USD → USD   ✓
EUR → EUR   ✓
USD → EUR   ✗
```

---

### 4. Hold State Integrity

A hold follows a controlled lifecycle:

```text
             ┌───────────┐
             │   HELD    │
             └─────┬─────┘
                   / \
                  /   \
                 ▼     ▼
          ┌─────────┐ ┌──────────┐
          │RELEASED │ │ CAPTURED │
          └─────────┘ └──────────┘
```

Once a hold is released or captured, it cannot be processed again.

---

### 5. Concurrency Safety

Critical state-changing operations use SQLite write transactions to prevent concurrent requests from oversubscribing available funds.

This was explicitly tested through concurrent hold creation.

---

# 🧪 Verification

The complete repository was independently verified using:

```bash
python -m pytest -v
```

Final verification result:

```text
24 passed
```

### Verification Matrix

| Stage     | Scope                                  |      Result |
| --------- | -------------------------------------- | ----------: |
| Stage 1   | Double-entry ledger                    |       ✅ 7/7 |
| Stage 2   | Persistence, idempotency & concurrency |       ✅ 3/3 |
| Stage 3   | Audit trail & reversal                 |       ✅ 6/6 |
| Stage 4   | Multi-currency & escrow                |       ✅ 8/8 |
| **TOTAL** | **Complete system**                    | **✅ 24/24** |

The complete verification evidence is recorded in:

```text
VERIFICATION.md
```

---

# 🧪 Adversarial Testing

The Adversary stage specifically targets failure conditions rather than only happy paths.

The Stage 4 adversarial suite verifies:

* Currency mismatches
* Held-fund spending attempts
* Insufficient available balance
* Hold release
* Hold capture
* Invalid hold state transitions
* Currency mismatch during capture
* Concurrent hold oversubscription

All Stage 4 adversarial tests passed:

```text
8/8 PASSED
```

---

# 📂 Repository Structure

```text
DARK-FACTORY-POCKETFUL/
│
├── .band/
│   └── mandates/
│       ├── 01_architect.md
│       ├── 02_implementer.md
│       ├── 03_adversary.md
│       └── 04_verifier.md
│
├── stage-1/
│   ├── README.md
│   ├── ledger.py
│   └── test_ledger.py
│
├── stage-2/
│   ├── README.md
│   ├── ledger_db.py
│   └── test_concurrency.py
│
├── stage-3/
│   ├── README.md
│   ├── audit_ledger.py
│   └── test_audit.py
│
├── stage-4/
│   ├── README.md
│   ├── settlement_ledger.py
│   └── test_settlement.py
│
├── FACTORY.md
├── VERIFICATION.md
├── README.md
└── .gitignore
```

---

# ⚡ Quick Start

## Requirements

* Python 3.10+
* `pytest`
* SQLite support through Python's standard library

## Clone

```bash
git clone https://github.com/ARSHIYASHAH1511/DARK-FACTORY-POCKETFUL.git
cd DARK-FACTORY-POCKETFUL
```

## Run the complete verification suite

```bash
python -m pytest -v
```

Expected result:

```text
24 passed
```

---

# 🏭 Factory Discipline

The project follows a strict development sequence:

```text
1. ARCHITECT
   Define the requirements and invariants.

2. IMPLEMENTER
   Build the requested behavior.

3. ADVERSARY
   Attempt to break the implementation.

4. VERIFIER
   Independently validate the complete system.

5. RELEASE
   Record the evidence and ship only after verification.
```

The purpose of the workflow is to make **failure discovery a deliberate engineering activity**, rather than something left until deployment.

---

# 🏆 Current Status

```text
┌─────────────────────────────────────────────┐
│                                             │
│       DARK FACTORY — POCKETFUL              │
│                                             │
│       BAND STATUS: VERIFIED                 │
│                                             │
│       4 Engineering Stages                 │
│       24 Automated Tests                    │
│       24 Tests Passed                       │
│       Adversarial Testing                   │
│       Concurrency Testing                   │
│       Clean Git Repository                  │
│                                             │
└─────────────────────────────────────────────┘
```

**Architect → Implementer → Adversary → Verifier → VERIFIED**

---

*Engineered inside the Dark Factory framework.*

```


```
