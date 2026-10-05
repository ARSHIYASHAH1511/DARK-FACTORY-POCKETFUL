import threading

import pytest

from settlement_ledger import LedgerError, SettlementLedger


def make_ledger(tmp_path):
    return SettlementLedger(tmp_path / "settlement.db")


def test_currency_mismatch_rejected(tmp_path):
    ledger = make_ledger(tmp_path)

    ledger.create_account("alice", "USD", 1000)
    ledger.create_account("bob", "EUR", 1000)

    with pytest.raises(LedgerError, match="currency mismatch"):
        ledger.post("TX-1", "alice", "bob", 100)


def test_hold_reduces_available_balance(tmp_path):
    ledger = make_ledger(tmp_path)

    ledger.create_account("alice", "USD", 1000)

    assert ledger.balance("alice") == 1000
    assert ledger.available_balance("alice") == 1000

    ledger.create_hold("H-1", "alice", 400)

    assert ledger.balance("alice") == 1000
    assert ledger.available_balance("alice") == 600


def test_cannot_spend_held_funds(tmp_path):
    ledger = make_ledger(tmp_path)

    ledger.create_account("alice", "USD", 1000)
    ledger.create_account("bob", "USD", 1000)

    ledger.create_hold("H-1", "alice", 800)

    with pytest.raises(LedgerError, match="insufficient available balance"):
        ledger.post("TX-1", "alice", "bob", 300)


def test_release_restores_available_balance(tmp_path):
    ledger = make_ledger(tmp_path)

    ledger.create_account("alice", "USD", 1000)

    ledger.create_hold("H-1", "alice", 400)

    assert ledger.available_balance("alice") == 600

    ledger.release_hold("H-1")

    assert ledger.available_balance("alice") == 1000


def test_capture_settles_hold(tmp_path):
    ledger = make_ledger(tmp_path)

    ledger.create_account("alice", "USD", 1000)
    ledger.create_account("merchant", "USD", 200)

    ledger.create_hold("H-1", "alice", 400)

    result = ledger.capture_hold("H-1", "merchant", "TX-CAPTURE")

    assert result == "captured"
    assert ledger.balance("alice") == 600
    assert ledger.balance("merchant") == 600
    assert ledger.available_balance("alice") == 600


def test_cannot_capture_or_release_twice(tmp_path):
    ledger = make_ledger(tmp_path)

    ledger.create_account("alice", "USD", 1000)
    ledger.create_account("merchant", "USD", 0)

    ledger.create_hold("H-1", "alice", 400)

    ledger.capture_hold("H-1", "merchant", "TX-CAPTURE")

    with pytest.raises(LedgerError, match="hold is not active"):
        ledger.capture_hold("H-1", "merchant", "TX-CAPTURE-2")

    with pytest.raises(LedgerError, match="hold is not active"):
        ledger.release_hold("H-1")


def test_capture_rejects_currency_mismatch(tmp_path):
    ledger = make_ledger(tmp_path)

    ledger.create_account("alice", "USD", 1000)
    ledger.create_account("merchant", "EUR", 0)

    ledger.create_hold("H-1", "alice", 400)

    with pytest.raises(LedgerError, match="currency mismatch"):
        ledger.capture_hold("H-1", "merchant", "TX-CAPTURE")


def test_concurrent_holds_cannot_oversubscribe(tmp_path):
    ledger = make_ledger(tmp_path)

    ledger.create_account("alice", "USD", 500)

    results = []
    lock = threading.Lock()

    def attempt_hold(index):
        try:
            result = ledger.create_hold(
                f"H-{index}",
                "alice",
                100,
            )
            with lock:
                results.append(result)
        except LedgerError:
            with lock:
                results.append("rejected")

    threads = [
        threading.Thread(target=attempt_hold, args=(i,))
        for i in range(10)
    ]

    for thread in threads:
        thread.start()

    for thread in threads:
        thread.join()

    assert results.count("held") == 5
    assert results.count("rejected") == 5
    assert ledger.available_balance("alice") == 0