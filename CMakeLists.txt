
cmake_minimum_required(VERSION 3.5.0)
project(puffin-bench)

set(EXTERNAL_BUILD_J "4" CACHE STRING "Number of parallel process for building external projects")
add_subdirectory(scheduler)
add_subdirectory(git_restapi)
add_subdirectory(publisher)
add_subdirectory(vis_comparator)
add_subdirectory(installer)
