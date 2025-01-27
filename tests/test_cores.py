import os

from assertpy import assert_that

from puffin_bench.utils import Cores, get_cores


def test_number_of_busy_cores_matches_initial_dict_length() -> None:
    nb_busy_cores = 10
    max_cores = nb_busy_cores + 2
    cores = Cores(cores={str(i): os.getpid() for i in range(nb_busy_cores)}, max_cores=max_cores)

    assert_that(cores.busy()).is_length(nb_busy_cores)


def test_can_get_one_core_if_max_not_reached() -> None:
    nb_busy_cores = 10
    max_cores = nb_busy_cores + 2
    cores = Cores(cores={str(i): os.getpid() for i in range(nb_busy_cores)}, max_cores=max_cores)

    assert_that(cores.get(1)).is_not_none()


def test_reserved_cores_are_marked_busy() -> None:
    nb_busy_cores = 10
    max_cores = nb_busy_cores + 2
    cores = Cores(cores={str(i): os.getpid() for i in range(nb_busy_cores)}, max_cores=max_cores)

    reserved = cores.get(2)

    assert_that(cores.busy()).contains(*reserved)


def test_cannot_get_new_cores_once_max_number_of_cores_is_reached() -> None:
    nb_busy_cores = 0
    max_cores = 12
    cores = Cores(cores={str(i): os.getpid() for i in range(nb_busy_cores)}, max_cores=max_cores)

    for _ in range(max_cores):
        cores.get(1)

    assert_that(len(cores.busy())).is_equal_to(max_cores)
    assert_that(cores.get(1)).is_none()


def test_released_cores_are_not_busy() -> None:
    nb_busy_cores = 12
    max_cores = 12
    cores = Cores(cores={str(i): os.getpid() for i in range(nb_busy_cores)}, max_cores=max_cores)

    assert_that(len(cores.busy())).is_equal_to(max_cores)
    assert_that(len(cores.free())).is_equal_to(0)

    released_cores = ["1", "3", "4"]
    cores.release(released_cores)

    assert_that(len(cores.busy())).is_equal_to(max_cores - len(released_cores))
    assert_that(cores.free()).contains_only(*released_cores)


def test_get_cores() -> None:
    with get_cores(nb_cores=3) as cores:
        assert_that(len(cores)).is_greater_than_or_equal_to(3)
