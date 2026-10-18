from __future__ import annotations

import threading
from dataclasses import dataclass


class TrainingAlreadyReservedError(RuntimeError):
    pass


@dataclass(frozen=True)
class WorkloadState:
    active_inferences: int
    training_reserved: bool
    training_active: bool


class WorkloadGate:
    """Coordinate inference and the single GPU-exclusive training job."""

    def __init__(self) -> None:
        self._condition = threading.Condition()
        self._active_inferences = 0
        self._training_reserved = False
        self._training_active = False

    def try_enter_inference(self) -> bool:
        with self._condition:
            if self._training_reserved:
                return False
            self._active_inferences += 1
            return True

    def leave_inference(self) -> None:
        with self._condition:
            if self._active_inferences <= 0:
                raise RuntimeError("No inference workload is active.")
            self._active_inferences -= 1
            if self._active_inferences == 0:
                self._condition.notify_all()

    def reserve_training(self) -> None:
        with self._condition:
            if self._training_reserved:
                raise TrainingAlreadyReservedError(
                    "Another Speaker Inversion job is already active."
                )
            self._training_reserved = True
            self._condition.notify_all()

    def enter_reserved_training(self, cancel_event: threading.Event | None = None) -> bool:
        with self._condition:
            if not self._training_reserved:
                raise RuntimeError("Training was not reserved.")
            while self._active_inferences > 0:
                if cancel_event is not None and cancel_event.is_set():
                    return False
                self._condition.wait(timeout=0.25)
            if cancel_event is not None and cancel_event.is_set():
                return False
            self._training_active = True
            return True

    def leave_training(self) -> None:
        with self._condition:
            self._training_active = False
            self._training_reserved = False
            self._condition.notify_all()

    def cancel_training_reservation(self) -> None:
        with self._condition:
            if self._training_active:
                raise RuntimeError("Cannot cancel a reservation after training has started.")
            self._training_reserved = False
            self._condition.notify_all()

    def snapshot(self) -> WorkloadState:
        with self._condition:
            return WorkloadState(
                active_inferences=self._active_inferences,
                training_reserved=self._training_reserved,
                training_active=self._training_active,
            )
