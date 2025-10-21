cmake_minimum_required(VERSION 3.5.0)
project(restsrv)

set (CMAKE_CXX_STANDARD 17)

include(CMakeUtils.cmake)

include(CMakeLists.conf)

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

set(SRV_SRC 
  src/scheduler/main.cxx src/scheduler/config.cxx 
  src/scheduler/utils/rapidjson.cxx src/scheduler/utils/variables.cxx src/scheduler/utils/file.cxx 
  src/scheduler/server/config.cxx src/scheduler/server/server.cxx src/scheduler/server/parts_handler.cxx src/scheduler/server/request_handler.cxx 
  src/scheduler/schedule/config.cxx src/scheduler/schedule/schedule.cxx src/scheduler/schedule/task.cxx src/scheduler/schedule/step.cxx 
  src/scheduler/schedule/tasksmanager.cxx src/scheduler/schedule/step_configurations.cxx src/scheduler/schedule/publish.cxx
  src/scheduler/api/schedule_api.cxx
  src/scheduler/cache/config.cxx src/scheduler/cache/cache.cxx
)

add_executable(srv ${SRV_SRC} ${RESERVE_PORT_BLOB_H})
target_link_libraries(srv PRIVATE Poco)
target_include_directories(srv PRIVATE ${RAPIDJSON_PATH} ${CMAKE_CURRENT_BINARY_DIR})

add_executable(srv-static ${SRV_SRC} ${RESERVE_PORT-STATIC_BLOB_H})
target_link_libraries(srv-static PRIVATE Poco)
target_include_directories(srv-static PRIVATE ${RAPIDJSON_PATH} ${CMAKE_CURRENT_BINARY_DIR})
target_link_options(srv-static PRIVATE -static)
target_compile_definitions(srv-static PRIVATE STATIC)
