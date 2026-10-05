import pytest

from ledger import Ledger, LedgerError


def make_ledger():
    ledger = Ledger()
    ledger.create_account("alice")
    ledger.create_account("merchant")
    return ledger


def test_new_accounts_start_at_zero():
    ledger = make_ledger()

    assert ledger.balance("alice") == 0
    assert ledger.balance("merchant") == 0


def test_transfer_updates_both_accounts():
    ledger = make_ledger()

    ledger.post("tx-001", "alice", "merchant", 500)

    assert ledger.balance("alice") == -500
    assert ledger.balance("merchant") == 500


def test_every_transaction_is_zero_sum():
    ledger = make_ledger()

    ledger.post("tx-001", "alice", "merchant", 500)
    ledger.post("tx-002", "merchant", "alice", 200)

    assert ledger.total_balance() == 0


def test_negative_amount_is_rejected():
    ledger = make_ledger()

    with pytest.raises(LedgerError):
        ledger.post("tx-001", "alice", "merchant", -100)


def test_zero_amount_is_rejected():
    ledger = make_ledger()

    with pytest.raises(LedgerError):
        ledger.post("tx-001", "alice", "merchant", 0)


def test_duplicate_transaction_is_rejected():
    ledger = make_ledger()

    ledger.post("tx-001", "alice", "merchant", 500)

    with pytest.raises(LedgerError):
        ledger.post("tx-001", "alice", "merchant", 500)


def test_unknown_account_is_rejected():
    ledger = make_ledger()

    with pytest.raises(LedgerError):
        ledger.post("tx-001", "unknown", "merchant", 500)
