cmake_minimum_required(VERSION 3.5.0)
project(restsrv)

set (CMAKE_CXX_STANDARD 17)

include(CMakeUtils.cmake)

include(CMakeLists.conf)

set(IN_VERSION_C "${CMAKE_CURRENT_SOURCE_DIR}/src/version.c.in")
set(GENERATED_VERSION_C "${CMAKE_CURRENT_BINARY_DIR}/version.c")
add_custom_target(generate_version ALL
    COMMAND ${CMAKE_COMMAND} -DINPUT=${IN_VERSION_C} -DOUTPUT=${GENERATED_VERSION_C} -P ${CMAKE_SOURCE_DIR}/CMakeGenVersion.cmake
    BYPRODUCTS ${GENERATED_VERSION_C}
    VERBATIM
)

add_executable(reserve_port src/reserve_port.c)

add_executable(reserve_port-static src/reserve_port.c)
target_link_options(reserve_port-static PRIVATE -static)

find_program(XXD xxd REQUIRED)

set(RESERVE_PORT_BLOB_H "reserve_port.h")
add_custom_command(
  OUTPUT ${RESERVE_PORT_BLOB_H}
  COMMAND ${CMAKE_COMMAND} -E env
          OUT=${RESERVE_PORT_BLOB_H}
          sh -c "${XXD} -i -n ReservePort_Binary \"$<TARGET_FILE:reserve_port>\" > \"${RESERVE_PORT_BLOB_H}\""
  DEPENDS reserve_port
  COMMENT "Generating ${RESERVE_PORT_BLOB_H} from reserve_port with xxd -i"
  VERBATIM
)
add_custom_target(reserve_port_blob_h DEPENDS ${RESERVE_PORT_BLOB_H})
set(RESERVE_PORT-STATIC_BLOB_H "reserve_port-static.h")
add_custom_command(
  OUTPUT ${RESERVE_PORT-STATIC_BLOB_H}
  COMMAND ${CMAKE_COMMAND} -E env
          OUT=${RESERVE_PORT-STATIC_BLOB_H}
          sh -c "${XXD} -i -n ReservePort_Binary \"$<TARGET_FILE:reserve_port-static>\" > \"${RESERVE_PORT-STATIC_BLOB_H}\""
  DEPENDS reserve_port-static
  COMMENT "Generating ${RESERVE_PORT-STATIC_BLOB_H} from reserve_port-static with xxd -i"
  VERBATIM
)
add_custom_target(reserve_port-static_blob_h DEPENDS ${RESERVE_PORT-STATIC_BLOB_H})

if(DEFINED OPENSSL_PATH)
  GetLibs(openssl STATIC ${OPENSSL_PATH}  "ssl;crypto" openssllibs VERBOSE)
  CreateExternalLib(openssl "${openssllibs}" DEPLOYTARGET setupDLL)
endif()

GetLibs(Poco STATIC ${POCO_PATH} "PocoNetSSL;PocoCrypto;PocoNet;PocoUtil;PocoFoundation;PocoJSON" Pocolibs VERBOSE)
CreateExternalLib(Poco "${Pocolibs}" DEPLOYTARGET setupDLL)
if(DEFINED OPENSSL_PATH)
  target_link_libraries(Poco INTERFACE openssl)
else()
  target_link_libraries(Poco INTERFACE ssl crypto)
endif()

if (DEFINED LIBARCHIVE_PATH)
    GetLibs(LibArchive STATIC ${LIBARCHIVE_PATH} "archive" LibArchiveInfos)
    CreateExternalLib(LibArchive "${LibArchiveInfos}" DEPLOYTARGET setupDLL)
    set(ZLIB_USE_STATIC_LIBS ON)
    find_package(ZLIB)
    target_link_libraries(LibArchive INTERFACE ZLIB::ZLIB)
    target_compile_definitions(LibArchive INTERFACE LIBARCHIVE_STATIC)
    add_library(LibArchive::LibArchive ALIAS LibArchive)
else()
    find_package(LibArchive)
endif()

EmbedTextFileScript("${CMAKE_SOURCE_DIR}/scripts/executor.sh" "${CMAKE_SOURCE_DIR}/src/embeded/scheduler/executor_sh.h" Executor_Script)
EmbedTextFileScript("${CMAKE_SOURCE_DIR}/scripts/functions.sh" "${CMAKE_SOURCE_DIR}/src/embeded/scheduler/functions_sh.h" Functions_Script)

EmbedTextFileScript("${CMAKE_SOURCE_DIR}/html/board/board.html" "${CMAKE_SOURCE_DIR}/src/embeded/html/board/board_html.h" Board_HTML)
EmbedTextFileScript("${CMAKE_SOURCE_DIR}/html/board/board.css" "${CMAKE_SOURCE_DIR}/src/embeded/html/board/board_css.h" Board_CSS)
EmbedTextFileScript("${CMAKE_SOURCE_DIR}/html/board/board.js" "${CMAKE_SOURCE_DIR}/src/embeded/html/board/board_js.h" Board_JS)
EmbedTextFileScript("${CMAKE_SOURCE_DIR}/html/board/joblauncher.css" "${CMAKE_SOURCE_DIR}/src/embeded/html/board/joblauncher_css.h" JobLauncher_CSS)
EmbedTextFileScript("${CMAKE_SOURCE_DIR}/html/board/joblauncher.js" "${CMAKE_SOURCE_DIR}/src/embeded/html/board/joblauncher_js.h" JobLauncher_JS)
EmbedTextFileScript("${CMAKE_SOURCE_DIR}/html/board/taskcard.css" "${CMAKE_SOURCE_DIR}/src/embeded/html/board/taskcard_css.h" TaskCard_CSS)
EmbedTextFileScript("${CMAKE_SOURCE_DIR}/html/board/taskcard.js" "${CMAKE_SOURCE_DIR}/src/embeded/html/board/taskcard_js.h" TaskCard_JS)
EmbedTextFileScript("${CMAKE_SOURCE_DIR}/html/board/terminal.js" "${CMAKE_SOURCE_DIR}/src/embeded/html/board/terminal_js.h" Terminal_JS)

