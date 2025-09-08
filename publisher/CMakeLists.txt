cmake_minimum_required(VERSION 3.5.0)
project(restsrv)

set (CMAKE_CXX_STANDARD 17)

include(CMakeUtils.cmake)

include(CMakeLists.conf)

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

EmbedTextFile("scripts/get_file.sh" 
  "${CMAKE_CURRENT_SOURCE_DIR}/src/scheduler/schedule/embeded/get_file_sh.h" GetFile_Script)
EmbedTextFile("scripts/executor.sh" 
  "${CMAKE_CURRENT_SOURCE_DIR}/src/scheduler/schedule/executor/embeded/executor_sh.h" Executor_Script)

set(SRV_SRC 
  src/scheduler/main.cxx src/scheduler/config.cxx 
  src/scheduler/utils/variables.cxx
  src/scheduler/server/config.cxx src/scheduler/server/server.cxx src/scheduler/server/parts_handler.cxx src/scheduler/server/request_handler.cxx 
  src/scheduler/schedule/config.cxx src/scheduler/schedule/schedule.cxx src/scheduler/schedule/task.cxx src/scheduler/schedule/step.cxx 
  src/scheduler/schedule/tasksmanager.cxx src/scheduler/schedule/step_configurations.cxx src/scheduler/schedule/publish.cxx
  src/scheduler/schedule/executor/config.cxx src/scheduler/schedule/executor/executor.cxx src/scheduler/schedule/executor/local.cxx 
  src/scheduler/schedule/executor/linux_cores.cxx
  src/scheduler/api/schedule_api.cxx
  src/scheduler/cache/config.cxx src/scheduler/cache/cache.cxx
)

add_executable(srv ${SRV_SRC} ${RESERVE_PORT_BLOB_H})
target_link_libraries(srv PRIVATE Poco)
target_include_directories(srv PRIVATE ${RAPIDJSON_PATH} ${CMAKE_CURRENT_BINARY_DIR})
add_dependencies(srv reserve_port_blob_h)

add_executable(srv-static ${SRV_SRC} ${RESERVE_PORT-STATIC_BLOB_H})
target_link_libraries(srv-static PRIVATE Poco)
target_include_directories(srv-static PRIVATE ${RAPIDJSON_PATH} ${CMAKE_CURRENT_BINARY_DIR})
target_link_options(srv-static PRIVATE -static)
target_compile_definitions(srv-static PRIVATE STATIC)
add_dependencies(srv-static reserve_port-static_blob_h)

add_executable(testcpu src/cpu.cxx src/scheduler/schedule/executor/linux_cores.cxx)

EmbedTextFile("${CMAKE_CURRENT_SOURCE_DIR}/src/publisher/publish/index.html" 
  "${CMAKE_CURRENT_SOURCE_DIR}/src/publisher/publish/embeded/index_html.h" Publisher_Index)
EmbedTextFile("${CMAKE_CURRENT_SOURCE_DIR}/src/publisher/publish/index.css" 
  "${CMAKE_CURRENT_SOURCE_DIR}/src/publisher/publish/embeded/index_css.h" Publisher_CSS)
EmbedTextFile("${CMAKE_CURRENT_SOURCE_DIR}/src/publisher/publish/index.js" 
  "${CMAKE_CURRENT_SOURCE_DIR}/src/publisher/publish/embeded/index_js.h" Publisher_JS)

set(PUBLISHER_SRC
  src/publisher/main.cxx src/publisher/config.cxx 
  src/publisher/server/config.cxx src/publisher/server/server.cxx 
  src/publisher/server/parts_handler.cxx src/publisher/server/request_handler.cxx 
  src/publisher/publish/config.cxx src/publisher/publish/publish.cxx
)

add_executable(publisher ${PUBLISHER_SRC})
target_link_libraries(publisher PRIVATE Poco)
target_include_directories(publisher PRIVATE ${RAPIDJSON_PATH})

add_executable(publisher-static ${PUBLISHER_SRC})
target_link_libraries(publisher-static PRIVATE Poco)
target_include_directories(publisher-static PRIVATE ${RAPIDJSON_PATH})
target_link_options(publisher-static PRIVATE -static)
