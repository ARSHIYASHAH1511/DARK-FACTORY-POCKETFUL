import pytest

from audit_ledger import AuditLedger, LedgerError


def test_post_creates_audit_event(tmp_path):
    db = AuditLedger(tmp_path / "audit.db")

    db.create_account("alice")
    db.create_account("bob")

    result = db.post("tx-001", "alice", "bob", 100)

    assert result == "applied"
    assert db.balance("alice") == -100
    assert db.balance("bob") == 100

    trail = db.audit_trail("tx-001")

    assert len(trail) == 1
    assert trail[0][0] == "POSTED"


def test_reversal_restores_original_balances(tmp_path):
    db = AuditLedger(tmp_path / "audit.db")

    db.create_account("alice")
    db.create_account("bob")

    db.post("tx-001", "alice", "bob", 100)

    reversal_id = db.reverse("tx-001")

    assert reversal_id == "REV-tx-001"
    assert db.balance("alice") == 0
    assert db.balance("bob") == 0


def test_original_transaction_is_preserved_after_reversal(tmp_path):
    db = AuditLedger(tmp_path / "audit.db")

    db.create_account("alice")
    db.create_account("bob")

    db.post("tx-001", "alice", "bob", 100)
    db.reverse("tx-001")

    trail = db.audit_trail("tx-001")
    reversal_trail = db.audit_trail("REV-tx-001")

    assert len(trail) == 1
    assert trail[0][0] == "POSTED"

    assert len(reversal_trail) == 1
    assert reversal_trail[0][0] == "REVERSAL"


def test_transaction_cannot_be_reversed_twice(tmp_path):
    db = AuditLedger(tmp_path / "audit.db")

    db.create_account("alice")
    db.create_account("bob")

    db.post("tx-001", "alice", "bob", 100)
    db.reverse("tx-001")

    with pytest.raises(LedgerError):
        db.reverse("tx-001")

    assert db.balance("alice") == 0
    assert db.balance("bob") == 0


def test_unknown_transaction_cannot_be_reversed(tmp_path):
    db = AuditLedger(tmp_path / "audit.db")

    db.create_account("alice")
    db.create_account("bob")

    with pytest.raises(LedgerError):
        db.reverse("does-not-exist")

    assert db.balance("alice") == 0
    assert db.balance("bob") == 0


def test_reversal_preserves_zero_sum(tmp_path):
    db = AuditLedger(tmp_path / "audit.db")

    db.create_account("alice")
    db.create_account("bob")

    db.post("tx-001", "alice", "bob", 250)
    db.reverse("tx-001")

    total = db.balance("alice") + db.balance("bob")

    assert total == 0