import sqlite3
from datetime import datetime, timezone


class LedgerError(Exception):
    pass


class SettlementLedger:
    def __init__(self, db_path="settlement.db"):
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
                    currency TEXT NOT NULL,
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
                    currency TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY (debit_account) REFERENCES accounts(account_id),
                    FOREIGN KEY (credit_account) REFERENCES accounts(account_id)
                )
                """
            )

            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS holds (
                    hold_id TEXT PRIMARY KEY,
                    account_id TEXT NOT NULL,
                    amount INTEGER NOT NULL,
                    currency TEXT NOT NULL,
                    status TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY (account_id) REFERENCES accounts(account_id)
                )
                """
            )

    def _now(self):
        return datetime.now(timezone.utc).isoformat()

    def create_account(self, account_id, currency, initial_balance=0):
        if not account_id:
            raise LedgerError("account_id cannot be empty")

        if not currency:
            raise LedgerError("currency cannot be empty")

        if not isinstance(initial_balance, int) or initial_balance < 0:
            raise LedgerError("initial_balance must be a non-negative integer")

        with self._connect() as connection:
            try:
                connection.execute(
                    """
                    INSERT INTO accounts(account_id, currency, balance)
                    VALUES (?, ?, ?)
                    """,
                    (account_id, currency.upper(), initial_balance),
                )
            except sqlite3.IntegrityError:
                raise LedgerError("account already exists")

    def balance(self, account_id):
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT balance
                FROM accounts
                WHERE account_id = ?
                """,
                (account_id,),
            ).fetchone()

        if row is None:
            raise LedgerError("unknown account")

        return row[0]

    def currency(self, account_id):
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT currency
                FROM accounts
                WHERE account_id = ?
                """,
                (account_id,),
            ).fetchone()

        if row is None:
            raise LedgerError("unknown account")

        return row[0]

    def available_balance(self, account_id):
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT
                    a.balance -
                    COALESCE(
                        (
                            SELECT SUM(h.amount)
                            FROM holds h
                            WHERE h.account_id = a.account_id
                            AND h.status = 'HELD'
                        ),
                        0
                    )
                FROM accounts a
                WHERE a.account_id = ?
                """,
                (account_id,),
            ).fetchone()

        if row is None:
            raise LedgerError("unknown account")

        return row[0]

    def post(
        self,
        transaction_id,
        debit_account,
        credit_account,
        amount,
    ):
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
                SELECT debit_account, credit_account, amount, currency
                FROM transactions
                WHERE transaction_id = ?
                """,
                (transaction_id,),
            ).fetchone()

            if existing is not None:
                if existing[:3] == (
                    debit_account,
                    credit_account,
                    amount,
                ):
                    connection.execute("COMMIT")
                    return "already_applied"

                raise LedgerError("transaction_id already used")

            debit = connection.execute(
                """
                SELECT currency, balance
                FROM accounts
                WHERE account_id = ?
                """,
                (debit_account,),
            ).fetchone()

            credit = connection.execute(
                """
                SELECT currency
                FROM accounts
                WHERE account_id = ?
                """,
                (credit_account,),
            ).fetchone()

            if debit is None or credit is None:
                raise LedgerError("unknown account")

            debit_currency, debit_balance = debit
            credit_currency = credit[0]

            if debit_currency != credit_currency:
                raise LedgerError("currency mismatch")

            available = connection.execute(
                """
                SELECT
                    ? -
                    COALESCE(
                        (
                            SELECT SUM(amount)
                            FROM holds
                            WHERE account_id = ?
                            AND status = 'HELD'
                        ),
                        0
                    )
                """,
                (debit_balance, debit_account),
            ).fetchone()[0]

            if available < amount:
                raise LedgerError("insufficient available balance")

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
                    currency,
                    created_at
                )
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    transaction_id,
                    debit_account,
                    credit_account,
                    amount,
                    debit_currency,
                    now,
                ),
            )

            connection.execute("COMMIT")
            return "applied"

        except Exception:
            connection.execute("ROLLBACK")
            raise

        finally:
            connection.close()

    def create_hold(self, hold_id, account_id, amount):
        if not hold_id:
            raise LedgerError("hold_id cannot be empty")

        if not isinstance(amount, int) or amount <= 0:
            raise LedgerError("amount must be a positive integer")

        connection = self._connect()

        try:
            connection.execute("BEGIN IMMEDIATE")

            account = connection.execute(
                """
                SELECT currency, balance
                FROM accounts
                WHERE account_id = ?
                """,
                (account_id,),
            ).fetchone()

            if account is None:
                raise LedgerError("unknown account")

            currency, balance = account

            existing = connection.execute(
                """
                SELECT status
                FROM holds
                WHERE hold_id = ?
                """,
                (hold_id,),
            ).fetchone()

            if existing is not None:
                raise LedgerError("hold_id already exists")

            held_amount = connection.execute(
                """
                SELECT COALESCE(SUM(amount), 0)
                FROM holds
                WHERE account_id = ?
                AND status = 'HELD'
                """,
                (account_id,),
            ).fetchone()[0]

            if balance - held_amount < amount:
                raise LedgerError("insufficient available balance")

            connection.execute(
                """
                INSERT INTO holds(
                    hold_id,
                    account_id,
                    amount,
                    currency,
                    status,
                    created_at
                )
                VALUES (?, ?, ?, ?, 'HELD', ?)
                """,
                (
                    hold_id,
                    account_id,
                    amount,
                    currency,
                    self._now(),
                ),
            )

            connection.execute("COMMIT")
            return "held"

        except Exception:
            connection.execute("ROLLBACK")
            raise

        finally:
            connection.close()

    def release_hold(self, hold_id):
        connection = self._connect()

        try:
            connection.execute("BEGIN IMMEDIATE")

            hold = connection.execute(
                """
                SELECT status
                FROM holds
                WHERE hold_id = ?
                """,
                (hold_id,),
            ).fetchone()

            if hold is None:
                raise LedgerError("unknown hold")

            if hold[0] != "HELD":
                raise LedgerError("hold is not active")

            connection.execute(
                """
                UPDATE holds
                SET status = 'RELEASED'
                WHERE hold_id = ?
                """,
                (hold_id,),
            )

            connection.execute("COMMIT")
            return "released"

        except Exception:
            connection.execute("ROLLBACK")
            raise

        finally:
            connection.close()

    def capture_hold(self, hold_id, credit_account, transaction_id):
        connection = self._connect()

        try:
            connection.execute("BEGIN IMMEDIATE")

            hold = connection.execute(
                """
                SELECT account_id, amount, currency, status
                FROM holds
                WHERE hold_id = ?
                """,
                (hold_id,),
            ).fetchone()

            if hold is None:
                raise LedgerError("unknown hold")

            debit_account, amount, currency, status = hold

            if status != "HELD":
                raise LedgerError("hold is not active")

            credit = connection.execute(
                """
                SELECT currency
                FROM accounts
                WHERE account_id = ?
                """,
                (credit_account,),
            ).fetchone()

            if credit is None:
                raise LedgerError("unknown account")

            if credit[0] != currency:
                raise LedgerError("currency mismatch")

            existing_transaction = connection.execute(
                """
                SELECT transaction_id
                FROM transactions
                WHERE transaction_id = ?
                """,
                (transaction_id,),
            ).fetchone()

            if existing_transaction is not None:
                raise LedgerError("transaction_id already used")

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
                    currency,
                    created_at
                )
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    transaction_id,
                    debit_account,
                    credit_account,
                    amount,
                    currency,
                    now,
                ),
            )

            connection.execute(
                """
                UPDATE holds
                SET status = 'CAPTURED'
                WHERE hold_id = ?
                """,
                (hold_id,),
            )

            connection.execute("COMMIT")
            return "captured"

        except Exception:
            connection.execute("ROLLBACK")
            raise

        finally:
            connection.close()