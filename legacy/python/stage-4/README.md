\# Stage 4 — Multi-Currency Settlement and Escrow Holds



\## Goal



Extend the ledger with:



\- Multi-currency accounts

\- Currency-safe settlement

\- Escrow holds

\- Hold release

\- Hold capture

\- Concurrency-safe hold creation



\## Guarantees



\### Currency Safety



Transfers between accounts using different currencies are rejected.



\### Available Balance



Funds placed on an active hold are excluded from available balance.



\### Spending Protection



A transaction cannot spend funds that are already reserved by active holds.



\### Hold Creation



A hold can only be created when sufficient available funds exist.



\### Hold Release



Releasing an active hold restores those funds to available balance.



\### Hold Capture



Capturing an active hold:



1\. Debits the held amount from the original account.

2\. Credits the settlement account.

3\. Records a settlement transaction.

4\. Marks the hold as captured.



\### Hold State Safety



A hold cannot be captured or released after it is no longer active.



\### Concurrency



Hold creation uses SQLite write transactions so concurrent requests cannot oversubscribe available funds.



\## Adversarial Verification



Stage 4 was tested against:



1\. Currency mismatch

2\. Available balance after a hold

3\. Spending held funds

4\. Hold release

5\. Hold capture

6\. Double capture/release

7\. Currency mismatch during capture

8\. Concurrent hold creation



Result:



\*\*8 tests passed.\*\*



\## Files



\- `settlement\_ledger.py` — settlement and escrow implementation

\- `test\_settlement.py` — adversarial and concurrency tests

