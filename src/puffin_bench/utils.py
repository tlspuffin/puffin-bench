from typing import Protocol


class ProcessResult(Protocol):
    is_success: bool

    def stdout(self) -> str: ...

    def stderr(self) -> str: ...
