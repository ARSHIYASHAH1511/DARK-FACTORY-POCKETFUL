\# Stage 1 — Deterministic Double-Entry Ledger



\## Goal



Build the smallest correct transaction ledger before introducing

concurrency, retries, auditing, or multi-currency behavior.



\## Core Invariants



1\. Every transaction must be balanced.

2\. Amounts must be positive integer minor units.

3\. Debit and credit accounts must exist.

4\. Debit and credit accounts must be different.

5\. Transaction IDs must be unique.

6\. The total ledger balance must remain zero.



\## Implementation



`ledger.py` provides:



\- Account creation

\- Account balance lookup

\- Double-entry transaction posting

\- Transaction ID protection

\- Input validation



\## Verification



Run:



```powershell

python -m pytest -v
Expected result:



```text

7 passed

