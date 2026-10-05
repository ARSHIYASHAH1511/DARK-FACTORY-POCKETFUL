import threading

import pytest

from ledger_db import LedgerDB, LedgerError


def test_idempotent_retry(tmp_path):
    db = LedgerDB(tmp_path / "ledger.db")

    db.create_account("alice")
    db.create_account("bob")

    first = db.post("tx-001", "alice", "bob", 100)
    second = db.post("tx-001", "alice", "bob", 100)

    assert first == "applied"
    assert second == "already_applied"

    assert db.balance("alice") == -100
    assert db.balance("bob") == 100


def test_same_transaction_id_cannot_change_transaction(tmp_path):
    db = LedgerDB(tmp_path / "ledger.db")

    db.create_account("alice")
    db.create_account("bob")
    db.create_account("charlie")

    db.post("tx-001", "alice", "bob", 100)

    with pytest.raises(LedgerError):
        db.post("tx-001", "alice", "charlie", 500)

    assert db.balance("alice") == -100
    assert db.balance("bob") == 100
    assert db.balance("charlie") == 0


def test_concurrent_same_transaction_is_applied_once(tmp_path):
    db_path = tmp_path / "ledger.db"

    setup = LedgerDB(db_path)
    setup.create_account("alice")
    setup.create_account("bob")

    results = []
    errors = []
    lock = threading.Lock()

    def worker():
        try:
            db = LedgerDB(db_path)
            result = db.post("tx-concurrent", "alice", "bob", 100)

            with lock:
                results.append(result)

        except Exception as exc:
            with lock:
                errors.append(exc)

    threads = [
        threading.Thread(target=worker)
        for _ in range(20)
    ]

    for thread in threads:
        thread.start()

    for thread in threads:
        thread.join()

    assert not errors
    assert results.count("applied") == 1
    assert results.count("already_applied") == 19

    final_db = LedgerDB(db_path)

    assert final_db.balance("alice") == -100
    assert final_db.balance("bob") == 100