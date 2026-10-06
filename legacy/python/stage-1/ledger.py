from dataclasses import dataclass


class LedgerError(Exception):
    """Base exception for ledger errors."""


@dataclass(frozen=True)
class Entry:
    account: str
    amount: int


class Ledger:
    """
    Minimal double-entry ledger.

    Invariant:
        For every transaction, total debits == total credits.

    Amounts are integer minor units (for example, paise/cents).
    """

    def __init__(self):
        self.balances: dict[str, int] = {}
        self.transactions: list[tuple[str, list[Entry]]] = []

    def create_account(self, account: str) -> None:
        if not account:
            raise LedgerError("Account name cannot be empty")

        if account in self.balances:
            raise LedgerError(f"Account already exists: {account}")

        self.balances[account] = 0

    def balance(self, account: str) -> int:
        if account not in self.balances:
            raise LedgerError(f"Unknown account: {account}")

        return self.balances[account]

    def post(
        self,
        transaction_id: str,
        debit_account: str,
        credit_account: str,
        amount: int,
    ) -> None:
        if not transaction_id:
            raise LedgerError("Transaction ID cannot be empty")

        if debit_account not in self.balances:
            raise LedgerError(f"Unknown account: {debit_account}")

        if credit_account not in self.balances:
            raise LedgerError(f"Unknown account: {credit_account}")

        if debit_account == credit_account:
            raise LedgerError("Debit and credit accounts must differ")

        if amount <= 0:
            raise LedgerError("Amount must be positive")

        if any(tx_id == transaction_id for tx_id, _ in self.transactions):
            raise LedgerError(f"Duplicate transaction: {transaction_id}")

        entries = [
            Entry(debit_account, -amount),
            Entry(credit_account, amount),
        ]

        # Double-entry invariant.
        if sum(entry.amount for entry in entries) != 0:
            raise LedgerError("Transaction is not balanced")

        for entry in entries:
            self.balances[entry.account] += entry.amount

        self.transactions.append((transaction_id, entries))

    def total_balance(self) -> int:
        return sum(self.balances.values())