set(SRV_SRC 
  src/scheduler/main.cxx src/scheduler/config.cxx 
  src/utils/logs.cxx src/utils/rapidjson.cxx src/utils/variables.cxx src/utils/file.cxx src/utils/md5_poco.cxx src/utils/file_tgz.cxx
  src/scheduler/server/config.cxx src/scheduler/server/server.cxx src/scheduler/server/parts_handler.cxx src/scheduler/server/request_handler.cxx 
  src/scheduler/schedule/config.cxx src/scheduler/schedule/schedule.cxx src/scheduler/schedule/task.cxx src/scheduler/schedule/step.cxx 
  src/scheduler/schedule/tasksmanager.cxx src/scheduler/schedule/step_configurations.cxx src/scheduler/schedule/publish.cxx
  src/scheduler/schedule/executor/config.cxx src/scheduler/schedule/executor/executor.cxx src/scheduler/schedule/executor/local.cxx 
  src/scheduler/schedule/executor/output_ring.cxx
  src/scheduler/system/linux_cores.cxx src/scheduler/system/linux_process.cxx src/scheduler/system/linux_memory.cxx 
  src/scheduler/system/linux.cxx
  src/scheduler/api/schedule_api.cxx src/scheduler/api/users_api.cxx
  src/scheduler/cache/config.cxx src/scheduler/cache/cache.cxx
  src/scheduler/schedule/monitor/monitor.cxx src/scheduler/schedule/monitor/task.cxx
  src/scheduler/schedule/archiver.cxx
  src/embeded/scheduler/executor_sh.h src/embeded/scheduler/functions_sh.h
  src/embeded/html/board/board_html.h src/embeded/html/board/board_css.h src/embeded/html/board/board_js.h
  src/embeded/html/board/joblauncher_css.h src/embeded/html/board/joblauncher_js.h
  src/embeded/html/board/taskcard_css.h src/embeded/html/board/taskcard_js.h src/embeded/html/board/terminal_js.h
  ${GENERATED_VERSION_C}
)

add_executable(srv ${SRV_SRC} ${RESERVE_PORT_BLOB_H})
target_link_libraries(srv PRIVATE Poco LibArchive::LibArchive)
target_include_directories(srv PRIVATE ${RAPIDJSON_PATH} ${CMAKE_CURRENT_BINARY_DIR})
add_dependencies(srv reserve_port_blob_h)

add_executable(srv-static ${SRV_SRC} ${RESERVE_PORT-STATIC_BLOB_H})
target_link_libraries(srv-static PRIVATE Poco LibArchive::LibArchive)
target_include_directories(srv-static PRIVATE ${RAPIDJSON_PATH} ${CMAKE_CURRENT_BINARY_DIR})
target_link_options(srv-static PRIVATE -static)
target_compile_definitions(srv-static PRIVATE STATIC)
add_dependencies(srv-static reserve_port-static_blob_h)

add_executable(testcpu src/cpu.cxx src/scheduler/system/linux_cores.cxx)

add_executable(testFilesRing src/test_files_ring.cxx src/scheduler/schedule/executor/output_ring.cxx src/utils/logs.cxx )
target_link_options(testFilesRing PRIVATE -static)
target_compile_definitions(testFilesRing PRIVATE STATIC)

EmbedTextFileScript("${CMAKE_SOURCE_DIR}/scripts/tlspuffin_history.sh" "${CMAKE_SOURCE_DIR}/src/embeded/git_restapi/tlspuffin_history_sh.h" TLSPuffinHistory_Script)

set(GIT_RESTAPI_SRC 
  src/git_restapi/main.cxx src/git_restapi/config.cxx 
  src/utils/logs.cxx src/utils/rapidjson.cxx src/utils/variables.cxx 
  src/git_restapi/api/api.cxx src/git_restapi/git/git_api.cxx src/git_restapi/git/config.cxx
  src/git_restapi/server/config.cxx src/git_restapi/server/server.cxx src/git_restapi/server/parts_handler.cxx src/git_restapi/server/request_handler.cxx 
  src/embeded/git_restapi/tlspuffin_history_sh.h
  ${GENERATED_VERSION_C}
)

add_executable(git_restapi ${GIT_RESTAPI_SRC})
target_link_libraries(git_restapi PRIVATE Poco)
target_include_directories(git_restapi PRIVATE ${RAPIDJSON_PATH} ${CMAKE_CURRENT_BINARY_DIR})

add_executable(git_restapi-static ${GIT_RESTAPI_SRC})
target_link_libraries(git_restapi-static PRIVATE Poco)
target_include_directories(git_restapi-static PRIVATE ${RAPIDJSON_PATH} ${CMAKE_CURRENT_BINARY_DIR})
target_link_options(git_restapi-static PRIVATE -static)
target_compile_definitions(git_restapi-static PRIVATE STATIC)
