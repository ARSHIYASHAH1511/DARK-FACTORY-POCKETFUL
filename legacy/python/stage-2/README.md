\# Stage 2 — Idempotency and Concurrency



\## Goal



Make transaction processing safe when requests are retried or executed

concurrently.



\## Guarantees



1\. A transaction ID can be successfully applied only once.

2\. Retrying the exact same transaction is idempotent.

3\. Reusing a transaction ID for different transaction data is rejected.

4\. Concurrent requests for the same transaction cannot double-apply it.

5\. Ledger balances remain consistent after concurrent execution.

6\. Failed transactions do not leave partial updates.



\## Implementation



`ledger\_db.py` provides:



\- SQLite-backed account storage

\- Persistent transaction records

\- Transaction ID uniqueness

\- Idempotent retry handling

\- Atomic transaction processing

\- SQLite write-lock coordination



The transaction operation uses SQLite's `BEGIN IMMEDIATE` transaction mode

to coordinate concurrent writers.



\## Adversarial Verification



`test\_concurrency.py` verifies:



\- Idempotent retries

\- Transaction ID reuse protection

\- Concurrent duplicate requests

\- Final balance integrity



\## Verification



Run:



```powershell

python -m pytest stage-2 -v

