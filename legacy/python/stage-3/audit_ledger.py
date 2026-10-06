import sqlite3
from datetime import datetime, timezone


class LedgerError(Exception):
    pass


class AuditLedger:
    def __init__(self, db_path="audit_ledger.db"):
        self.db_path = str(db_path)
        self._initialize()

    def _connect(self):
        connection = sqlite3.connect(
            self.db_path,
            timeout=5,
            isolation_level=None,
        )
        connection.execute("PRAGMA foreign_keys = ON")
        return connection

    def _initialize(self):
        with self._connect() as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS accounts (
                    account_id TEXT PRIMARY KEY,
                    balance INTEGER NOT NULL DEFAULT 0
                )
                """
            )

            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS transactions (
                    transaction_id TEXT PRIMARY KEY,
                    debit_account TEXT NOT NULL,
                    credit_account TEXT NOT NULL,
                    amount INTEGER NOT NULL,
                    created_at TEXT NOT NULL,
                    reversed_by TEXT,
                    FOREIGN KEY (debit_account) REFERENCES accounts(account_id),
                    FOREIGN KEY (credit_account) REFERENCES accounts(account_id)
                )
                """
            )

            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS audit_events (
                    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
                    transaction_id TEXT NOT NULL,
                    event_type TEXT NOT NULL,
                    event_time TEXT NOT NULL,
                    details TEXT
                )
                """
            )

    def _now(self):
        return datetime.now(timezone.utc).isoformat()

    def create_account(self, account_id):
        if not account_id:
            raise LedgerError("account_id cannot be empty")

        with self._connect() as connection:
            try:
                connection.execute(
                    "INSERT INTO accounts(account_id, balance) VALUES (?, 0)",
                    (account_id,),
                )
            except sqlite3.IntegrityError:
                raise LedgerError("account already exists")

    def balance(self, account_id):
        with self._connect() as connection:
            row = connection.execute(
                "SELECT balance FROM accounts WHERE account_id = ?",
                (account_id,),
            ).fetchone()

        if row is None:
            raise LedgerError("unknown account")

        return row[0]

    def post(self, transaction_id, debit_account, credit_account, amount):
        if not transaction_id:
            raise LedgerError("transaction_id cannot be empty")

        if debit_account == credit_account:
            raise LedgerError("debit and credit accounts must differ")

        if not isinstance(amount, int) or amount <= 0:
            raise LedgerError("amount must be a positive integer")

        connection = self._connect()

        try:
            connection.execute("BEGIN IMMEDIATE")

            existing = connection.execute(
                """
                SELECT debit_account, credit_account, amount
                FROM transactions
                WHERE transaction_id = ?
                """,
                (transaction_id,),
            ).fetchone()

            if existing is not None:
                if existing == (debit_account, credit_account, amount):
                    connection.execute("COMMIT")
                    return "already_applied"

                raise LedgerError("transaction_id already used")

            accounts = connection.execute(
                """
                SELECT account_id
                FROM accounts
                WHERE account_id IN (?, ?)
                """,
                (debit_account, credit_account),
            ).fetchall()

            if len(accounts) != 2:
                raise LedgerError("unknown account")

            now = self._now()

            connection.execute(
                """
                UPDATE accounts
                SET balance = balance - ?
                WHERE account_id = ?
                """,
                (amount, debit_account),
            )

            connection.execute(
                """
                UPDATE accounts
                SET balance = balance + ?
                WHERE account_id = ?
                """,
                (amount, credit_account),
            )

            connection.execute(
                """
                INSERT INTO transactions(
                    transaction_id,
                    debit_account,
                    credit_account,
                    amount,
                    created_at
                )
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    transaction_id,
                    debit_account,
                    credit_account,
                    amount,
                    now,
                ),
            )

            connection.execute(
                """
                INSERT INTO audit_events(
                    transaction_id,
                    event_type,
                    event_time,
                    details
                )
                VALUES (?, ?, ?, ?)
                """,
                (
                    transaction_id,
                    "POSTED",
                    now,
                    f"{debit_account}->{credit_account}:{amount}",
                ),
            )

            connection.execute("COMMIT")
            return "applied"

        except Exception:
            connection.execute("ROLLBACK")
            raise

        finally:
            connection.close()

    def reverse(self, transaction_id):
        connection = self._connect()

        try:
            connection.execute("BEGIN IMMEDIATE")

            transaction = connection.execute(
                """
                SELECT debit_account, credit_account, amount, reversed_by
                FROM transactions
                WHERE transaction_id = ?
                """,
                (transaction_id,),
            ).fetchone()

            if transaction is None:
                raise LedgerError("unknown transaction")

            debit_account, credit_account, amount, reversed_by = transaction

            if reversed_by is not None:
                raise LedgerError("transaction already reversed")

            reversal_id = f"REV-{transaction_id}"
            now = self._now()

            connection.execute(
                """
                UPDATE accounts
                SET balance = balance + ?
                WHERE account_id = ?
                """,
                (amount, debit_account),
            )

            connection.execute(
                """
                UPDATE accounts
                SET balance = balance - ?
                WHERE account_id = ?
                """,
                (amount, credit_account),
            )

            connection.execute(
                """
                UPDATE transactions
                SET reversed_by = ?
                WHERE transaction_id = ?
                """,
                (reversal_id, transaction_id),
            )

            connection.execute(
                """
                INSERT INTO transactions(
                    transaction_id,
                    debit_account,
                    credit_account,
                    amount,
                    created_at
                )
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    reversal_id,
                    credit_account,
                    debit_account,
                    amount,
                    now,
                ),
            )

            connection.execute(
                """
                INSERT INTO audit_events(
                    transaction_id,
                    event_type,
                    event_time,
                    details
                )
                VALUES (?, ?, ?, ?)
                """,
                (
                    reversal_id,
                    "REVERSAL",
                    now,
                    f"reversal_of={transaction_id}",
                ),
            )

            connection.execute("COMMIT")
            return reversal_id

        except Exception:
            connection.execute("ROLLBACK")
            raise

        finally:
            connection.close()

    def audit_trail(self, transaction_id):
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT event_type, event_time, details
                FROM audit_events
                WHERE transaction_id = ?
                ORDER BY event_id
                """,
                (transaction_id,),
            ).fetchall()

        return rows