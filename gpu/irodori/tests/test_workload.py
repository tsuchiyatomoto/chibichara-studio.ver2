from __future__ import annotations

import threading

from irodori_openai_tts.workload import WorkloadGate


def test_training_reservation_blocks_new_inference() -> None:
    gate = WorkloadGate()

    assert gate.try_enter_inference()
    gate.leave_inference()
    gate.reserve_training()

    assert not gate.try_enter_inference()
    assert gate.enter_reserved_training()
    assert gate.snapshot().training_active

    gate.leave_training()
    assert gate.try_enter_inference()
    gate.leave_inference()


def test_reserved_training_waits_for_active_inference() -> None:
    gate = WorkloadGate()
    entered = threading.Event()

    assert gate.try_enter_inference()
    gate.reserve_training()

    def enter_training() -> None:
        if gate.enter_reserved_training():
            entered.set()

    thread = threading.Thread(target=enter_training)
    thread.start()
    assert not entered.wait(timeout=0.05)

    gate.leave_inference()
    assert entered.wait(timeout=1)
    gate.leave_training()
    thread.join(timeout=1)


def test_reserved_training_can_be_cancelled_while_waiting() -> None:
    gate = WorkloadGate()
    cancelled = threading.Event()
    result: list[bool] = []

    assert gate.try_enter_inference()
    gate.reserve_training()

    def enter_training() -> None:
        result.append(gate.enter_reserved_training(cancelled))

    thread = threading.Thread(target=enter_training)
    thread.start()
    cancelled.set()
    thread.join(timeout=1)

    assert result == [False]
    gate.leave_inference()
    gate.cancel_training_reservation()
